/**
 * scripts/make-icon-png.mjs — 把 assets/icon.svg 光栅化成 assets/icon-256.png。
 *
 * 市场 entry 的 `icon` 字段要求一张 256×256 PNG 的 data URL（宿主打包器就是这么产出的）。
 * 本 App 的身份图标是 SVG，所以要有这一步。
 *
 * 为什么不在打包时现转：CI 里没有完整宿主，也就没有 sharp；为一张图标在 CI 装一个
 * 带原生二进制的图像库不划算。图标是身份资产，变一次是件不小的事，值得像源码一样
 * 进仓库、可审阅。所以把转换固化成一次性动作，产物提交进仓库，打包只读文件。
 *
 * 只在改图标时手动跑（不进 CI）：
 *   node scripts/make-icon-png.mjs
 *
 * 依赖宿主自带的 sharp（<HANA_HOME>/artifacts/server/<版本>/node_modules/sharp）。
 * 找不到就明确报错，不静默降级成「没有图标」。
 */
import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, "assets", "icon.svg");
const OUT_DIR = join(ROOT, "assets");
const OUT = join(OUT_DIR, "icon-256.png");
/** 宿主打包器用的边长，与 entry 的展示规格一致。 */
const SIZE = 256;

const HANA_HOME = process.env.HANA_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".hanako");

/** 按语义版本降序挑最新的 server 目录。 */
function byVersionDesc(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 在宿主安装目录里找 sharp 的 ESM 入口。
 * 入口从 sharp 自己 package.json 的 exports['.'].import 读，不猜 lib/index.js 这种路径。
 */
async function findSharp() {
  const roots = process.env.HANA_SERVER_DIR
    ? [process.env.HANA_SERVER_DIR]
    : await (async () => {
        const serverRoot = join(HANA_HOME, "artifacts", "server");
        if (!existsSync(serverRoot)) return [];
        return (await readdir(serverRoot)).sort(byVersionDesc).map((name) => join(serverRoot, name));
      })();

  for (const root of roots) {
    const pkgPath = join(root, "node_modules", "sharp", "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const entry = pkg?.exports?.["."]?.import?.default;
    if (typeof entry !== "string") continue;
    const full = join(root, "node_modules", "sharp", entry);
    if (existsSync(full)) return full;
  }
  return null;
}

const sharpEntry = await findSharp();
if (!sharpEntry) {
  console.error("[icon] 找不到宿主自带的 sharp。");
  console.error("[icon] 用 HANA_SERVER_DIR 指向某个 <HANA_HOME>/artifacts/server/<版本> 目录再试。");
  process.exit(1);
}

const { default: sharp } = await import(pathToFileURL(sharpEntry).href);

await mkdir(OUT_DIR, { recursive: true });
const info = await sharp(SOURCE, { limitInputPixels: 64e6 })
  .resize({ width: SIZE, height: SIZE, fit: "fill" })
  .png()
  .toFile(OUT);

console.log("[icon] " + OUT);
console.log("[icon] " + info.width + "×" + info.height + " · " + (info.size / 1024).toFixed(1) + " KB");
