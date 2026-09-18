import crypto from "crypto";

function clean(v, max = 500) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function jsonObj(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v) || {}; } catch (_) { return {}; }
}

export function fingerprintSnapshot(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(snapshot || {})).digest("hex");
}

export async function getCustomerBillFxRate(db, issueDate) {
  const r = await db.query(
    `SELECT rate FROM exchange_rates
      WHERE currency_pair='USD_CNY' AND fetched_at::date <= $1::date
      ORDER BY fetched_at DESC LIMIT 1`,
    [issueDate]
  );
  const base = r.rows.length ? Number(r.rows[0].rate) : 7;
  return Math.round((base + 0.1) * 10000) / 10000;
}

export function buildCustomerBillSnapshot({ bill, plan, lines }) {
  const rows = (lines || []).map(r => {
    const qty = r.qty == null || r.qty === "" ? 1 : Number(r.qty);
    const sale = money(r.sale_amount);
    const unit = r.unit_price == null || r.unit_price === "" ? (qty ? money(sale / qty) : sale) : money(r.unit_price);
    return {
      id: clean(r.id, 80),
      fee_name: clean(r.cost_category, 160),
      basis: clean(r.charge_basis || "", 80),
      currency: clean(r.currency || "CNY", 10).toUpperCase(),
      qty,
      unit_price: unit,
      amount: sale,
    };
  });
  const totalUsd = money(rows.filter(r => r.currency === "USD").reduce((s, r) => s + r.amount, 0));
  const totalCnyLines = rows.filter(r => r.currency !== "USD").reduce((s, r) => s + r.amount, 0);
  const fx = Number(bill.fx_rate || 0);
  const totalCny = money(totalCnyLines + totalUsd * fx);
  return {
    version: "v2026.09.18-1",
    doc_type: bill.doc_type,
    doc_no: bill.doc_no,
    issue_date: bill.issue_date,
    fx_rate: fx,
    bl_no: clean(bill.bl_no || plan?.bl_no, 80),
    payer_company_code: clean(bill.payer_company_code, 80),
    vessel_voyage: [plan?.vessel, plan?.voyage].filter(Boolean).join(" / "),
    pol: clean(plan?.pol, 80),
    pod: clean(plan?.pod, 80),
    totals: { USD: totalUsd, CNY: totalCny },
    lines: rows,
  };
}

export async function getLockedCustomerBill(db, bl, docType, payer) {
  const args = [clean(bl, 120), clean(docType, 40)];
  const where = ["bl_no=$1", "doc_type=$2", "status IN ('confirmed','sent')"];
  if (clean(payer, 80)) { args.push(clean(payer, 80)); where.push(`payer_company_code=$${args.length}`); }
  const r = await db.query(
    `SELECT * FROM customer_bills
      WHERE ${where.join(" AND ")}
      ORDER BY (status='confirmed') DESC, seq DESC, id DESC LIMIT 1`,
    args
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { ...row, snapshot: jsonObj(row.snapshot) };
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(v) {
  return money(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderLockedCustomerBillHtml(locked) {
  const s = jsonObj(locked?.snapshot);
  const rows = Array.isArray(s.lines) ? s.lines : [];
  const title = s.doc_type === "fob_portcharge" ? "Port Charge Statement" : s.doc_type === "exw_invoice" ? "EXW Full-Charge Invoice" : "Freight Invoice";
  const body = rows.map(r => `<tr><td>${esc(r.fee_name)}</td><td>${esc(r.basis)}</td><td>${esc(r.currency)}</td><td class="c">${esc(r.qty)}</td><td class="r">${fmt(r.unit_price)}</td><td class="r">${fmt(r.amount)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - ${esc(s.doc_no)}</title><style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#eee;margin:0;padding:24px;color:#111}.page{max-width:190mm;margin:auto;background:white;padding:12mm}
h1{font-size:22px;margin:0 0 4px}.meta{display:grid;grid-template-columns:120px 1fr 120px 1fr;border:1px solid #ddd;margin:16px 0;font-size:12px}.meta div{padding:7px;border-right:1px solid #eee;border-bottom:1px solid #eee}.k{background:#f7f7f7;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ddd;padding:7px}th{background:#f7f7f7}.c{text-align:center}.r{text-align:right}.tot{margin-top:14px;text-align:right;font-weight:800}
</style></head><body><div class="page"><h1>${esc(title)}</h1><div>${esc(s.doc_no || "")}</div>
<div class="meta"><div class="k">B/L No.</div><div>${esc(s.bl_no)}</div><div class="k">Issue Date</div><div>${esc(s.issue_date)}</div><div class="k">Vessel/Voyage</div><div>${esc(s.vessel_voyage)}</div><div class="k">FX Rate</div><div>${esc(s.fx_rate)}</div><div class="k">POL</div><div>${esc(s.pol)}</div><div class="k">POD</div><div>${esc(s.pod)}</div></div>
<table><thead><tr><th>Charge</th><th>Basis</th><th>Cur</th><th>Qty</th><th>Unit</th><th>Amount</th></tr></thead><tbody>${body}</tbody></table>
<div class="tot">Total USD: ${fmt(s.totals?.USD)} &nbsp;&nbsp; Total CNY: ${fmt(s.totals?.CNY)}</div></div></body></html>`;
}
