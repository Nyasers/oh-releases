/**
 * scripts/sim-backfill.mjs — 离线验证回填状态机（不联网、不起宿主）。
 *
 * 用 .tmp 下的实测夹具在真实 SQLite 上跑八个场景，断言"步数 / 网络请求数 / 入库数"。
 * 夹具不完整的地方由本脚本合成，合成规则写在下面，合成出来的东西只服务于状态机。
 *
 * 夹具来源（--fixtures，默认 H:\workspace\.tmp\ohrelease）：
 *   rel_cache.json      GitHub releases API 的整份缓存（409 条，其中 50 条带 digest）
 *   digest-*.json       真实 digest 原文（只有 7 份）
 *   release-digest.v1.json  v1.1.7-beta 的原文
 *
 * 合成规则：
 *   · 带 digest 的 50 个 tag 按 releases 顺序排成一条链，previousTag 指向下一个；
 *     最后一条 v0.357.8 的 previousTag 置 null（实测冷启动就是 50 步，链到这里为止）。
 *   · 本地有真原文的 tag 用真原文（顺带验证 upsertVersion 的哈希校验路径）。
 *   · tags 页按全量 tag 序列（含 train-*）切页，30 条一页，游标 ?after=<每页最后一条>，
 *     用来喂断口接续。
 *   · 场景 8 另有一份"含无 Release 版本 tag"的 tags 页：在 v0.416.26 之后插入真实
 *     存在的 4 个只打 tag 没发 Release 的版本，并把 v0.416.26 的 previousTag 改成
 *     v0.416.12。这是真实断口的形状，其余场景不用它。
 *
 * 八个场景（1–4 是 HANDOFF 点名的那四个，5–8 是补测）：
 *   1. 冷启动全量      50 步 / 50 次 digest 请求 / 入库 50
 *   2. 崩溃后续跑      崩在第 5 步，续跑共 50 步 / 只有 45 次 digest 请求 / 结果与场景 1 相同
 *   3. 已完成再跑      1 步 / 0 次请求 / 库里仍是 50
 *   4. 新版本到来      1 步 / 1 次请求 / 入库 51
 *   5. 断口接续        链中间一版变成 404，验证记 absent 并沿 tags 页接上、继续补完
 *   6. 断口跨重启      崩在断口之后，续跑要能穿过已探过的断口，不重取、不截断
 *   7. 网络错误可续跑  中途抛网络错误，state 保持 0，库里的行都在，续跑只补缺的
 *   8. 真实断口        按真实数据重建 v0.416.26 -> v0.416.12 这个断口（v0.416.12
 *                      只打了 git tag、没发 Release，取 digest 必 404），验证接续
 *                      连穿 4 个无 Release 的版本 tag，最终仍入库 50 条
 *
 * 注意：rel_cache 是 releases API 的缓存，只含"发过 Release 的 tag"。真实的断口
 * 成因是 previousTag 指向一个只打了 git tag、没发 Release 的版本——那种 tag 不在
 * rel_cache 里，只在 tags 页里。所以：
 *   · 5/6 场景用 overrides 把某个已有 tag 伪造成 404（合成的断口，验证路径）；
 *   · 8 场景用真实数据重建（真实断口，验证"连穿多个无 Release 的版本 tag"）。
 *
 * 场景 8 用的真实事实（HANDOFF「已知的实测事实」+ 蓝图 v4 两处独立记载）：
 *   v0.416.26 的 previousTag = v0.416.12，而 v0.416.12 / v0.416.4 / v0.416.3 /
 *   v0.415.16 这四个都只打了 git tag、没发 Release。它们都不在 rel_cache 里
 *   （本脚本会断言这一点）。所以断口不是"跳过 1 个"，而是"连穿 4 个"。
 *
 * 用法：
 *   node scripts/sim-backfill.mjs
 *   node scripts/sim-backfill.mjs --fixtures D:\path\to\fixtures --verbose
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chainClosed, runBackfill } from "../src/lib/backfill.js";
import { openStore } from "../src/lib/store.js";

const DIGEST_ASSET = "release-digest.v1.json";

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return fallback;
}
const hasFlag = (name) => process.argv.slice(2).includes(name);
const verbose = hasFlag("--verbose");

const FIXTURES = path.resolve(
  arg("--fixtures", process.env.OH_RELEASES_FIXTURES || path.join("H:", "workspace", ".tmp", "ohrelease")),
);

if (!existsSync(path.join(FIXTURES, "rel_cache.json"))) {
  console.error("[sim] 找不到夹具：" + path.join(FIXTURES, "rel_cache.json"));
  console.error("[sim] 用 --fixtures <目录> 指定，或设置 OH_RELEASES_FIXTURES。");
  process.exit(2);
}

// ---------------------------------------------------------------- 夹具

const releases = JSON.parse(readFileSync(path.join(FIXTURES, "rel_cache.json"), "utf8"));
const allTags = releases.map((r) => r.tag_name);

/** 带 digest 的 tag，按 releases 顺序（新 → 旧）。 */
const digestTags = releases
  .filter((r) => (r.assets || []).some((a) => a.name === DIGEST_ASSET))
  .map((r) => r.tag_name);

