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
  if (!r.rows.length) return null;
  const base = Number(r.rows[0].rate);
  if (!Number.isFinite(base)) return null;
  return Math.round((base + 0.1) * 10000) / 10000;
}

export function buildCustomerBillSnapshot({ bill, plan, lines }) {
  const rows = (lines || []).map(r => {
    const rawQty = r.qty == null || r.qty === "" ? 1 : Number(r.qty);
    const qty = Number.isFinite(rawQty) && rawQty !== 0 ? rawQty : 1;
    const sale = money(r.sale_amount);
    return {
      id: clean(r.id, 80),
      fee_name: clean(r.cost_category, 160),
      basis: clean(r.charge_basis || "", 80),
      currency: clean(r.currency || "CNY", 10).toUpperCase(),
      qty,
      unit_price: money(sale / qty),
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
  if (!clean(payer, 80)) {
    const c = await db.query(
      `SELECT COUNT(DISTINCT payer_company_code) AS n FROM customer_bills
        WHERE bl_no=$1 AND doc_type=$2 AND status IN ('confirmed','sent')`,
      args
    );
    if (Number(c.rows[0]?.n) > 1) return null;
  }
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

export function applyLockedBill(ctx, locked) {
  const s = jsonObj(locked?.snapshot);
  const rows = Array.isArray(s.lines) ? s.lines : [];
  if (!locked || !rows.length) return ctx || {};
  return {
    ...(ctx || {}),
    locked_bill_id: locked.id,
    doc_no: s.doc_no || ctx?.doc_no,
    issue_date: s.issue_date || ctx?.issue_date,
    fx_rate: s.fx_rate == null ? ctx?.fx_rate : Number(s.fx_rate),
    rows: rows.map(r => ({
      id: r.id,
      cost_category: r.fee_name,
      charge_basis: r.basis,
      currency: r.currency,
      qty: r.qty,
      unit_price: r.unit_price,
      amount: r.amount,
      sale_amount: r.amount,
    })),
    totals: {
      USD: money(s.totals?.USD),
      CNY: money(s.totals?.CNY),
    },
  };
}
