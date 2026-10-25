/**
 * scripts/sim-download.mjs — 离线验证下载器（不联网）。
 *
 * 起一个本地 http server 当镜像，用它分别扮演三种真实行为，验证下载器的四条路径：
 *   1. 支持 206 分片 → 四连接并发各写 .partN，合并后 sha256 对得上
 *   2. 只给 200（不支持 Range）→ 退成单连接流式，结果一样对
 *   3. 中途断开 → 已下的 .part 保留，重跑能续传补齐
 *   4. sha256 不符 → 不落盘成正式名，临时文件清掉
 * 外加：探测对"206 但缺 content-range"的处理、以及已下完的文件不重下。
 *
 * 全部在临时目录里跑，跑完自清。不联网、不起宿主。
 *
 * 用法：
 *   node scripts/sim-download.mjs
 *   node scripts/sim-download.mjs --keep     # 保留临时文件便于排查
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { probeRange, runTask, planSegments } from "../runtime/downloader.mjs";

const KEEP = process.argv.slice(2).includes("--keep");

/**
 * 找一块可写的地方放临时文件。
 *
 * os.tmpdir() 在 TMP/TEMP 都没设时会返回 "undefined\temp" 这种不存在的路径，
 * 直接 mkdtemp 会 ENOENT。所以按序试几个候选，第一个建得起来的就是它。
 * 也可用 --dir <路径> 显式指定。
 */
function pickWorkRoot() {
  const explicit = argOf("--dir");
  const candidates = [
    explicit,
    os.tmpdir(),
    process.env.TMP,
    process.env.TEMP,
    process.env.TMPDIR,
    path.join(process.cwd(), ".tmp"),
  ].filter((p) => typeof p === "string" && p && !p.startsWith("undefined"));

  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      const probe = mkdtempSync(path.join(candidate, "oh-releases-sim-download-"));
      return probe;
    } catch {
      // 换下一个候选。
    }
  }
  console.error("[sim] 找不到可写的临时目录；用 --dir <路径> 指定一个。");
  process.exit(2);
}

function argOf(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return null;
}

// ---------------------------------------------------------------- 夹具

/** 造一段确定性的可校验内容（不依赖随机数，失败可复现）。 */
function makeBody(size) {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 1) buf[i] = (i * 31 + 7) % 256;
  return buf;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const results = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  results.push({ label, ok, actual, expected });
  console.log((ok ? "    ✓ " : "    ✗ ") + label + " = " + String(actual) + (ok ? "" : "（期望 " + String(expected) + "）"));
  return ok;
}

// ---------------------------------------------------------------- 本地镜像

/**
 * 起一个能扮演多种行为的镜像。
 *
 * mode:
 *   range      支持 206，按请求的区间返回
 *   no-range   一律 200 全量（模拟 gh-proxy.com 对大文件的行为）
 *   no-cr      返回 206 但不给 content-range（探测该判为不支持）
 *   abort      分片请求第一次只发一半就断开（模拟中途断线）
 */
