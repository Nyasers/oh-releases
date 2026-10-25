/**
 * scripts/pack.mjs — 从 dist/ 出安装包。
 *
 * 只从 dist/ 出包：交付面由 build-app.mjs 用白名单组装好，这里不做任何排除判断
 * （黑名单只列它记得的东西，源码树里多出什么就漏什么）。出包前无条件重跑一次
 * build-app.mjs，所以"包里的东西必然等于当前源码的产物"不依赖调用方记得先构建。
 *
 * 产物落 releases/<id>-v<version>.zip，同名 .sha256 存小写十六进制摘要，
 * 以及市场投稿用的 <kind>-<id>-<version>.entry.json。
 * 版本单一事实源是 manifest.json，并与 package.json 对齐（不一致直接拒包）。
 *
 * 不随包：LICENSE / NOTICE / README / scripts/ / src/ / ui/src/ ——它们不在 dist/ 里。
 *
 * 用法：
 *   node scripts/pack.mjs                    # 出包到 releases/
 *   node scripts/pack.mjs --out <目录>        # 指定输出目录
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const log = (...a) => console.log("[pack]", ...a);

function arg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return null;
}

// ── 最小 ZIP 写入器（deflate / store，UTF-8 文件名，保留可执行位） ────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function collectEntries(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isSymbolicLink()) continue; // 包内不允许符号链接
    if (st.isDirectory()) collectEntries(abs, base, out);
    else if (st.isFile()) {
      out.push({
        entry: path.relative(base, abs).split(path.sep).join("/"),
        data: readFileSync(abs),
        mode: (st.mode & 0o111) !== 0 ? 0o755 : 0o644,
      });
    }
  }
  return out;
}

function writeZip(outFile, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.entry, "utf8");
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data, { level: 6 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(((e.mode | 0o100000) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outFile, Buffer.concat([...chunks, cenBuf, eocd]));
}

// ── 主流程 ────────────────────────────────────────────────────────────────

function main() {
  // 版本对齐先在源码树查（manifest 与 package.json 是那里的单一事实源），再组装 dist/。
  const manifest = readJson(path.join(ROOT, "manifest.json"));
  const pkg = readJson(path.join(ROOT, "package.json"));

  if (!manifest.id || !manifest.version) {
    console.error("[pack] manifest.json 缺 id/version，拒绝出包");
    process.exit(1);
  }
  if (pkg.version && pkg.version !== manifest.version) {
    console.error(
      "[pack] 版本不一致：manifest=" + manifest.version + " package.json=" + pkg.version + "（单一事实源是 manifest）",
    );
    process.exit(1);
  }

  // 无条件重建交付树：出包是唯一必须保证产物新鲜的时刻。
  const buildApp = path.join(ROOT, "scripts", "build-app.mjs");
  if (!existsSync(buildApp)) {
    console.error("[pack] 找不到 scripts/build-app.mjs，无法组装交付树");
    process.exit(1);
  }
  log("组装交付树 dist/（白名单）…");
  try {
    execFileSync(process.execPath, [buildApp], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    const out = [error.stdout, error.stderr].map((b) => String(b || "")).join("\n").trim();
    console.error("[pack] 交付树组装失败：\n" + out.split("\n").slice(-16).join("\n"));
    process.exit(1);
  }

  const outDir = path.resolve(arg("--out") || path.join(ROOT, "releases"));
  mkdirSync(outDir, { recursive: true });
  const zipName = manifest.id + "-v" + manifest.version + ".zip";
  const zipPath = path.join(outDir, zipName);

  const entries = collectEntries(DIST);
  if (!entries.length) {
    console.error("[pack] dist/ 是空的，拒绝出包");
    process.exit(1);
  }
  writeZip(zipPath, entries);

  const bytes = readFileSync(zipPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(zipPath + ".sha256", digest + "\n");

  // 包内必须带的东西：入口、清单、图标、主页与下载器。少一个就是装上也起不来。
  const names = new Set(entries.map((e) => e.entry));
  const required = [
    "manifest.json",
    manifest.entry,
    manifest.icon,
    "LICENSE",
    "runtime/downloader.mjs",
    "runtime/service.mjs",
    "runtime/pool.mjs",
    "ui/releases.html",
    "ui/releases.bundle.js",
    "ui/releases.bundle.css",
  ];
  const missing = required.filter((n) => !names.has(n));
  if (missing.length) {
    console.error("[pack] 包内缺必需文件：" + missing.join("、"));
    process.exit(1);
  }
  const leaked = entries.map((e) => e.entry).filter((n) => /^(?:src|scripts|node_modules|vendor)\//.test(n) || n.startsWith("ui/src/"));
  if (leaked.length) {
    console.error("[pack] 包内出现源码路径：" + leaked.slice(0, 10).join("、"));
    process.exit(1);
  }

  log("出包：" + path.relative(ROOT, zipPath).replace(/\\/g, "/"));
  log("  条目 " + entries.length + " · 大小 " + (bytes.length / 1024).toFixed(1) + " KB");
  log("  sha256 " + digest);

  // 市场投稿用的 entry。archive.url 恒为 `{{BASE_URL}}/<zip 名>`：同步器靠这个前缀
  // 取出 zip 资产名、再去 Release 资产里找同名文件。写绝对地址会让投稿在校验阶段直接失败。
  const entryPath = path.join(outDir, "app-" + manifest.id + "-" + manifest.version + ".entry.json");
  const entry = {
    kind: "app",
    id: manifest.id,
    name: manifest.name,
    publisher: pkg.author,
    description: manifest.description,
    version: manifest.version,
    permissions: (manifest.capabilities || []).map((capability) => ({ capability })),
  };
  if (manifest.minAppVersion) entry.compatibility = { minAppVersion: manifest.minAppVersion };
  if (pkg.license) entry.license = pkg.license;

  // icon 要 256×256 PNG 的 data URL。图标是 SVG，光栅化结果随仓库提交，
  // 打包只读文件：CI 里没有完整宿主，也就没有 sharp。
  const iconPng = path.join(ROOT, "assets", "icon-256.png");
  if (existsSync(iconPng)) {
    const png = readFileSync(iconPng);
    if (png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47) {
      entry.icon = "data:image/png;base64," + png.toString("base64");
    } else {
      log("  警告：assets/icon-256.png 不是 PNG，entry 里不带 icon");
    }
  } else {
    log("  警告：缺 assets/icon-256.png（跑 node scripts/make-icon-png.mjs），entry 里不带 icon");
  }

  entry.archive = {
    url: "{{BASE_URL}}/" + zipName,
    sha256: digest,
    size: bytes.length,
    format: "zip",
  };
  writeFileSync(entryPath, JSON.stringify(entry, null, 2) + "\n");
  log("  entry " + path.basename(entryPath));
}

main();
