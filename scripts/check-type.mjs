/**
 * scripts/check-type.mjs — 交付前的静态检查。
 *
 * 分两层，谁先跑由环境决定：
 *
 *   1. **零依赖层（始终跑）**
 *      · 语法：src/、runtime/、ui/src/、scripts/ 下每个 .js/.mjs 过一遍 node --check。
 *        产物里的语法错误会让 App 一行不跑就 failed，这一层在这里就该断掉。
 *      · 解析：源码里每条 import 都真的能解析——相对路径落到存在的文件，bare specifier
 *        经 node_modules 解析得到（@hana/app-sdk 的 exports 映射随之实测）。
 *      · 清单：manifest.json 的必填字段、id 与目录名一致、entry/icon/卡路由/设置路由
 *        指向的文件、network 与 cards 只含宿主认识的键。
 *
 *   2. **类型层（有 TypeScript 才跑）**
 *      仓库不把 TypeScript 列为依赖。它在这里就绪时，用 --checkJs 对服务端源码跑一遍
 *      真正的类型检查；没装就明说 skipped，不假装通过，也不把它算成失败。
 *
 * 用法：node scripts/check-type.mjs
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import * as acornWalk from "acorn-walk";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/") || ".";

// ---------------------------------------------------------------- 1. 语法

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const sourceFiles = [
  ...walk(path.join(ROOT, "src")),
  ...walk(path.join(ROOT, "runtime")),
  ...walk(path.join(ROOT, "ui", "src")),
  ...walk(path.join(ROOT, "scripts")),
];

// 用 .mjs 的临时副本做语法检查：--check 的模块类型判定按文件扩展名与 package.json 走，
// 直接对 .js 检查会在"这个文件算不算 ESM"上多一层不确定性。复制成 .mjs 就没有这一层。
const syntaxTmp = mkdtempSync(path.join(os.tmpdir(), "oh-releases-check-"));
for (const [i, file] of sourceFiles.entries()) {
  // 带上序号：不同目录下可能有同名文件，平铺进同一个临时目录会互相覆盖。
  const probe = path.join(syntaxTmp, i + "-" + path.basename(file).replace(/\.js$/, ".mjs"));
  writeFileSync(probe, readFileSync(file));
  try {
    execFileSync(process.execPath, ["--check", probe], { stdio: "pipe" });
  } catch (error) {
    const detail = String((error.stderr && error.stderr.toString()) || error.message)
      .split("\n")
      .filter((line) => line.trim() && !/^node:/.test(line))
      .slice(0, 4)
      .join(" ")
      .trim();
    fail("语法错误 " + rel(file) + "：" + detail);
  }
}
rmSync(syntaxTmp, { recursive: true, force: true });

// ---------------------------------------------------------------- 2. import 解析

// 只认真正的 ESM 语句：`import … from "x"`、`import "x"`、`export … from "x"`。
// 换行允许（具名导入可以拆行），但整条语句里不会有分号，所以用 [^;] 界定。
const IMPORT_RE =
  /(?:^|\n)[ \t]*import\s+(?:[^;]*?\s+from\s*)?["']([^"']+)["']|(?:^|\n)[ \t]*export\s+(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*["']([^"']+)["']/g;

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = path.resolve(path.dirname(file), spec);
      const found = [target, target + ".js", target + ".mjs", target + ".json", target + ".css"].find((p) =>
        existsSync(p),
      );
      if (!found) fail(rel(file) + " 里 import 的相对路径不存在：" + spec);
      continue;
    }
    // node: 内建模块由运行时提供，不在 node_modules 里解析。
    if (spec.startsWith("node:")) continue;
    try {
      require.resolve(spec);
    } catch {
      fail(rel(file) + " 里 import 的包无法解析：" + spec);
    }
  }
}

// ---------------------------------------------------------------- 2.5 未声明标识符
//
// 页面脚本跑在浏览器里没任何静态分析，一个变量名写错就是整页白屏（把 appState
// 写成 state 这种）；服务端同理，只是炸法不同——一个漏掉的 import 会让某个动作在
// 真机上抛 ReferenceError（oh-releases 的 poll.js 漏了 releaseUrl，按下检查那一刻才炸）。
// node --check 只查语法，不查标识符是否存在。
//
// 这里用 acorn 建真实作用域链：收集每个作用域内声明过的名字（含函数参数、解构、
// catch 子句、for 声明），再看每个引用能不能在链上找到。它拦不住 undefined 属性
// 访问，但能拦住拼错变量名——那类错误往往要等用户看见白屏才发现。
//
// acorn / acorn-walk 只在开发期跑，不进交付树，运行时依赖仍为零。
const BROWSER_GLOBALS = new Set([
  "window", "document", "console", "navigator", "location", "localStorage",
  "sessionStorage", "performance", "fetch", "history", "screen", "scrollTo",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask",
  "structuredClone", "getComputedStyle", "alert", "confirm", "prompt",
  "Math", "JSON", "Date", "Number", "String", "Boolean", "Object", "Array",
  "Error", "TypeError", "RangeError", "SyntaxError", "Promise", "Map", "Set",
  "WeakMap", "WeakSet", "Symbol", "RegExp", "Intl", "Proxy", "Reflect",
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController",
  "AbortSignal", "Blob", "File", "FileReader", "FormData", "Headers",
  "Request", "Response", "Event", "CustomEvent", "Element", "HTMLElement",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "atob", "btoa",
  "Infinity", "NaN", "undefined", "globalThis", "arguments",
]);

/**
 * 服务端（src/）能看到的全局。比浏览器那张表窄：不放 document / window / localStorage，
 * 那几个名字在 Node 里出现就是真写错了（把浏览器代码抄进服务端），应当报出来。
 */
