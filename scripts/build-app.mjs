/**
 * scripts/build-app.mjs — 组装 App 交付树 dist/（仓库根）。
 *
 * dist/ 的形状 = App 安装目录形态，也就是宿主读的那棵树：
 *
 *   manifest.json
 *   icon.svg              ← manifest.icon 指向的包根身份图（源 assets/icon.svg）
 *   bin/app.mjs           ← 服务端单入口（rspack，node 内建模块 external）
 *   runtime/downloader.mjs ← 受管 runtime 里的下载器，独立入口，不被 bundle
 *   ui/                   ← 壳页 + 打包产物 + assets/，不含 ui/src/
 *
 * 组装是**白名单**：只有点名列入的东西会进包，源码树里多出什么都不影响交付面。
 * 每轮先清空 dist/ 再重建，避免上一轮的残留被当成产物。构建完做断言：入口、
 * 图标、卡路由指向的文件都必须真实存在，且交付树里没有源码与开发件。
 *
 * 服务端在这里直接打（单入口只有一个，不值得为它单开一个脚本）；页面交给
 * build-ui.mjs，因为那份产物也需要单独重跑做快速迭代。
 *
 * 用法：node scripts/build-app.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rspack } from "@rspack/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const log = (...a) => console.log("[build-app]", ...a);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/") || ".";

/** 逐份拷贝，返回文件数。 */
function copyInto(from, to) {
  cpSync(from, to, { recursive: true, dereference: true });
  return countFiles(to);
}

function countFiles(target) {
  const st = statSync(target);
  if (!st.isDirectory()) return 1;
  let n = 0;
  for (const name of readdirSync(target)) n += countFiles(path.join(target, name));
  return n;
}

