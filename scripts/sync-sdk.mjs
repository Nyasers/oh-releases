// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/sync-sdk.mjs — 把本机宿主的 App SDK 快照同步进 vendor/hana-app-sdk/。
 *
 * ## 为什么是快照而不是「从 npm 装」
 *
 * @hana/app-sdk 不在 npm 上，它是宿主打包时产出的内部包。仓库里因此存一份快照：4 个 tgz
 * （app-sdk 本体 + 它依赖的三个 plugin-* 包）加 source-manifest.json。构建期由 rspack 内联，
 * 所以运行时不依赖它——但**构建**必须能拿到，否则装不上依赖、打不出页面产物。
 *
 * source-manifest.json 的 packedVersion 是宿主写入的 SDK 版本。宿主升级后这份快照会漂，
 * 人肉拷贝既容易漏文件，也说不清同步到了哪个宿主版本，所以有本脚本。
 *
 * ## 源的位置（按序探测，第一个命中的赢）
 *
 *   1. --source <dir>
 *   2. <HANA_HOME>/artifacts/server/<最新版本>/skills2set/hana-app-creator/assets/sdk（随宿主版本分发，权威）
 *   3. <HANA_HOME>/skills/hana-app-creator/assets/sdk（已安装 skill 的资产，兜底）
 *
 * 源是本机宿主，CI 上没有，所以本脚本不进 CI 门禁。同步按整文件 sha256 比对，只写变化的那几个。
 *
 * ## 同步后要做的事（本脚本会打印待办）
 *
 *   · 依赖树：tgz 换了内容，pnpm 不会自动重算（`file:` 依赖按路径判定，路径没变就认为锁有效）。
 *     必须按包名点名 `pnpm update <包名>`，再 `pnpm install`。
 *
 * 用法：
 *   node scripts/sync-sdk.mjs                 # 同步（源自动探测）
 *   node scripts/sync-sdk.mjs --check         # 只校验，有漂移则 exit 1
 *   node scripts/sync-sdk.mjs --source <dir>  # 指定源目录
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "vendor", "hana-app-sdk");
const HANA_HOME =
  process.env.HANA_HOME || join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".hanako");

/** 快照的全部构成，缺一即半份——宁可报错，不写进去一个残份。宿主新增包时同步补进本表。 */
const FILES = [
  "hana-app-sdk.tgz",
  "hana-plugin-components-0.0.0.tgz",
  "hana-plugin-protocol-0.0.0.tgz",
  "hana-plugin-sdk-0.0.0.tgz",
  "source-manifest.json",
];

/** tgz → 包名。锁文件重解析按包名点名（pnpm 认路径不认文件内容）。 */
const TGZ_PACKAGES = {
  "hana-app-sdk.tgz": "@hana/app-sdk",
  "hana-plugin-components-0.0.0.tgz": "@hana/plugin-components",
  "hana-plugin-protocol-0.0.0.tgz": "@hana/plugin-protocol",
  "hana-plugin-sdk-0.0.0.tgz": "@hana/plugin-sdk",
};

const SKILL_SDK = join("skills", "hana-app-creator", "assets", "sdk");
const SERVER_SKILL_SDK = join("skills2set", "hana-app-creator", "assets", "sdk");

const log = (...a) => console.log("[sync-sdk]", ...a);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/") || ".";

function arg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** packedVersion：宿主打包时写入的 SDK 版本，同步的对错以此为准。 */
function packedVersion(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(join(dir, "source-manifest.json"), "utf8"));
    return typeof j?.packedVersion === "string" ? j.packedVersion : null;
  } catch {
    return null;
  }
}

/** server 目录名形如 `1.0.16-beta-win32-x64-<hash>`；按语义版本降序。 */
function byVersionDesc(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function findSource() {
  const explicit = arg("--source");
  if (explicit) return path.resolve(explicit);

  const serverRoot = join(HANA_HOME, "artifacts", "server");
  if (fs.existsSync(serverRoot)) {
    const newest = fs
      .readdirSync(serverRoot)
      .filter((v) => fs.existsSync(join(serverRoot, v, SERVER_SKILL_SDK)))
      .sort(byVersionDesc)[0];
    if (newest) return join(serverRoot, newest, SERVER_SKILL_SDK);
  }
  return join(HANA_HOME, SKILL_SDK);
}

function main() {
  const check = process.argv.includes("--check");
  const src = findSource();

  if (!fs.existsSync(src)) {
    console.error(`[sync-sdk] 找不到 SDK 快照源：${src}`);
    console.error("  宿主没装在这里时用 --source <dir> 指定。");
    process.exit(2);
  }

  // 源的完整性：五件缺一即半份，不写残份。
  const missing = FILES.filter((f) => !fs.existsSync(join(src, f)));
  if (missing.length) {
    console.error(`[sync-sdk] 源不完整（缺 ${missing.join("、")}）：${rel(src)}`);
    process.exit(2);
  }

  const srcVersion = packedVersion(src);
  const destVersion = packedVersion(DEST);
  log(`源   ${rel(src)}  packedVersion=${srcVersion ?? "?"}`);
  log(`目标 ${rel(DEST)}  packedVersion=${destVersion ?? "（尚未同步）"}`);

  const changed = [];
  for (const name of FILES) {
    const a = join(src, name);
    const b = join(DEST, name);
    const same = fs.existsSync(b) && sha256(a) === sha256(b);
    if (!same) changed.push(name);
  }

  if (changed.length === 0) {
    log(`已是最新（${FILES.length} 个文件全部一致，packedVersion=${srcVersion ?? "?"}）`);
    return;
  }

  if (check) {
    console.error(`[sync-sdk] 有漂移：${changed.join("、")}`);
    console.error("  跑 node scripts/sync-sdk.mjs 同步（本机宿主为源）。");
    process.exit(1);
  }

  fs.mkdirSync(DEST, { recursive: true });
  for (const name of changed) {
    fs.copyFileSync(join(src, name), join(DEST, name));
    log(`  写入 ${name}`);
  }
  log(`同步完成：${changed.length} 个文件更新，packedVersion ${destVersion ?? "?"} → ${srcVersion ?? "?"}`);

  // 待办：pnpm 不会因为本地 tgz 换内容而重算锁文件，必须按包名点名 update。
  const touchedPkgs = changed.filter((f) => TGZ_PACKAGES[f]).map((f) => TGZ_PACKAGES[f]);
  if (touchedPkgs.length) {
    console.log("");
    log("接下来要做（tgz 内容变了，锁文件不会自动跟上）：");
    log(`  pnpm update ${touchedPkgs.join(" ")}`);
    log("  pnpm install");
  }
}

main();