function startMirror({ body, mode = "range", abortOnce = false }) {
  const state = { aborted: false, requests: [] };

  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    state.requests.push({ range: range ?? null, url: req.url });

    if (mode === "no-range") {
      res.writeHead(200, { "content-length": body.length });
      res.end(body);
      return;
    }

    if (!range) {
      res.writeHead(200, { "content-length": body.length });
      res.end(body);
      return;
    }

    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (!m) {
      res.writeHead(416);
      res.end();
      return;
    }
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    const slice = body.subarray(start, end + 1);

    const headers = { "content-length": slice.length };
    if (mode !== "no-cr") headers["content-range"] = "bytes " + start + "-" + end + "/" + body.length;
    res.writeHead(206, headers);

    // abort 模式：第一次非探测的分片请求只写一半就断开。
    if (mode === "abort" && abortOnce && !state.aborted && slice.length > 1024) {
      state.aborted = true;
      res.write(slice.subarray(0, Math.floor(slice.length / 2)));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(slice);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: "http://127.0.0.1:" + port + "/asset.bin",
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const workRoot = pickWorkRoot();

  const SIZE = 256 * 1024; // 256 KiB：够切成 4 片，又不至于让测试变慢
  const BODY = makeBody(SIZE);
  const SHA = sha256(BODY);

  console.log("[sim] 内容 " + SIZE + " 字节，sha256 " + SHA.slice(0, 16) + "…");
  console.log("[sim] 工作目录 " + workRoot);
  console.log("");

  const collect = () => {
    const records = [];
    return { records, sink: (r) => records.push(r) };
  };

  // ── 1. 分片下载 ─────────────────────────────────────────────────
  console.log("=== 1. 支持 Range → 四连接分片 ===");
  {
    const mirror = await startMirror({ body: BODY, mode: "range" });
    const dest = path.join(workRoot, "a", "out.bin");
    const { records, sink } = collect();
    const result = await runTask(
      { url: mirror.url, destination: dest, expectedSha256: SHA, totalBytes: SIZE, connections: 4 },
      sink,
    );

    check("下载成功", result.ok, true);
    check("模式", result.mode, "parallel");
    check("字节数", result.bytes, SIZE);
    check("sha256 一致", result.sha256, SHA);
    check("文件存在", existsSync(dest), true);
    check("落盘内容与源一致", sha256(readFileSync(dest)), SHA);
    check("探测记录了一条", records.some((r) => r.type === "probe"), true);
    check("有进度记录", records.some((r) => r.type === "progress"), true);
    check("有 done 记录", records.some((r) => r.type === "done"), true);
    check(".part 已清理", readdirSync(path.dirname(dest)).filter((f) => f.includes(".part")).length, 0);

    // 分片边界必须完整覆盖、无重叠（这是合并正确的前提）
    const segs = planSegments(SIZE, 4);
    check("分片数", segs.length, 4);
    check("分片覆盖总长", segs.reduce((a, s) => a + s.length, 0), SIZE);
    check("分片首尾相接", segs.every((s, i) => i === 0 || s.start === segs[i - 1].end + 1), true);

    await mirror.close();
  }
  console.log("");

  // ── 2. 不支持 Range → 单连接 ────────────────────────────────────
  console.log("=== 2. 只给 200（不支持 Range）→ 退成单连接 ===");
  {
    const mirror = await startMirror({ body: BODY, mode: "no-range" });
    const dest = path.join(workRoot, "b", "out.bin");
    const { sink } = collect();
    const result = await runTask({ url: mirror.url, destination: dest, expectedSha256: SHA }, sink);

    check("下载成功", result.ok, true);
    check("模式", result.mode, "single");
    check("字节数", result.bytes, SIZE);
    check("sha256 一致", result.sha256, SHA);
    check("落盘内容与源一致", sha256(readFileSync(dest)), SHA);
    await mirror.close();
  }
  console.log("");

  // ── 3. 206 但缺 content-range → 按不支持处理 ────────────────────
  console.log("=== 3. 206 但没有 content-range → 判为不支持分片 ===");
  {
    const mirror = await startMirror({ body: BODY, mode: "no-cr" });
    const probe = await probeRange(mirror.url, { timeoutMs: 5000 });
    check("range 判定", probe.range, false);
    check("状态码", probe.status, 206);
    await mirror.close();
  }
  console.log("");

  // ── 4. 中途断开 → 续传 ─────────────────────────────────────────
  console.log("=== 4. 中途断开 → 已下的 .part 保留，重跑续传 ===");
  {
    const mirror = await startMirror({ body: BODY, mode: "abort", abortOnce: true });
    const dest = path.join(workRoot, "c", "out.bin");
    const { sink } = collect();

    const first = await runTask(
      { url: mirror.url, destination: dest, expectedSha256: SHA, totalBytes: SIZE, maxRetries: 0 },
      sink,
    );
    check("首次失败", first.ok, false);
    check("正式文件未生成", existsSync(dest), false);
    // 单文件分片：数据在 .part，各段已写字节在 .part.json。两个都在才能续传。
    check("留下 .part", existsSync(dest + ".part"), true);
    check("留下 .part.json 控制文件", existsSync(dest + ".part.json"), true);
    const control = JSON.parse(readFileSync(dest + ".part.json", "utf8"));
    check("控制文件记录了分片进度", Array.isArray(control.segments) && control.segments.length > 0, true);
    check(
      "已有非零字节",
      control.segments.some((s) => Number(s.written) > 0),
      true,
    );

    // 第二次：不再断，应当补齐。
    const again = await runTask(
      { url: mirror.url, destination: dest, expectedSha256: SHA, totalBytes: SIZE },
      () => {},
    );
    check("续传成功", again.ok, true);
    check("sha256 一致", again.sha256, SHA);
    check("落盘内容与源一致", sha256(readFileSync(dest)), SHA);
    await mirror.close();
  }
  console.log("");

  // ── 5. sha256 不符 → 不落盘 ────────────────────────────────────
  console.log("=== 5. sha256 不符 → 不落盘成正式名 ===");
  {
    const mirror = await startMirror({ body: BODY, mode: "range" });
    const dest = path.join(workRoot, "d", "out.bin");
    const WRONG = "0".repeat(64);
    const { records, sink } = collect();
    const result = await runTask({ url: mirror.url, destination: dest, expectedSha256: WRONG }, sink);

    check("下载失败", result.ok, false);
    check("错误码", result.code, "SHA256_MISMATCH");
    check("正式文件未生成", existsSync(dest), false);
    const leftovers = readdirSync(path.dirname(dest));
    check("临时文件已清理", leftovers.filter((f) => f.includes(".part")).length, 0);
    check("发出了 error 记录", records.some((r) => r.type === "error"), true);
    await mirror.close();
  }
  console.log("");

  // ── 6. 已下完不重下 ─────────────────────────────────────────────
  console.log("=== 6. 已完成且校验通过 → 不重下 ===");
  {
    const mirror = await startMirror({ body: BODY, mode: "range" });
    const dest = path.join(workRoot, "e", "out.bin");
    const first = await runTask({ url: mirror.url, destination: dest, expectedSha256: SHA }, () => {});
    check("首次成功", first.ok, true);

    const before = mirror.state.requests.length;
    const second = await runTask({ url: mirror.url, destination: dest, expectedSha256: SHA }, () => {});
    check("第二次成功", second.ok, true);
    check("模式", second.mode, "already-complete");
    check("没有新请求", mirror.state.requests.length, before);
    await mirror.close();
  }
  console.log("");

  // ── 7. 不可达主机 ───────────────────────────────────────────────
  console.log("=== 7. 主机不可达 → 结构化失败，不崩 ===");
  {
    const dest = path.join(workRoot, "f", "out.bin");
    const result = await runTask(
      { url: "http://127.0.0.1:1/nope", destination: dest, expectedSha256: SHA, timeoutMs: 1500 },
      () => {},
    );
    check("失败但不抛", result.ok, false);
    check("有错误消息", typeof result.error === "string" && result.error.length > 0, true);
    check("正式文件未生成", existsSync(dest), false);
  }
  console.log("");

  // ── 汇总 ────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log("=== 汇总 ===");
  console.log("    断言 " + results.length + " 条，通过 " + (results.length - failed.length) + "，失败 " + failed.length);
  if (failed.length) {
    for (const f of failed) console.log("    ✗ " + f.label + "：实际 " + String(f.actual) + "，期望 " + String(f.expected));
    process.exitCode = 1;
  } else {
    console.log("    全部通过。");
  }

  if (KEEP) console.log("    临时目录保留：" + workRoot);
  else rmSync(workRoot, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  console.error("[sim] 未捕获错误：" + (error?.stack ?? error));
  process.exitCode = 1;
}