function runBuild(script, failMessage) {
  const p = path.join(ROOT, "scripts", script);
  if (!existsSync(p)) {
    console.error("[build-app] 找不到 scripts/" + script);
    process.exit(1);
  }
  try {
    execFileSync(process.execPath, [p], { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error("[build-app] " + failMessage);
    process.exit(1);
  }
}

/**
 * 服务端单入口：src/app.js → dist/bin/app.mjs。
 *
 * node 内建模块全部外部化（externalsPresets.node）——它们由宿主进程提供，不该打进产物。
 * 产物是 ESM（.mjs 自带 ESM 语义），所以不随包 package.json。
 * importMeta 保持运行时语义：构建期固化成构建机绝对路径的话，换台机器就指错。
 */
function buildServer() {
  const entry = path.join(ROOT, "src", "app.js");
  if (!existsSync(entry)) {
    console.error("[build-app] 缺服务端入口 src/app.js");
    process.exit(1);
  }
  const outDir = path.join(DIST, "bin");
  const config = {
    mode: "production",
    devtool: false,
    target: "node",
    entry: { app: entry },
    output: {
      path: outDir,
      filename: "[name].mjs",
      clean: false,
      module: true,
      chunkFormat: "module",
      library: { type: "module" },
    },
    experiments: { outputModule: true },
    externalsPresets: { node: true },
    module: { parser: { javascript: { importMeta: false } } },
    optimization: {
      // 单入口、无动态 import：没有可切的东西。不切也让产物逐字节可复现，宿主缓存才稳。
      minimize: true,
      splitChunks: false,
      runtimeChunk: false,
    },
    resolve: { extensions: [".js", ".json"] },
    performance: { hints: false },
    stats: "errors-warnings",
  };
  return new Promise((resolve, reject) => {
    rspack(config, (err, stats) => {
      if (err) return reject(err);
      const info = stats.toJson({ all: false, assets: true, errors: true, warnings: true });
      for (const w of info.warnings || []) {
        console.log("[build-app] 服务端警告: " + (w.message || "").split("\n")[0]);
      }
      if (stats.hasErrors()) {
        for (const e of info.errors || []) console.error("[build-app] 服务端错误: " + e.message);
        return reject(new Error("服务端构建失败"));
      }
      const out = path.join(outDir, "app.mjs");
      if (!existsSync(out)) return reject(new Error("未产出 dist/bin/app.mjs"));
      log("dist/bin/app.mjs  " + (statSync(out).size / 1024).toFixed(1) + " KB");
      resolve();
    });
  });
}

async function main() {
  // 0) 清空重建。
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // 1) 服务端单入口与页面产物。
  log("打包服务端单入口（src/app.js → dist/bin/app.mjs）…");
  await buildServer();

  log("打包页面产物（ui/src/*.js → dist/ui/*.bundle.*）…");
  runBuild("build-ui.mjs", "页面构建失败");

  // 2) 契约件（白名单）。图标名跟着 manifest.icon 走，不写死：
  // 它可以是 icon.svg（矢量）或 icon.png。
  let total = 0;
  total += copyInto(path.join(ROOT, "manifest.json"), path.join(DIST, "manifest.json"));
  const iconName = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8")).icon;
  total += copyInto(path.join(ROOT, "assets", iconName), path.join(DIST, iconName));
  log("manifest.json + " + iconName + " 就位");

  // 许可证进包：MPL-2.0 要求随分发提供许可文本。
  if (existsSync(path.join(ROOT, "LICENSE"))) {
    total += copyInto(path.join(ROOT, "LICENSE"), path.join(DIST, "LICENSE"));
  }

  // 3) 受管 runtime：下载服务与连接池是独立入口，由 ctx.runtime.start 直接拉起，不进 app.mjs。
  mkdirSync(path.join(DIST, "runtime"), { recursive: true });
  for (const name of ["downloader.mjs", "service.mjs", "pool.mjs"]) {
    total += copyInto(path.join(ROOT, "runtime", name), path.join(DIST, "runtime", name));
  }

  // 4) ui/：壳页 + assets + 构建产物，不含 ui/src/。
  const uiOut = path.join(DIST, "ui");
  for (const name of ["releases.html"]) {
    const src = path.join(ROOT, "ui", name);
    if (!existsSync(src)) {
      console.error("[build-app] 缺 ui/" + name);
      process.exit(1);
    }
    total += copyInto(src, path.join(uiOut, name));
  }
  const uiAssets = path.join(ROOT, "ui", "assets");
  if (!existsSync(uiAssets)) {
    console.error("[build-app] 缺 ui/assets/");
    process.exit(1);
  }
  total += copyInto(uiAssets, path.join(uiOut, "assets"));
  log("ui/ 就位（壳页 + assets + 产物；不含 ui/src/）");

  // 5) 断言：入口、图标、卡路由都必须真实存在。
  const manifest = JSON.parse(readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  if (typeof manifest.entry !== "string" || !existsSync(path.join(DIST, manifest.entry))) {
    console.error("[build-app] manifest.entry 不在交付树里：" + manifest.entry);
    process.exit(1);
  }
  if (typeof manifest.icon !== "string" || !existsSync(path.join(DIST, manifest.icon))) {
    console.error("[build-app] manifest.icon 不在交付树里：" + manifest.icon);
    process.exit(1);
  }
  const routes = [];
  for (const card of manifest.contributes?.cards || []) {
    if (typeof card.route === "string") routes.push(["卡 " + card.id, card.route]);
    // 整页卡带 functionPanel 时，面板内容是主卡用 hana.panel 推的，不是另一个页面。
    // 声明了 panel 却没开整页卡的话宿主会忽略它，这里直接拦住。
    if (card.functionPanel !== undefined && card.realization !== "page") {
      console.error(
        "[build-app] 卡 " + card.id + " 声明了 functionPanel，但 realization 不是 page（宿主会忽略）",
      );
      process.exit(1);
    }
  }
  for (const [what, route] of routes) {
    const file = path.join(DIST, "ui", String(route).replace(/^\//, ""));
    if (!existsSync(file)) {
      console.error("[build-app] " + what + " 的路由指向的文件不在交付树里：ui" + route);
      process.exit(1);
    }
  }
  log("断言通过：entry / icon / " + routes.map(([w]) => w).join(" / ") + " 都真实存在");

  // 6) 断言：交付树里绝不能出现源码与开发件。
  const FORBIDDEN = [
    "src",
    "ui/src",
    "scripts",
    "node_modules",
    "vendor",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "README.md",
    "HANDOFF.md",
  ];
  // 包的根上只能有 icon.png 一份身份图；assets/ 那一份是源码，不进交付面。
  const leaked = [...FORBIDDEN, "assets"].filter((p) => existsSync(path.join(DIST, p)));
  if (leaked.length) {
    console.error("[build-app] 交付树里出现了不该有的路径：" + leaked.join("、"));
    process.exit(1);
  }
  const runtimeFiles = readdirSync(path.join(DIST, "runtime"));
  const allowed = ["downloader.mjs", "service.mjs", "pool.mjs"];
  const unexpected = runtimeFiles.filter((name) => !allowed.includes(name));
  if (unexpected.length) {
    console.error("[build-app] dist/runtime/ 出现了预期外的文件：" + unexpected.join("、"));
    process.exit(1);
  }

  log("完成：" + rel(DIST) + "  （" + total + " 个静态文件 + 构建产物；pack 从这里出包）");
}

await main();
