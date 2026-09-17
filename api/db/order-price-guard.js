// api/db/order-price-guard.js
// 五价铁律的守卫。纯函数，无 IO、无依赖。
//
// 为什么单独成文件：order-create-v2.js 已 1620 行，铁律「新功能不许继续往超标文件里堆」。
// 为什么判据只有一处：2026-09-17 codex 第一版把「有没有价」写成了三套写法，
//   其中 `x == null ? null : parseFloat(x)` 挡不住空串 —— parseFloat("") = NaN，
//   NaN 喂 numeric 列要么报错要么写脏值。判据必须只有 hasPositiveNumber 这一个。

// 「有价」= 有限的正数。空串/null/undefined/0/负数/NaN 一律算「没填」。
// 🔴 0 和「没填」是两件事，别让静默兜底把没填的说成有。
export function hasPositiveNumber(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  var n = Number(value);
  return Number.isFinite(n) && n > 0;
}

// 判调用方是不是 agent（阿丹 / task-runner / 其它模型）。
// ⛔ 不许把「source 为空」判成 agent —— order-create-v2.js 对空 source 的既定默认是
//    admin_panel，admin 前台两个建单调用点(OrderCreateV3/V4)实测不带 source，
//    判成 agent 会当场打瘫前台。
// 库里历史 agent 来源实测：order-intake / order-intake-LL23 / claude-order-intake / agent-order。
export function isAgentCaller(req) {
  var headers = (req && req.headers) || {};
  var headerValue = headers["x-sanlyn-agent"];
  if (Array.isArray(headerValue)) {
    if (headerValue.some(function (v) { return String(v || "").trim(); })) return true;
  } else if (String(headerValue || "").trim()) {
    return true;
  }
  var source = String((req && req.body && req.body.source) || "");
  return /^(agent|claude|order-intake|minimax|task-runner)/i.test(source);
}

function lineSku(p, idx) {
  return String(
    (p && (p.sku || p.code || p.barcode || p.product_code || p.name)) ||
    ("line_" + (idx + 1))
  );
}

function missingEntry(p, idx, field) {
  var label = field === "customer_amount" ? "客户成交价" : "工厂含税价";
  return {
    sku: lineSku(p, idx),
    field: field,
    message: label + "缺失或不是大于 0 的数字",
  };
}

// 逐行查两个价。⛔ 任何一方都不许回落到另一方，也不许用数量/小计反推。
export function checkFivePrices(products) {
  var blocked = [];
  if (!Array.isArray(products)) return { blocked: blocked, warnings: [] };

  products.forEach(function (p, idx) {
    p = p || {};
    var customerAmount = p.unitPrice;
    if (!hasPositiveNumber(customerAmount)) customerAmount = p.unit_price;
    if (!hasPositiveNumber(customerAmount)) customerAmount = p.price;
    var factoryAmount = p.factoryPrice;
    if (!hasPositiveNumber(factoryAmount)) factoryAmount = p.factory_price;

    if (!hasPositiveNumber(customerAmount)) blocked.push(missingEntry(p, idx, "customer_amount"));
    if (!hasPositiveNumber(factoryAmount))  blocked.push(missingEntry(p, idx, "factory_amount"));
  });

  return { blocked: blocked, warnings: blocked.slice() };
}
