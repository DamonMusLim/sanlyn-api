import { due, money, statusOf } from "./recon-board-helpers.js";

const CATEGORIES = new Set(["product", "logistics", "all"]);
const STATUSES = new Set(["unpaid", "paid", "all"]);

export function clean(v) {
  return String(v ?? "").trim();
}

function round2(v) {
  const n = Number(v || 0);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function filters(req) {
  const status = clean(req.query?.status || "all").toLowerCase();
  const category = clean(req.query?.category || "all").toLowerCase();
  return {
    status: STATUSES.has(status) ? status : "all",
    category: CATEGORIES.has(category) ? category : "all",
  };
}

export async function fetchStatementRows(pool, scopeCode) {
  const sql = `
WITH selected_orders AS (
  SELECT o.*
    FROM orders o
   WHERE o.deleted_at IS NULL
     AND COALESCE(o.status, '') <> 'cancelled'
     AND o.company_code = $1
),
order_payments AS (
  SELECT so.order_no, so.contract_no,
         COALESCE(SUM(COALESCE(fp.this_amount, fp.amount)) FILTER (WHERE COALESCE(fp.direction,'') NOT IN ('out','refund')), 0) AS prepaid
    FROM selected_orders so
    LEFT JOIN finance_payments fp ON (
      (so.contract_no IS NOT NULL AND fp.contract_no = so.contract_no)
      OR (so.order_no IS NOT NULL AND fp.order_no = so.order_no)
    )
   GROUP BY so.order_no, so.contract_no
),
order_items AS (
  SELECT so.id,
         COALESCE(NULLIF(li.declaration_name_en, ''), NULLIF(p.declaration_name_en, ''), NULLIF(p.bl_description, ''), NULLIF(li.declaration_name, ''), NULLIF(li.product_name, ''), NULLIF(p.product_name, ''), '货款') AS item_desc
    FROM selected_orders so
    LEFT JOIN LATERAL (
      SELECT oli.product_name, oli.product_id, oli.sku, oli.declaration_name, oli.declaration_name_en
        FROM order_line_items oli
       WHERE oli.order_id = so.id
       ORDER BY oli.sort_order NULLS LAST, oli.id ASC
       LIMIT 1
    ) li ON true
    LEFT JOIN products p ON p.id = li.product_id OR (li.product_id IS NULL AND p.sku = li.sku)
),
product_rows_base AS (
  SELECT so.id AS row_id, so.order_no, oi.item_desc, so.bl_no,
         COALESCE(so.etd, so.order_date, so.created_at) AS shipped_date,
         COALESCE(so.currency, 'CNY') AS currency,
         COALESCE(so.customer_total_amount, so.customer_amount, so.total_amount) AS amount,
         COALESCE(op.prepaid, 0) AS prepaid
    FROM selected_orders so
    LEFT JOIN order_payments op USING(order_no, contract_no)
    LEFT JOIN order_items oi ON oi.id = so.id
   WHERE COALESCE(so.customer_total_amount, so.customer_amount, so.total_amount, 0) > 0
),
product_rows AS (
  SELECT
    MIN(pb.order_no) AS order_no,
    'product'::text AS category,
    CASE WHEN COUNT(*) > 1 THEN string_agg(DISTINCT pb.item_desc, ' / ') ELSE MAX(pb.item_desc) END AS item_desc,
    pb.bl_no,
    MAX(pb.shipped_date) AS shipped_date,
    pb.currency,
    SUM(pb.amount) AS amount,
    SUM(pb.prepaid) AS prepaid,
    'trade'::text AS payee_key,
    array_agg(pb.order_no ORDER BY pb.order_no) AS order_nos,
    jsonb_agg(jsonb_build_object('order_no', pb.order_no, 'item_desc', pb.item_desc, 'amount', pb.amount) ORDER BY pb.order_no) AS details,
    (COUNT(*) > 1) AS is_group
    FROM product_rows_base pb
   GROUP BY CASE WHEN pb.bl_no IS NOT NULL THEN pb.bl_no ELSE pb.row_id::text END, pb.bl_no, pb.currency
),
logistics_rows AS (
  SELECT COALESCE(sp.order_nos[1], sp.contract_no, b.bl_no) AS order_no,
         'logistics'::text AS category,
         COALESCE(NULLIF(b.cost_category, ''), '运费') AS item_desc,
         b.bl_no,
         COALESCE(sp.atd, sp.etd, sp.created_at, b.updated_at) AS shipped_date,
         COALESCE(b.currency_norm, b.currency, 'CNY') AS currency,
         b.sale_amount AS amount,
         COALESCE(b.ar_paid_amount, 0) AS prepaid,
         'forwarder'::text AS payee_key,
         NULL::text[] AS order_nos,
         NULL::jsonb AS details,
         false AS is_group
    FROM active_freight_supplier_bills b
    LEFT JOIN shipping_plans sp ON sp.bl_no = b.bl_no OR sp.hbl_no = b.bl_no OR sp._id = b.link_plan_id
   WHERE b.payer_company_code = $1
     AND COALESCE(b.sale_amount, 0) > 0
)
SELECT * FROM product_rows
UNION ALL
SELECT * FROM logistics_rows
ORDER BY shipped_date DESC NULLS LAST, order_no NULLS LAST, category`;
  const r = await pool.query(sql, [scopeCode]);
  return r.rows.map(publicRow);
}

function publicRow(row) {
  const amount = money(row.amount) || 0;
  const prepaid = money(row.prepaid) || 0;
  return {
    order_no: row.order_no || null,
    category: row.category,
    item_desc: row.item_desc || (row.category === "product" ? "货款" : "运费"),
    bl_no: row.bl_no || null,
    shipped_date: row.shipped_date || null,
    currency: row.currency || "CNY",
    amount,
    prepaid,
    due: due(amount, prepaid),
    status: statusOf(amount, prepaid),
    payee_key: row.payee_key,
    order_nos: row.order_nos || null,
    details: row.details || null,
    is_group: !!row.is_group,
  };
}

export function applyStatementFilters(rows, f) {
  let out = rows;
  if (f.category !== "all") out = out.filter((r) => r.category === f.category);
  if (f.status !== "all") {
    out = out.filter((r) => f.status === "paid" ? r.status === "paid" : r.status !== "paid");
  }
  return out;
}

export function buildSummary(rows) {
  const byCurrency = {};
  const orders = new Set(rows.flatMap((r) => (r.order_nos && r.order_nos.length ? r.order_nos : [r.order_no])).filter(Boolean));
  for (const row of rows) {
    const cur = row.currency || "CNY";
    if (!byCurrency[cur]) byCurrency[cur] = { outstanding: 0, paid: 0, receivable_total: 0, order_count: 0 };
    byCurrency[cur].outstanding += Number(row.due || 0);
    byCurrency[cur].paid += Number(row.prepaid || 0);
    byCurrency[cur].receivable_total += Number(row.amount || 0);
  }
  for (const bucket of Object.values(byCurrency)) {
    bucket.outstanding = round2(bucket.outstanding);
    bucket.paid = round2(bucket.paid);
    bucket.receivable_total = round2(bucket.receivable_total);
    bucket.order_count = orders.size;
  }
  return byCurrency;
}

// Reused tables/functions: orders, finance_payments, active_freight_supplier_bills,
// shipping_plans, order_line_items/products labels, recon-board money/due/statusOf.
// Claude review fixes: p.name_en(不存在)->bl_description/declaration_name_en; direction='in'->COALESCE NOT IN(空串陷阱铁律).
// 2026-07-17: product_rows aggregated by bl_no (merge same-B/L multi-order lines); order_nos/details/is_group added for frontend expand.
// item_desc now prefers declaration_name_en (IV/PL goods category, e.g. "CAT LITTER") over full product_name.
// Final line count after this edit: 163.
