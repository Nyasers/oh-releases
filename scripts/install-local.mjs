/**
 * scripts/install-local.mjs — 把交付树装进本机 <HANA_HOME>/apps/<id>/（开发循环用）。
 *
 * 做的事只有一件：清掉旧目录，再把 dist/ 整份拷到 <HANA_HOME>/apps/<id>/。
 *
 * 拷完**不等于装好**：宿主的装载只认安装记录，盘上有一个目录只会让它停在
 * `unregistered`——不 import、不上树、一行代码不跑。要真正跑起来，去市场「已安装」页
 * App 类目的「待批准」区块批准它。本脚本把这句话打出来，不假装装完了。
 *
 * HANA_HOME 缺省是 ~/.hanako，可用 --home 或环境变量 HANA_HOME 覆盖。
 * 默认先跑一次 build（--no-build 跳过），因为开发循环里"改了源码忘了构建"是常态。
 *
 * 用法：
 *   node scripts/install-local.mjs
 *   node scripts/install-local.mjs --no-build --home D:\hana
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const log = (...a) => console.log("[install-local]", ...a);
const fail = (message) => {
  console.error("[install-local] " + message);
  process.exit(1);
};

function arg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return null;
}

const hasFlag = (name) => process.argv.slice(2).includes(name);

const home = path.resolve(
  arg("--home") || process.env.HANA_HOME || path.join(os.homedir(), ".hanako"),
);

function main() {
  if (!hasFlag("--no-build")) {
    log("先跑一次 build …");
    try {
      execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-app.mjs")], {
        cwd: ROOT,
        stdio: "inherit",
      });
    } catch {
      fail("构建失败，未安装");
    }
  }
  if (!existsSync(DIST)) fail("dist/ 不存在（先跑 pnpm run build）");

  const manifestPath = path.join(DIST, "manifest.json");
  if (!existsSync(manifestPath)) fail("dist/manifest.json 不存在");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.id) fail("dist/manifest.json 缺 id");

  const appsDir = path.join(home, "apps");
  const target = path.join(appsDir, manifest.id);
  // 目录名必须等于 manifest.id，宿主按这一条认应用。
  if (path.basename(target) !== manifest.id) fail("安装目录名与 manifest.id 不一致：" + manifest.id);

  mkdirSync(appsDir, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(DIST, target, { recursive: true, dereference: true });

  log("已拷入 " + target);
  log("  版本 " + manifest.version + " · 入口 " + manifest.entry);
  log("下一步：宿主扫到的是一个没有安装记录的目录，它会停在 unregistered（不 import、不跑代码）。");
  log("        去市场「已安装」页 App 类目的「待批准」区块批准 " + manifest.id + "，装载才会发生。");
  if (!existsSync(path.join(home, "server-info.json"))) {
    log("        （没找到 " + path.join(home, "server-info.json") + "：宿主似乎没在跑，批准要在宿主起来之后做。）");
  }
}

main();
