#!/usr/bin/env node
/**
 * OLI 金额外泄检查 —— Damon 07-14 硬规3、0817 重申「我们靠的是真实数据，不是OLI」
 *
 * ⚖️ 适用范围（v1/v2 我两次搞错，先扫出 245 条再 96 条，全是噪音）：
 *   这条铁律管的是【工厂开票对账 / 退税归集】这条链上的金额，不是全站禁用订单行。
 *   ✅ 允许：从订单行读 箱数/品名/SKU/规格/毛净重 —— 那本来就是订单数据
 *   ✅ 允许：declare_amount_per_box 用于【未报关票的报关输入】（另有 customs-declare-amount-guard 管）
 *   ⛔ 禁止：在协同/退税链把订单行的 金额/单价/小计 当成 应开、对账、申报的钱
 *   合法金额来源：人工锁定额 > factory_invoice_expected_amounts(报关口径) > 报关逐项合计 > null
 *
 * 用法  node tools/oli-lint.mjs [--list] [--all] [--root=/path]
 *       --all 扫全站（仅供体检，不用于 CI）
 * 豁免  该行或上一行  // OLI_INTERNAL_SCAN_ONLY
 */
import fs from "fs";
import path from "path";
const ROOT = process.argv.find(a => a.startsWith("--root="))?.slice(7) || "/opt/sanlyn-api-test";
const LIST = process.argv.includes("--list"), ALL = process.argv.includes("--all");

// 受管链路：工厂协同 / 开票 / 退税
const SCOPE_RE = /(customs-collab|factory-invoice|factory-portal|tax-rebate|invoice-collab)/;
const MONEY_FIELDS = ["factory_subtotal", "factory_price"];
const DERIVED = ["legacy_expected_amount", "factory_expected_value", "purchase_value"];
const SUBTOTAL_RE = /\b(SUM|sum)\s*\(\s*\w*\.?subtotal\b/;
const MONEY_CTX = /(SUM|COALESCE|ROUND|expected|amount|应开)/i;
const SKIP_RE = /(\.bak|node_modules|\/tools\/|\.test\.|\.spec\.)/;

function walk(d, out = []) { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const x of e) { const f = path.join(d, x.name); if (SKIP_RE.test(f)) continue;
    if (x.isDirectory()) walk(f, out); else if (/\.(js|mjs)$/.test(x.name)) out.push(f); } return out; }

const all = walk(path.join(ROOT, "api"));
const files = ALL ? all : all.filter(f => SCOPE_RE.test(f));
const violations = [], exempted = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8"); const lines = src.split("\n");
  if (!/res\.json\(|json\(res|module\.exports|export default|export (async )?function/.test(src)) continue;
  let inBlock = false;                       // 0817：多行块注释里的示例代码不算违规（v3 误报过我自己写的注释）
  lines.forEach((ln, i) => {
    const opens = (ln.match(/\/\*/g) || []).length, closes = (ln.match(/\*\//g) || []).length;
    const wasIn = inBlock;
    if (opens > closes) inBlock = true; else if (closes > opens) inBlock = false;
    if (wasIn || /^\s*(\/\/|\*|--)/.test(ln) || /^\s*\/\*/.test(ln)) return;
    let hit = DERIVED.find(d => ln.includes(d));
    if (!hit && MONEY_CTX.test(ln)) hit = MONEY_FIELDS.find(m => ln.includes(m));
    if (!hit && SUBTOTAL_RE.test(ln)) hit = "SUM(subtotal)";
    if (!hit) return;
    const rec = { file: f.replace(ROOT + "/", ""), line: i + 1, token: hit, text: ln.trim().slice(0, 100) };
    const prev = lines[i - 1] || "";
    (ln.includes("OLI_INTERNAL_SCAN_ONLY") || prev.includes("OLI_INTERNAL_SCAN_ONLY") ? exempted : violations).push(rec);
  });
}
if (LIST) { console.log("=== 已豁免（内部比对）==="); exempted.forEach(v => console.log(`  ${v.file}:${v.line} [${v.token}] ${v.text}`)); }
console.log(`范围:${ALL ? "全站体检" : "工厂协同/开票/退税链"} | 文件 ${files.length} | 🔴违规 ${violations.length} | 豁免 ${exempted.length}`);
if (violations.length) {
  console.log("\n🔴 OLI 金额外泄：");
  violations.forEach(v => console.log(`  ${v.file}:${v.line}  [${v.token}]\n      ${v.text}`));
  console.log("\n合法来源：人工锁定额 > factory_invoice_expected_amounts > 报关逐项合计 > null");
  console.log("确属内部比对 → 加  // OLI_INTERNAL_SCAN_ONLY");
}
process.exit(violations.length ? 1 : 0);
