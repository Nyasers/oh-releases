// 验证工具返回值形状：宿主只把 content 交给模型，形状不对等于空调用。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(here, "..", "src", "app.js");
const source = readFileSync(appPath, "utf8");

// 从源码里取出 toolResult 的实现，单独求值（它不依赖运行时状态）。
const match = source.match(/const toolResult = \(payload\) => \(\{[\s\S]*?\n  \}\);/);
if (!match) {
  console.error("FAIL: 没在 src/app.js 里找到 toolResult");
  process.exit(1);
}
const toolResult = vm.runInNewContext(
  "(" + match[0].replace(/^const toolResult = /, "").replace(/;\s*$/, "") + ")",
);

const payload = { ok: true, total: 2, items: [{ tag: "v1.5.118-beta", version: "1.5.118-beta" }] };
const result = toolResult(payload);

const checks = [];
checks.push(["返回对象", typeof result === "object" && result !== null]);
checks.push(["有 content 数组", Array.isArray(result.content)]);
checks.push(["content 非空", (result.content || []).length > 0]);
checks.push(["首项 type=text", result.content?.[0]?.type === "text"]);
checks.push(["首项 text 是字符串", typeof result.content?.[0]?.text === "string"]);
checks.push(["text 能解析回业务对象", (() => {
  try { return JSON.parse(result.content[0].text).total === 2; } catch { return false; }
})()]);
checks.push(["details 保留原对象", result.details === payload]);
checks.push(["details 字段完整", result.details?.items?.[0]?.tag === "v1.5.118-beta"]);

let failed = 0;
console.log("=== 工具返回值形状断言 ===");
for (const [name, ok] of checks) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name);
  if (!ok) failed++;
}
console.log("");
console.log("=== 汇总 ===");
console.log("断言 " + checks.length + " 条，通过 " + (checks.length - failed) + "，失败 " + failed);
if (failed) process.exit(1);
console.log("形状与宿主 bundle/index.js 的 `content: k.content` 消费方式对齐");
