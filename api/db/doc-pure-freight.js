import { SELLER, copyBtn, docShell, fmtDate, fmtMoney, loadShippingPlan, numberToRMB, pick } from "./doc-pure-fee-common.js";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function loadCustomer(pool, plan) {
  if (plan.customer_company_id) {
    const r = await pool.query(
      "SELECT name_cn,name_en,tax_id FROM companies WHERE id=$1 LIMIT 1",
      [plan.customer_company_id]
    );
    if (r.rows[0]) return r.rows[0];
  }
  return {
    name_cn: pick(plan.customer_cn, plan.customer, plan.customer_en),
    name_en: pick(plan.customer_en, plan.customer, plan.customer_cn),
    tax_id: "",
  };
}

function usdWords(amount) {
  return "USD " + Number(amount || 0).toFixed(2);
}

export async function renderPureFreightDoc(pool, id) {
  const plan = await loadShippingPlan(pool, id);
  if (!plan) return null;
  const blNo = pick(plan.bl_no, id);
  const billR = await pool.query(
    `SELECT bl_no,cost_category,sale_amount,currency,qty,unit_price
       FROM active_freight_supplier_bills
      WHERE bl_no=$1
        AND (cost_category ~* '海运|ocean|freight')
        AND COALESCE(sale_amount,0)>0
      ORDER BY id`,
    [blNo]
  );
  const customer = await loadCustomer(pool, plan);
  const lines = billR.rows.map((r) => {
    const qty = num(r.qty) || 1;
    const amount = num(r.sale_amount);
    return {
      item: "海运费 / Ocean Freight",
      qty,
      unit: qty ? Math.round((amount / qty + Number.EPSILON) * 100) / 100 : amount,
      amount,
      currency: String(r.currency || "USD").toUpperCase(),
    };
  });
  const totals = lines.reduce((m, r) => {
    m[r.currency] = (m[r.currency] || 0) + r.amount;
    return m;
  }, {});
  const mainCurrency = Object.keys(totals)[0] || "USD";
  const mainTotal = totals[mainCurrency] || 0;
  const body = `
    <div class="top"><div class="seller"><h2>${copyBtn(SELLER.name, "销方")}</h2><p>税号: ${copyBtn(SELLER.tax_id, "销方税号")}</p></div><div class="title"><h1>海运费账单</h1><p>OCEAN FREIGHT DEBIT NOTE</p></div></div>
    <div class="grid">
      <div class="box"><div class="label">销方 / Seller</div><div class="field"><b>名称</b>${copyBtn(SELLER.name, "销方名称")}</div><div class="field"><b>税号</b>${copyBtn(SELLER.tax_id, "销方税号")}</div></div>
      <div class="box"><div class="label">买方 / Bill To</div><div class="field"><b>名称</b>${copyBtn(pick(customer.name_cn, customer.name_en), "买方名称")}</div>${customer.tax_id ? `<div class="field"><b>税号</b>${copyBtn(customer.tax_id, "买方税号")}</div>` : ""}</div>
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
    <table><thead><tr><th>No.</th><th>项目 / Description</th><th class="tc">数量 Qty</th><th class="tr">单价 Unit</th><th class="tr">金额 Amount</th><th class="tc">币种</th></tr></thead><tbody>
      ${lines.map((r, i) => `<tr><td>${String(i + 1).padStart(2, "0")}</td><td>${copyBtn(r.item, "项目")}</td><td class="tc">${copyBtn(r.qty, "数量")}</td><td class="tr">${copyBtn(fmtMoney(r.unit, r.currency), "单价")}</td><td class="tr">${copyBtn(fmtMoney(r.amount, r.currency), "金额")}</td><td class="tc">${copyBtn(r.currency, "币种")}</td></tr>`).join("") || `<tr><td colspan="6" class="tc muted">未找到海运费销售金额</td></tr>`}
    </tbody><tfoot>
      ${Object.keys(totals).map((ccy) => `<tr class="total"><td colspan="4" class="tr">合计 Total</td><td class="tr">${copyBtn(fmtMoney(totals[ccy], ccy), "合计")}</td><td class="tc">${copyBtn(ccy, "币种")}</td></tr>`).join("")}
    </tfoot></table>
    <div class="box"><div class="label">金额大写 / Amount in Words</div>${copyBtn(mainCurrency === "CNY" ? numberToRMB(mainTotal) : usdWords(mainTotal), "金额大写")}</div>
    <div class="note"><b>备注 / Banking Information</b><br>收款方: ${copyBtn(SELLER.name, "收款方")}<br>开户行: ${copyBtn(SELLER.bank, "开户行")}<br>账号: ${copyBtn(SELLER.acct, "账号")}</div>
    <div class="sign"><div>客户确认 / Client Confirmation</div><div>销方确认 / Seller</div></div>`;
  return docShell("海运费账单", body);
}
