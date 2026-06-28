#!/usr/bin/env node
// preflight-imports.mjs — 部署/重启前的"坏导入"体检（只盯 server.js 真实挂载的路由）
//
// 背景：2026-06-22 New Order 买方下拉全空，根因是 order-create-v2.js 一个潜伏的坏导入
// （import 不存在的 recalcOrderPricing），ESM 加载即失败 → 该路由每次 500。这类问题只在
// "模块被加载"时暴露，可能潜伏到一次重启才爆。
//
// 本脚本解析 server.js 里所有 () => import("./...") 动态挂载路径，逐个预加载。任何
// "缺导出 / 文件不存在 / 缺依赖 / 语法错误" 立即报出，退出码 1（可挡部署）。
// 只报静态导入错误（部署期可发现的）；运行期错误（DB/env）忽略——那不是坏导入。
//
// 用法：node preflight-imports.mjs

import { readFileSync } from "node:fs";

// 兜底：个别被挂载的 migrate-* 脚本在模块顶层就连库，DB/DNS 失败会冒成
// unhandledRejection 把进程打挂。这里吞掉运行期 reject——我们只关心"坏导入"。
process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});

const STATIC_ERR = /does not provide an export|Cannot find module|Unexpected|Invalid or unexpected|SyntaxError|Cannot find package/;
// migrate/seed 等一次性脚本即便被 server.js 挂载，import 即连库，不是路由坏导入，跳过。
const SKIP = /\/(migrate|seed)-/;

let src;
try {
  src = readFileSync("server.js", "utf8");
} catch {
  console.error("❌ 找不到 server.js（请在 /opt/sanlyn-api-test 下运行）");
  process.exit(2);
}

const re = /import\(\s*["'](\.\/[^"']+)["']\s*\)/g;
const paths = [...new Set([...src.matchAll(re)].map(m => m[1]))].filter(p => !SKIP.test(p));

let bad = 0;
const fails = [];
for (const p of paths) {
  try {
    await import(p);
  } catch (e) {
    const msg = String(e && e.message || e).split("\n")[0];
    if (STATIC_ERR.test(msg)) { bad++; fails.push(p + "  ->  " + msg); }
  }
}

console.log("server.js 真实挂载路由数=" + paths.length + "  坏导入=" + bad);
if (bad) {
  console.error("\n❌ 坏导入体检失败：部署前必须确认这些路由：");
  for (const x of fails) console.error("   " + x);
  process.exit(1);
} else {
  console.log("✅ 所有挂载路由可正常加载，生产无潜伏坏导入");
  process.exit(0);
}