/** 本地真原文。 */
const realDigests = new Map();
for (const name of readdirSync(FIXTURES)) {
  if (!name.startsWith("digest-") && name !== DIGEST_ASSET) continue;
  try {
    const parsed = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
    if (parsed && typeof parsed.tag === "string") realDigests.set(parsed.tag, parsed);
  } catch {
    // 夹具里混着别的文件也不该让脚本挂掉。
  }
}

/** 每个 tag 的上一版：链条按 releases 顺序接，最后一条置 null。 */
const prevOf = new Map();
digestTags.forEach((tag, i) => {
  prevOf.set(tag, i + 1 < digestTags.length ? digestTags[i + 1] : null);
});

/** 取某个 tag 的 digest 原文；合成出来的保持与真实同形（tag / previousTag / items）。 */
function digestText(tag) {
  const real = realDigests.get(tag);
  if (real) return JSON.stringify(real, null, 2);
  return JSON.stringify(
    {
      schemaVersion: 1,
      tag,
      version: tag.replace(/^v/, ""),
      previousTag: prevOf.get(tag) ?? null,
      generatedAt: null,
      noUserFacingChanges: false,
      summary: { zh: "合成的测试摘要：" + tag, en: "Synthetic fixture summary for " + tag },
      counts: { feature: 0, fix: 0, improvement: 0, migration: 0 },
      source: { owner: "liliMozi", repo: "openhanako" },
      items: [],
      __synthetic: true,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------- 假客户端

/**
 * makeClient(fetchImpl) 的替身：接口与 upstream.js 的 client 逐字同形，只把网络
 * 换成夹具查表。overrides 用来在单个 tag 上伪造 404 / 500 / 抛错。
 */
function makeFakeClient({ overrides = new Map(), pageSize = 30 } = {}) {
  const counters = { digest: 0, tags: 0 };

  const client = {
    async fetchDigestText(tag) {
      counters.digest += 1;
      const override = overrides.get(tag);
      if (override === "throw") throw Object.assign(new Error("模拟网络错误：" + tag), { code: "ETIMEDOUT" });
      if (override === 404) return { ok: false, status: 404, error: "HTTP 404" };
      if (override === 500) return { ok: false, status: 500, error: "HTTP 500" };
      if (!prevOf.has(tag)) return { ok: false, status: 404, error: "HTTP 404" };
      return {
        ok: true,
        status: 200,
        text: digestText(tag),
        etag: null,
      };
    },

    async fetchTagsPage(after) {
      counters.tags += 1;
      const start = after ? allTags.indexOf(after) + 1 : 0;
      if (start < 0) return { ok: false, status: 404, error: "未知游标 " + after };
      const slice = allTags.slice(start, start + pageSize);
      const hasMore = start + pageSize < allTags.length;
      return {
        ok: true,
        status: 200,
        tags: slice,
        after: hasMore && slice.length ? slice[slice.length - 1] : null,
      };
    },

    async fetchAtom() {
      return { ok: false, status: 500, error: "sim 不使用 atom" };
    },

    async fetchExpandedAssets(tag) {
      return { ok: true, status: 200, assets: [], hasDigest: prevOf.has(tag) };
    },

    counters,
  };
  return client;
}

// ---------------------------------------------------------------- 断言

const results = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  results.push({ label, ok, actual, expected });
  console.log(
    (ok ? "    ✓ " : "    ✗ ") +
      label +
      " = " +
      String(actual) +
      (ok ? "" : "（期望 " + String(expected) + "）"),
  );
  return ok;
}

function freshDataDir(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oh-releases-sim-" + label + "-"));
  return dir;
}

const cleanup = [];
function open(dataDir) {
  const store = openStore(dataDir);
  cleanup.push(store);
  return store;
}

// ---------------------------------------------------------------- 场景

async function main() {
  console.log("[sim] 夹具目录：" + FIXTURES);
  console.log("[sim] releases " + releases.length + " 条，其中带 digest " + digestTags.length + " 条");
  console.log("[sim] 本地真 digest 原文 " + realDigests.size + " 份，其余 " + (digestTags.length - realDigests.size) + " 份为合成");
  if (digestTags.length !== 50) {
    console.log("[sim] 警告：带 digest 的 tag 是 " + digestTags.length + " 条，与实测的 50 不符，下面的期望值按实际条数算。");
  }
  const N = digestTags.length;
  const head = digestTags[0];
  console.log("[sim] 链头 " + head + "，链尾 " + digestTags[digestTags.length - 1]);
  console.log("");

  // ── 场景 1：冷启动全量 ───────────────────────────────────────────
  console.log("=== 场景 1：冷启动全量 ===");
  {
    const dir = freshDataDir("cold");
    const store = open(dir);
    const client = makeFakeClient();
    const progress = [];
    const stats = await runBackfill({
      store,
      client,
      startTag: head,
      onProgress: (p) => {
        progress.push(p);
        if (verbose) {
          console.log(
            "      [" + String(p.step).padStart(2) + "] " + String(p.tag ?? "-").padEnd(16) +
              p.action + (p.previousTag ? " → " + p.previousTag : ""),
          );
        }
      },
    });
    console.log("    返回：" + JSON.stringify({
      steps: stats.steps,
      stored: stats.stored,
      cached: stats.cached,
      absent: stats.absent,
      digestFetches: stats.digestFetches,
      tagPageFetches: stats.tagPageFetches,
      closed: stats.closed,
    }));
    check("步数", stats.steps, N);
    check("digest 请求", stats.digestFetches, N);
    check("入库", store.countVersions(), N);
    check("backfill_state", store.getBackfillState(), 1);
    check("链闭合", chainClosed(store, head), true);
    check("进度回调条数 > 0", progress.length > 0, true);
    const verify = store.verifyAll();
    check("离线哈希复核通过", verify.ok, true);
    check("复核条数", verify.checked, N);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("");

  // ── 场景 2：崩溃后续跑 ───────────────────────────────────────────
  console.log("=== 场景 2：崩溃后续跑 ===");
  {
    const dir = freshDataDir("resume");
    const store = open(dir);

    // 崩在第 5 步：stored 到 5 就 abort。abortCheck 在循环顶部，所以第 6 轮当场抛。
    const controller = new AbortController();
    const clientA = makeFakeClient();
    let crashed = false;
    try {
      await runBackfill({
        store,
        client: clientA,
        startTag: head,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.action === "stored" && p.stored >= 5) controller.abort();
        },
      });
    } catch (error) {
      crashed = error?.code === "BACKFILL_ABORTED" || error?.name === "AbortError";
    }
    check("崩溃发生在第 5 步之后", crashed, true);
    const afterCrash = store.countVersions();
    check("崩溃时入库", afterCrash, 5);
    check("崩溃后 backfill_state", store.getBackfillState(), 0);
    check("崩溃后链未闭合", chainClosed(store, head), false);

    const clientB = makeFakeClient();
    const stats = await runBackfill({ store, client: clientB, startTag: head });
    console.log("    续跑返回：" + JSON.stringify({
      steps: stats.steps,
      stored: stats.stored,
      cached: stats.cached,
      digestFetches: stats.digestFetches,
      tagPageFetches: stats.tagPageFetches,
    }));
    check("续跑步数", stats.steps, N);
    check("续跑 digest 请求", stats.digestFetches, N - 5);
    check("续跑穿缓存条数", stats.cached, 5);
    check("续跑后入库", store.countVersions(), N);
    check("续跑后 backfill_state", store.getBackfillState(), 1);
    check("续跑后链闭合", chainClosed(store, head), true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("");

  // ── 场景 3：已完成再跑一次 ───────────────────────────────────────
  console.log("=== 场景 3：已完成再跑一次（幂等） ===");
  {
    const dir = freshDataDir("idem");
    const store = open(dir);
    await runBackfill({ store, client: makeFakeClient(), startTag: head });
    const before = store.countVersions();

    const client = makeFakeClient();
    const stats = await runBackfill({ store, client, startTag: head });
    check("步数", stats.steps, 1);
    check("digest 请求", stats.digestFetches, 0);
    check("tags 请求", stats.tagPageFetches, 0);
    check("库里条数不变", store.countVersions(), before);
    check("backfill_state", store.getBackfillState(), 1);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("");

  // ── 场景 4：新版本到来 ───────────────────────────────────────────
  console.log("=== 场景 4：新版本到来 ===");
  {
    const dir = freshDataDir("newver");
    const store = open(dir);
    await runBackfill({ store, client: makeFakeClient(), startTag: head });
    const before = store.countVersions();

    // 新版本：把 v9.9.9-beta 接到链头，并让它自己也带 digest。
    const NEW_TAG = "v9.9.9-beta";
    prevOf.set(NEW_TAG, head);
    allTags.unshift(NEW_TAG);

    const client = makeFakeClient();
    const stats = await runBackfill({ store, client, startTag: NEW_TAG });
    check("步数", stats.steps, 1);
    check("digest 请求", stats.digestFetches, 1);
    check("tags 请求", stats.tagPageFetches, 0);
    check("入库 = 旧量 + 1", store.countVersions(), before + 1);
    check("新版本在库里", store.hasVersion(NEW_TAG), true);
    check("链闭合", chainClosed(store, NEW_TAG), true);

    // 新版本应当排在列表最前，分页按链序降序。
    const page = store.listVersions({ limit: 3, offset: 0 });
    check("列表首条是新版本", page.items[0]?.tag, NEW_TAG);
    check("列表第二条是原链头", page.items[1]?.tag, head);
    check("列表总数", page.total, before + 1);
    const page2 = store.listVersions({ limit: 3, offset: 1 });
    check("offset=1 的首条是原链头", page2.items[0]?.tag, head);
    check("分页 limit 回声", page2.limit, 3);
    check("分页 offset 回声", page2.offset, 1);

    prevOf.delete(NEW_TAG);
    allTags.shift();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("");

  // ── 场景 5：断口接续（404 → tags 页） ────────────────────────────
  console.log("=== 场景 5：断口接续（中间一版 404，沿 tags 页接上） ===");
  {
    const dir = freshDataDir("hole");
    const store = open(dir);

    // 让链上第 3 条返回 404：它有 previousTag，但我们假装没有 Release。
    const hole = digestTags[2];
    const overrides = new Map([[hole, 404]]);
    const client = makeFakeClient({ overrides });
    const stats = await runBackfill({ store, client, startTag: head });

    check("断口被记进 absent", store.isAbsent(hole), true);
    check("断口被记了接续", store.getHoleContinuations()[hole], prevOf.get(hole));
    // 断口这一版本身没入库（它没有 digest），其余全都入库。
    check("断口之后的版本仍在入库", store.countVersions(), N - 1);
    check("本次发出了 tags 翻页", stats.tagPageFetches > 0, true);
    check("链闭合", chainClosed(store, head), true);
    check("backfill_state", store.getBackfillState(), 1);

    // 断口之后的链必须还在：库里应当有 hole 的下一个版本。
    const afterHole = prevOf.get(hole);
    check("断口下一版在库里", store.hasVersion(afterHole), true);
    check("最老的版本也在库里", store.hasVersion(digestTags[N - 1]), true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("");

  // ── 场景 6：断口接续跨重启 ───────────────────────────────────────
  console.log("=== 场景 6：断口接续跨重启（续跑要能穿过已探过的断口） ===");
  {
    const dir = freshDataDir("hole-resume");
    const store = open(dir);
    const hole = digestTags[2];

    // 第一次：断口 404，走到第 8 条就崩。此时断口的接续已经落库。
    const controller = new AbortController();
    try {
      await runBackfill({
        store,
        client: makeFakeClient({ overrides: new Map([[hole, 404]]) }),
        startTag: head,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.action === "stored" && p.stored >= 8) controller.abort();
        },
      });
    } catch {
      // 预期崩掉。
    }
    check("断口的接续已落库", store.getHoleContinuations()[hole], prevOf.get(hole));
    check("崩溃后链未闭合", chainClosed(store, head), false);

    // 续跑：这次断口返回正常 404（本该没有 digest），必须能穿过去补完。
    const stats = await runBackfill({
      store,
      client: makeFakeClient({ overrides: new Map([[hole, 404]]) }),
      startTag: head,
    });
    check("续跑完成", stats.closed, true);
    check("续跑穿过断口未重取", stats.digestFetches, N - 8 - 1);
    check("续跑后入库", store.countVersions(), N - 1);
    check("链闭合", chainClosed(store, head), true);
    check("最老的版本在库里", store.hasVersion(digestTags[N - 1]), true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("");

  // ── 场景 7：网络错误可续跑 ───────────────────────────────────────
  console.log("=== 场景 7：网络错误保留 state=0 并可续跑 ===");
  {
    const dir = freshDataDir("neterr");
    const store = open(dir);
    const bad = digestTags[2];
    let threw = null;
    try {
      await runBackfill({
        store,
        client: makeFakeClient({ overrides: new Map([[bad, "throw"]]) }),
        startTag: head,
      });
    } catch (error) {
      threw = error;
    }
    check("抛出了错误", threw !== null, true);
    check("错误来自网络层", threw?.code === "ETIMEDOUT", true);
    check("网络错误后 backfill_state", store.getBackfillState(), 0);
    check("已取的版本都在", store.countVersions(), 2);
    check("链未闭合", chainClosed(store, head), false);

    const stats = await runBackfill({ store, client: makeFakeClient(), startTag: head });
    check("续跑完成", stats.closed, true);
    check("续跑后入库", store.countVersions(), N);
    check("续跑只补缺的", stats.stored, N - 2);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("");

  // ── 场景 8：真实断口（v0.416.26 -> v0.416.12） ───────────────────
  console.log("=== 场景 8：真实断口（v0.416.26 的 previousTag 指向只打 tag 没发 Release 的版本） ===");
  {
    // 真实事实：这 4 个 tag 只打了 git tag、没发 Release，所以取 digest 必 404。
    const NO_RELEASE = ["v0.416.12", "v0.416.4", "v0.416.3", "v0.415.16"];
    const holeFrom = "v0.416.26";

    // 先确认夹具与真实事实一致：这 4 个不该出现在 releases 缓存里。
    const inCache = NO_RELEASE.filter((t) => allTags.includes(t));
    check("这 4 个 tag 不在 releases 缓存里（确认它们没发 Release）", inCache.length, 0);
    check("断口起点在 digest 链上", digestTags.includes(holeFrom), true);

    // 真实断口真的存在吗：v0.416.26 之后第一个带 digest 的是谁？
    const idx = digestTags.indexOf(holeFrom);
    const nextWithDigest = idx >= 0 && idx + 1 < digestTags.length ? digestTags[idx + 1] : null;
    check("断口之后的下一个 digest 版本", nextWithDigest, "v0.412.7");

    // 按真实形状重建：v0.416.26 接向 v0.416.12，tags 页里在 v0.416.26 之后插进这 4 个。
    const savedPrev = prevOf.get(holeFrom);
    prevOf.set(holeFrom, NO_RELEASE[0]);
    const tagsWithHoles = [];
    for (const t of allTags) {
      tagsWithHoles.push(t);
      if (t === holeFrom) tagsWithHoles.push(...NO_RELEASE);
    }

    // 这个场景用真实 404（不是 overrides）：不在 prevOf 里就是没有 digest。
    const realClient = (counters) => ({
      async fetchDigestText(tag) {
        counters.digest += 1;
        if (!prevOf.has(tag)) return { ok: false, status: 404, error: "HTTP 404" };
        return { ok: true, status: 200, text: digestText(tag) };
      },
      async fetchTagsPage(after) {
        counters.tags += 1;
        const start = after ? tagsWithHoles.indexOf(after) + 1 : 0;
        const slice = tagsWithHoles.slice(start, start + 400);
        return { ok: true, status: 200, tags: slice, after: null };
      },
    });

    const dir = freshDataDir("realhole");
    const store = open(dir);
    const counters = { digest: 0, tags: 0 };
    const stats = await runBackfill({ store, client: realClient(counters), startTag: head });

    console.log("    返回：" + JSON.stringify({
      stored: stats.stored,
      digestFetches: stats.digestFetches,
      tagPageFetches: stats.tagPageFetches,
      absent: stats.absent,
      closed: stats.closed,
    }));

    // 核心断言：真实断口不会让回填截断，50 条一条不少。
    check("入库仍是完整 50 条", store.countVersions(), N);
    check("链闭合", chainClosed(store, head), true);
    check("backfill_state", store.getBackfillState(), 1);

    // 断口确实被探到了：4 个无 Release 的 tag 全进 absent。
    for (const t of NO_RELEASE) check("无 Release 的 " + t + " 记进 absent", store.isAbsent(t), true);

    // 接续方向：v0.416.26 自己**有** digest（它只是 previousTag 指向了一个没有
    // Release 的 tag），所以它不需要接续记录。真正需要接续的是那些 404 的 tag。
    //
    // 接续会一次性验到底：从 v0.416.12 开始逐个试 digest，v0.416.4 / v0.416.3 /
    // v0.415.16 都没，一直验到 v0.412.7 才接回去。所以 v0.416.12 直接指向
    // v0.412.7，中间几个不再各自留接续记录（它们只进 absent）。
    const holesMap = store.getHoleContinuations();
    check("v0.416.26 自己有 digest，不需要接续记录", holeFrom in holesMap, false);
    check("v0.416.26 已入库", store.hasVersion(holeFrom), true);
    check("v0.416.26 的 previousTag 是 v0.416.12", store.getLink(holeFrom)?.previousTag, "v0.416.12");
    check("v0.416.12 直接接到第一个有 digest 的版本", holesMap["v0.416.12"], "v0.412.7");
    check("中间的空 tag 不留接续记录", holesMap["v0.416.4"], undefined);
    check("接续回到有 digest 的版本", store.hasVersion("v0.412.7"), true);

    // 请求成本：50 次成功 + 5 次探测 404（4 个无 Release 的 + 直接被回填碰到的）。
    // tags 页整轮只抓 1 页：同一页上的多个候选一次取回，不重复翻页。
    check("digest 请求 = 50 成功 + 5 个 404", counters.digest, N + NO_RELEASE.length + 1);
    check("tags 请求整轮只 1 次", counters.tags, 1);
    check("stats.tagPageFetches 与实际一致", stats.tagPageFetches, counters.tags);

    // 幂等：再跑一次不该再发任何请求。
    const counters2 = { digest: 0, tags: 0 };
    const stats2 = await runBackfill({ store, client: realClient(counters2), startTag: head });
    check("真实断口下再跑仍幂等（1 步）", stats2.steps, 1);
    check("真实断口下再跑 0 请求", counters2.digest + counters2.tags, 0);

    prevOf.set(holeFrom, savedPrev);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("");

  // ── 汇总 ────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log("=== 汇总 ===");
  console.log("    断言 " + results.length + " 条，通过 " + (results.length - failed.length) + "，失败 " + failed.length);
  if (failed.length) {
    for (const f of failed) {
      console.log("    ✗ " + f.label + "：实际 " + String(f.actual) + "，期望 " + String(f.expected));
    }
    process.exitCode = 1;
  } else {
    console.log("    全部通过。");
  }
}

try {
  await main();
} finally {
  for (const store of cleanup) store.close();
}
