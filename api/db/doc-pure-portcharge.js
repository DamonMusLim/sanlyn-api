import { SELLER, copyBtn, docShell, fmtDate, fmtMoney, loadShippingPlan, numberToRMB, pick } from "./doc-pure-fee-common.js";
import { issueDocNo, loadPortChargeIssue } from "./lib/portcharge-close-loop.js";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function loadFactory(pool, plan) {
  if (!plan.factory_company_id) return null;
  const r = await pool.query(
    "SELECT code,name_cn,name_en,tax_id FROM companies WHERE id=$1 LIMIT 1",
    [plan.factory_company_id]
  );
  return r.rows[0] || null;
}

function basisText(v) {
  const s = String(v || "").trim();
  if (!s) return "整票";
  if (/container|柜|cntr/i.test(s)) return "每柜";
  return s;
}

export async function renderPurePortChargeDoc(pool, id) {
  const plan = await loadShippingPlan(pool, id);
  if (!plan) return null;
  const blNo = pick(plan.bl_no, id);
  const pc = await loadPortChargeIssue(pool, plan, { containerQty: plan.container_qty });
  if (pc.needs_terms) {
    return docShell("港杂费对账单", `<div class="box"><div class="label">需要补齐贸易条款 / Terms Required</div><p>该票未填贸易条款，系统已停止生成标准费率兜底卡。</p></div>`);
  }
  if (pc.needs_payer_selection) {
    const opts = pc.payers.map(p => `<li>${copyBtn(p.payer_company_code, "付款方")} - ${fmtMoney(p.total_cny, "CNY")} (${p.line_count}项)</li>`).join("");
    return docShell("港杂费对账单", `<div class="box"><div class="label">需要选择付款方 / Payer Required</div><p>该票存在多个 payer_company_code, 系统已停止随机出单。</p><ul>${opts}</ul></div>`);
  }
  const payerCode = pc.factoryCode || null;
  const factory = payerCode
    ? (await pool.query('SELECT code,name_cn,name_en,tax_id FROM companies WHERE code=$1 LIMIT 1', [payerCode])).rows[0]
    : await loadFactory(pool, plan);
  const lines = pc.rows.map((r) => ({
    item: pick(r.cost_category, "港杂费"),
    basis: basisText(r.charge_basis),
    unit: r.unit_price == null ? null : num(r.unit_price),
    qty: r.qty == null ? null : num(r.qty),
    amount: num(r.sale_amount ?? r.amount),
    currency: String(r.currency || "CNY").toUpperCase(),
  }));
  const totalCny = lines.reduce((s, r) => s + (r.currency === "CNY" || r.currency === "RMB" ? r.amount : 0), 0);
  const docNo = await issueDocNo(pool, {
    prefix: "PC", seed: blNo || plan.shipment_no || plan.id, blNo,
    docType: "pure_portcharge", totalCny,
    snapshot: { plan_id: plan.id, payer_company_code: payerCode, charges: pc.rows, used_fallback_card: pc.usedFallbackCard },
  });
  const body = `
    <div class="top"><div class="seller"><h2>${copyBtn(SELLER.name, "销方")}</h2><p>税号: ${copyBtn(SELLER.tax_id, "销方税号")}</p></div><div class="title"><h1>港杂费对账单</h1><p>PORT CHARGES STATEMENT</p><p class="docno">No. ${copyBtn(docNo, "单号")}</p></div></div>
    <div class="grid">
      <div class="box"><div class="label">销方 / Seller</div><div class="field"><b>名称</b>${copyBtn(SELLER.name, "销方名称")}</div><div class="field"><b>税号</b>${copyBtn(SELLER.tax_id, "销方税号")}</div></div>
      <div class="box"><div class="label">付款方 / Payer</div><div class="field"><b>名称</b>${copyBtn(pick(factory && factory.name_cn, factory && factory.name_en, "工厂"), "付款方名称")}</div>${factory && factory.tax_id ? `<div class="field"><b>税号</b>${copyBtn(factory.tax_id, "付款方税号")}</div>` : ""}</div>
    </div>
    <div class="ship">
      <div><b>B/L No.</b>${copyBtn(blNo, "提单号")}</div>
      <div><b>POL</b>${copyBtn(pick(plan.pol, "-"), "起运港")}</div>
      <div><b>POD</b>${copyBtn(pick(plan.pod, "-"), "目的港")}</div>
      <div><b>ETD</b>${copyBtn(fmtDate(plan.etd || plan.shipment_date), "ETD")}</div>
      <div><b>Vessel/Voyage</b>${copyBtn([plan.vessel, plan.voyage].filter(Boolean).join(" / ") || "-", "船名航次")}</div>
      <div><b>Container Type</b>${copyBtn(pick(plan.container_type, "-"), "柜型")}</div>
      <div><b>Container Qty</b>${copyBtn(pick(plan.container_qty, "1"), "柜量")}</div>
      <div><b>Doc Date</b>${copyBtn(fmtDate(new Date()), "日期")}</div>
    </div>
    <table><thead><tr><th>No.</th><th>港杂项目 / Item</th><th class="tc">计费 Basis</th><th class="tr">单价 Unit</th><th class="tc">数量 Qty</th><th class="tr">金额 Amount</th><th class="tc">币种</th></tr></thead><tbody>
      ${lines.map((r, i) => `<tr><td>${String(i + 1).padStart(2, "0")}</td><td>${copyBtn(r.item, "项目")}</td><td class="tc">${copyBtn(r.basis, "计费")}</td><td class="tr">${r.unit == null ? "" : copyBtn(fmtMoney(r.unit, r.currency), "单价")}</td><td class="tc">${r.qty == null ? "" : copyBtn(r.qty, "数量")}</td><td class="tr">${copyBtn(fmtMoney(r.amount, r.currency), "金额")}</td><td class="tc">${copyBtn(r.currency, "币种")}</td></tr>`).join("") || `<tr><td colspan="7" class="tc muted">未找到工厂承担的港杂费</td></tr>`}
    </tbody><tfoot><tr class="total"><td colspan="5" class="tr">合计 Total</td><td class="tr">${copyBtn(fmtMoney(totalCny, "CNY"), "合计")}</td><td class="tc">${copyBtn("CNY", "币种")}</td></tr></tfoot></table>
    <div class="box"><div class="label">金额大写 / Amount in Words</div>${copyBtn(numberToRMB(totalCny), "金额大写")}</div>
    <div class="note"><b>备注 / Banking Information</b><br>收款方: ${copyBtn(SELLER.name, "收款方")}<br>开户行: ${copyBtn(SELLER.bank, "开户行")}<br>账号: ${copyBtn(SELLER.acct, "账号")}</div>
    <div class="sign"><div>工厂确认 / Factory Confirmation</div><div>销方确认 / Seller</div></div>`;
  return docShell("港杂费对账单", body);
}