const NODE_GLOBALS = new Set([
  "console", "process", "Buffer", "URL", "URLSearchParams", "TextEncoder",
  "TextDecoder", "AbortController", "AbortSignal", "fetch", "Headers",
  "Request", "Response", "FormData", "Blob", "File", "streams",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "queueMicrotask", "structuredClone", "performance",
  "Math", "JSON", "Date", "Number", "String", "Boolean", "Object", "Array",
  "Error", "TypeError", "RangeError", "SyntaxError", "URIError", "Promise",
  "Map", "Set", "WeakMap", "WeakSet", "Symbol", "RegExp", "Intl", "Proxy",
  "Reflect", "BigInt", "Atomics", "globalThis", "global",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "atob", "btoa",
  "Infinity", "NaN", "undefined", "arguments",
]);

/** 把一条声明模式（标识符 / 解构 / 剩余）里的名字全收进 set。 */
function collectPatternNames(node, into) {
  if (!node) return;
  if (node.type === "Identifier") {
    into.add(node.name);
    return;
  }
  if (node.type === "ObjectPattern") {
    for (const prop of node.properties || []) {
      if (prop.type === "RestElement") collectPatternNames(prop.argument, into);
      else collectPatternNames(prop.value, into);
    }
    return;
  }
  if (node.type === "ArrayPattern") {
    for (const el of node.elements || []) collectPatternNames(el, into);
    return;
  }
  if (node.type === "AssignmentPattern") {
    collectPatternNames(node.left, into);
    return;
  }
  if (node.type === "RestElement") collectPatternNames(node.argument, into);
}

/** 把一个函数（含箭头函数）的参数名收进 set。 */
function collectParams(fn, into) {
  for (const p of fn.params || []) collectPatternNames(p, into);
}

/**
 * 收集整个文件里声明过的名字（扁平，不建嵌套作用域）。
 *
 * 扁平收集会误认为“内层声明的名字外层也能用”，因而不报那些错——宁可漏报，
 * 不要因为作用域建模不准而误报把构建拦住。它要拦的是拼错变量名。
 */
function collectDeclarations(ast, into) {
  acornWalk.simple(ast, {
    VariableDeclaration(n) {
      for (const d of n.declarations || []) collectPatternNames(d.id, into);
    },
    FunctionDeclaration(n) {
      if (n.id) into.add(n.id.name);
      collectParams(n, into);
    },
    FunctionExpression(n) {
      if (n.id) into.add(n.id.name);
      collectParams(n, into);
    },
    ArrowFunctionExpression(n) {
      collectParams(n, into);
    },
    ClassDeclaration(n) {
      if (n.id) into.add(n.id.name);
    },
    ImportDeclaration(n) {
      for (const s of n.specifiers || []) into.add(s.local.name);
    },
    CatchClause(n) {
      collectPatternNames(n.param, into);
    },
  });
}

/** 一个标识符是不是“被读”的位置（而不是声明名或属性名）。 */
function isReference(node, parent) {
  if (!parent) return true;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (parent.type === "Property" && parent.key === node && !parent.computed) return false;
  if (parent.type === "MethodDefinition" && parent.key === node) return false;
  if (parent.type === "PropertyDefinition" && parent.key === node) return false;
  if (/Pattern$/.test(parent.type)) return false;
  if (parent.type === "RestElement" || parent.type === "AssignmentPattern") return false;
  if (parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression") {
    if ((parent.params || []).includes(node)) return false;
    if (parent.id === node) return false;
  }
  if (parent.type === "VariableDeclarator" && parent.id === node) return false;
  if (parent.type === "ClassDeclaration" && parent.id === node) return false;
  if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier") return false;
  if (parent.type === "CatchClause" && parent.param === node) return false;
  if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") return false;
  if (parent.type === "ExportSpecifier" && parent.local === node) return false;
  return true;
}

for (const [dir, globals, where] of [
  [path.join(ROOT, "ui", "src"), BROWSER_GLOBALS, "运行时会白屏"],
  [path.join(ROOT, "src"), NODE_GLOBALS, "该动作会被炸成 ReferenceError"],
]) {
  for (const file of walk(dir)) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(file, "utf8");
    let ast;
    try {
      ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
    } catch (error) {
      fail("解析失败 " + rel(file) + "：" + (error && error.message));
      continue;
    }

    const declared = new Set(globals);
    collectDeclarations(ast, declared);

    const realMissing = [];
    acornWalk.ancestor(ast, {
      Identifier(node, ancestors) {
        const parent = ancestors.length > 1 ? ancestors[ancestors.length - 2] : null;
        if (!isReference(node, parent)) return;
        if (declared.has(node.name)) return;
        realMissing.push(node.name + "（第 " + (node.loc ? node.loc.start.line : "?") + " 行）");
      },
    });

    if (realMissing.length) {
      const uniq = [...new Set(realMissing)];
      fail(rel(file) + " 里有未声明的变量（" + where + "）：" + uniq.slice(0, 8).join("、"));
    }
  }
}

