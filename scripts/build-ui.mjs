/**
 * scripts/build-ui.mjs — 把 ui/src/ 下的页面脚本打成浏览器产物。
 *
 *   ui/src/releases.js ──rspack──▶ dist/ui/releases.bundle.js + releases.bundle.css
 *
 * 主页一个入口：版本与设置是两个视图，共用同一份 bundle，不拆包。
 *
 * 页面用 `@hana/app-sdk/ui` 的 `hana`：那是浏览器侧 SDK。宿主不在安装时跑构建，
 * 所以它必须在这里内联进产物，运行时不留 bare specifier。
 *
 * 样式走 rspack 的 CSS 抽取，文件名带 [name]。产物直接写交付树 dist/ui/（平铺）。
 * dist/ 不入 git，由 build-app.mjs 每轮整体重建。本脚本也能单独跑（改 UI 后的快速迭代），
 * 那时 dist/ 只是部分的。
 *
 * ## 剥掉 paper-texture 纹理
 *
 * `@hana/app-sdk/dist/components.css` 里 8 条 `body.paper-texture …` 规则各内嵌
 * 一张 500×500 PNG 噪点图（base64），合计 1.37 MB，占该文件 87%。这些规则只在
 * 页面挂了 `paper-texture` class 时才生效，本 App 不用它。构建后统一剥除，
 * 免得卡面加载一份永远用不到的图。
 *
 * 用法：node scripts/build-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rspack } from "@rspack/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "ui", "src");
const OUT = path.join(ROOT, "dist", "ui");

const PAGES = ["releases"];

/** 只服务 paper-texture 的内嵌纹理规则，其余 CSS 原样保留。 */
const PAPER_TEXTURE_RULE = /body\.paper-texture[^{}]*\{[^{}]*base64[^{}]*\}/g;

/** 剥掉用不到的内嵌纹理。返回省下的字节数。 */
function stripPaperTexture(cssFile) {
  const before = fs.statSync(cssFile).size;
  const css = fs.readFileSync(cssFile, "utf8");
  const stripped = css.replace(PAPER_TEXTURE_RULE, "");
  if (stripped.length === css.length) return 0;
  fs.writeFileSync(cssFile, stripped);
  return before - fs.statSync(cssFile).size;
}

const missing = PAGES.map((p) => path.join(SRC, p + ".js")).filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error("[build-ui] 缺页面入口：" + missing.map((p) => path.relative(ROOT, p)).join("、"));
  process.exit(1);
}

const config = {
  mode: "production",
  devtool: false,
  target: ["web", "es2022"],
  entry: Object.fromEntries(PAGES.map((p) => [p, path.join(SRC, p + ".js")])),
  output: {
    path: OUT,
    filename: "[name].bundle.js",
    // dist/ui 由 build-app 整体清空重建；这里不能 clean，否则会抹掉别的构建产物。
    clean: false,
    module: true,
    chunkFormat: "module",
  },
  experiments: { outputModule: true },
  optimization: {
    // 单入口：宿主按页加载，不需要共享 chunk。
    // 压缩器留默认（JS 走 SWC、抽取出来的 CSS 走 Lightning CSS）。
    minimize: true,
    splitChunks: false,
    runtimeChunk: false,
  },
  resolve: { extensions: [".js", ".json"] },
  module: { rules: [{ test: /\.css$/, type: "css" }] },
  plugins: [new rspack.CssExtractRspackPlugin({ filename: "[name].bundle.css" })],
  performance: { hints: false },
  stats: "errors-warnings",
};

rspack(config, (err, stats) => {
  if (err) {
    console.error("[build-ui] 编译失败：", err);
    process.exit(1);
  }
  const info = stats.toJson({ all: false, assets: true, errors: true, warnings: true });
  for (const w of info.warnings || []) {
    console.log("[build-ui] 警告: " + (w.message || "").split("\n")[0]);
  }
  if (stats.hasErrors()) {
    for (const e of info.errors || []) console.error("[build-ui] 错误: " + e.message);
    process.exit(1);
  }
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  const expected = [];
  for (const p of PAGES) expected.push(p + ".bundle.js", p + ".bundle.css");
  let failed = false;
  for (const name of expected) {
    const p = path.join(OUT, name);
    const ok = fs.existsSync(p);
    if (!ok) failed = true;
    console.log("[build-ui] dist/ui/" + name + "  " + (ok ? kb(fs.statSync(p).size) : "<缺失>"));
  }
  if (failed) process.exit(1);
  for (const p of PAGES) {
    const saved = stripPaperTexture(path.join(OUT, p + ".bundle.css"));
    if (saved > 0) console.log("[build-ui] 剥掉 paper-texture 纹理：" + p + ".bundle.css 省 " + kb(saved));
  }
  console.log("[build-ui] 完成。");
});
