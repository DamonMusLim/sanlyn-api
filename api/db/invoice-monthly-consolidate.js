import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { ACCOUNTS, SELLER_BANK, clean, loadCompany, loadSeller, money } from "./invoice-collab-confirm.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);
const BILL_MONTH_COLUMN = "bill_month";
const ITEM_NAME = "*经纪代理服务*港杂费";

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function validMonth(v) {
  const s = clean(v, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : "";
}

function displayCompany(row, code) {
  return {
    code: row?.code || code || "",
    name: row?.name_cn || row?.name_en || row?.factory_name || "",
    tax_id: row?.tax_id || "",
  };
}

function lineAmount(row) {
  return row.sale_amount !== null && row.sale_amount !== undefined && String(row.sale_amount) !== ""
    ? row.sale_amount
    : row.amount;
}

function invoiceRemark(currency, month, blCount) {
  const acct = ACCOUNTS[currency] || ACCOUNTS.CNY;
  const acctLabel = currency === "USD" ? "美金账号" : "人民币账号";
  return `开户行 ${SELLER_BANK} · ${acctLabel} ${acct} · ${month} 本月${blCount}票合并,多提单见明细`;
}

function buildGroups(rows) {
  const map = new Map();
  for (const row of rows) {
    const bl = clean(row.bl_no || "未填提单号", 80);
    if (!map.has(bl)) {
      map.set(bl, { bl_no: bl, shipment_no: row.shipment_no || "", lines: [], subtotal: {} });
    }
    const group = map.get(bl);
    const currency = clean(row.currency || "CNY", 8).toUpperCase();
    const amount = money(lineAmount(row));
    group.lines.push({
      cost_category: clean(row.cost_category || "港杂费", 80),
      unit_price: money(row.unit_price),
      qty: money(row.qty || 1) || 1,
      amount,
      currency,
    });
    group.subtotal[currency] = money((group.subtotal[currency] || 0) + amount);
  }
  return [...map.values()];
}

function buildCombined(rows, groups, month) {
  const totals = new Map();
  for (const row of rows) {
    const currency = clean(row.currency || "CNY", 8).toUpperCase();
    totals.set(currency, money((totals.get(currency) || 0) + money(lineAmount(row))));
  }
  const blCount = groups.length;
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => {
    const exTax = money(total / 1.01);
    return {
      currency,
      total_with_tax: total,
      amount_ex_tax: exTax,
      tax_amount: money(total - exTax),
      item_name: ITEM_NAME,
      unit: "项",
      qty: blCount || 1,
      tax_rate: 0.01,
      remark: invoiceRemark(currency, month, blCount),
    };
  });
}

async function fetchRows(pool, payerCode, month) {
  const r = await pool.query(
    `SELECT b.bl_no, b.cost_category, b.amount, b.sale_amount, b.currency,
            b.unit_price, b.qty, b.charge_basis, b.payer_company_code,
            sp.shipment_no
       FROM active_freight_supplier_bills b
       LEFT JOIN LATERAL (
         SELECT shipment_no
           FROM shipping_plans sp
          WHERE sp.bl_no = b.bl_no OR sp.hbl_no = b.bl_no
          ORDER BY sp.updated_at DESC NULLS LAST
          LIMIT 1
       ) sp ON TRUE
      WHERE b.payer_company_code = $1
        AND b.${BILL_MONTH_COLUMN} = $2
        AND (b.cost_category !~* '海运|ocean|freight')
        AND COALESCE(b.amount, 0) > 0
      ORDER BY b.bl_no NULLS LAST, b.id`,
    [payerCode, month]
  );
  return r.rows || [];
}

async function handleGet(req, res) {
  const payerInput = clean(req.query?.payer_code, 120);
  const month = validMonth(req.query?.month);
  if (!payerInput) return json(res, 400, { ok: false, error: "payer_code_required" });
  if (!month) return json(res, 400, { ok: false, error: "bad_month", message: "month must be YYYY-MM" });

  const pool = getPool();
  const payerRow = await loadCompany(pool, payerInput);
  const payerCode = payerRow?.code || clean(payerInput, 40);
  const [seller, rows] = await Promise.all([
    loadSeller(pool),
    fetchRows(pool, payerCode, month),
  ]);
  const groups = buildGroups(rows);
  const combined = buildCombined(rows, groups, month);
  return json(res, 200, {
    ok: true,
    date_column: BILL_MONTH_COLUMN,
    payer: displayCompany(payerRow, payerCode),
    seller,
    month,
    groups,
    combined,
    bl_count: groups.length,
    notice: groups.length ? "" : "该发货人该月暂无可合并港杂账单",
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    if (!requireAuth(req, res)) return;
    if (!FINANCE_ROLES.has(req.user?.role)) {
      return json(res, 403, { ok: false, error: "forbidden", message: "仅财务/管理员可访问" });
    }
    if (req.method === "GET") return handleGet(req, res);
    return json(res, 405, { ok: false, error: "method_not_allowed" });
  } catch (err) {
    console.error("[invoice-monthly-consolidate]", err);
    return json(res, 500, { ok: false, error: "internal_error", detail: err.message });
  }
}