// ---------------------------------------------------------------- 3. 清单

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
} catch (error) {
  fail("manifest.json 读不了：" + (error && error.message));
}

if (manifest) {
  for (const key of ["manifestVersion", "id", "name", "version", "entry", "icon"]) {
    if (manifest[key] === undefined) fail("manifest.json 缺必填字段：" + key);
  }
  if (manifest.manifestVersion !== 2) fail("manifestVersion 必须恰好是 2，实际：" + manifest.manifestVersion);
  if (manifest.id !== path.basename(ROOT)) {
    fail("manifest.id（" + manifest.id + "）必须与仓库目录名（" + path.basename(ROOT) + "）一致");
  }
  if (typeof manifest.id === "string" && /[\\/:]/.test(manifest.id)) {
    fail("manifest.id 不能含 \\ / :");
  }

  // network：只认这五个键，未知键会让宿主整应用拒载（v1 的 hosts 别名尤其不行）。
  if (manifest.network) {
    const allowed = new Set(["allowedHosts", "methods", "allowLocalhost", "defaultTimeoutMs", "maxResponseBytes"]);
    for (const key of Object.keys(manifest.network)) {
      if (!allowed.has(key)) fail("manifest.network 含宿主不认识的键：" + key);
    }
  }

  for (const card of manifest.contributes?.cards || []) {
    if (!card.id) fail("contributes.cards 有一条缺 id");
    if (!card.face || typeof card.face.image !== "string") {
      fail("卡 " + card.id + " 缺 face.image");
    } else if (!existsSync(path.join(ROOT, "ui", card.face.image))) {
      fail("卡 " + card.id + " 的 face.image 不存在：ui/" + card.face.image);
    }
    if (card.route && card.embedUrl) fail("卡 " + card.id + " 同时写了 route 与 embedUrl");
    if (typeof card.route === "string") {
      const file = path.join(ROOT, "ui", card.route.replace(/^\//, ""));
      if (!existsSync(file)) fail("卡 " + card.id + " 的 route 指向的文件不存在：ui" + card.route);
    }
  }

  // entry 指向的是构建产物（dist/ 里的），源码树里没有；只校验它落在 bin/ 下。
  if (typeof manifest.entry === "string" && !manifest.entry.startsWith("bin/")) {
    fail("manifest.entry 应指向构建产物 bin/…，实际：" + manifest.entry);
  }
  // icon 在交付树根部，源在 assets/ 下；两条路径任一存在即可。
  if (typeof manifest.icon === "string" && !existsSync(path.join(ROOT, manifest.icon))) {
    if (!existsSync(path.join(ROOT, "assets", manifest.icon))) {
      fail("manifest.icon 在源码树里找不到：" + manifest.icon);
    }
  }
}

// ---------------------------------------------------------------- 4. 类型（可选）

let tscRan = false;
let tscBin = null;
try {
  tscBin = require.resolve("typescript/bin/tsc");
} catch {
  tscBin = null;
}
if (tscBin) {
  // tsconfig 放在仓库里的临时目录：include 是相对 tsconfig 解析的，放在系统临时目录就得
  // 写成绝对路径，而绝对路径的 include 在不同 tsc 版本里行为不一致。.tmp/ 已被 gitignore。
  const tmp = path.join(ROOT, ".tmp", "tsc");
  mkdirSync(tmp, { recursive: true });
  const configPath = path.join(tmp, "tsconfig.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          noEmit: true,
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: false,
          skipLibCheck: true,
        },
        include: ["../../src/**/*.js"],
      },
      null,
      2,
    ),
  );
  try {
    execFileSync(process.execPath, [tscBin, "--noEmit", "-p", configPath], { cwd: ROOT, stdio: "pipe" });
    tscRan = true;
  } catch (error) {
    const out = String((error.stdout && error.stdout.toString()) || error.message).trim();
    if (out) fail("类型检查（tsc --checkJs）报告问题：\n" + out.split("\n").slice(0, 20).join("\n"));
    else tscRan = true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  notes.push("tsc: 未运行（仓库未依赖 TypeScript）");
}

// ---------------------------------------------------------------- 结论

for (const n of notes) console.log("[check-type] " + n);
if (problems.length) {
  console.error("[check-type] 发现 " + problems.length + " 个问题：");
  for (const p of problems) console.error("  · " + p);
  process.exit(1);
}
console.log(
  "[check-type] 通过：" +
    sourceFiles.length +
    " 个源文件（语法 + import 解析）、manifest.json、类型检查(" +
    (tscRan ? "tsc" : "skipped") +
    ")。",
);
