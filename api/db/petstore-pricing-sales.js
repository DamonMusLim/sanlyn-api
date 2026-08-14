// 拆自 petstore-pricing.js(0814 主文件超500行铁律) — 昨日销售(按单分组)+库存变动问询
import { getPool } from "../db.js";

function json(res, code, data) { res.status(code).json(data); }
function audit(api, id, extra) { console.log(JSON.stringify({ ts: new Date().toISOString(), api, id, extra: extra ?? null })); }

function defaultShanghaiYesterday() {
  const d = new Date(Date.now() - 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseSalesDate(value) {
  const date = String(value || defaultShanghaiYesterday()).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

async function getDailySales(req, res) {
  const date = parseSalesDate(req.query?.date);
  if (!date) return json(res, 400, { success: false, error: "bad_date" });

  const pool = getPool();
  const { rows } = await pool.query(`
    WITH sales AS (
      SELECT
        product_code,
        product_name,
        spec,
        sum(-delta)::int AS sold_qty,
        min(stock_after)::int AS stock_now,
        count(*)::int AS tx_count,
        sum(case when order_channel::text = '0' then -delta else 0 end)::int AS online_qty
      FROM petstore_stock_ledger
      WHERE order_type = 'XS'
        AND delta < 0
        AND change_time::date = $1::date
      GROUP BY 1,2,3
    ),
    dna AS (
      SELECT DISTINCT ON (product_code)
        product_code,
        qty_30::int AS qty_30,
        days_of_supply,
        restock_verdict
      FROM petstore_sku_sales_dna
      ORDER BY product_code, as_of DESC
    )
    SELECT
      s.product_code,
      s.product_name,
      s.spec,
      s.sold_qty,
      s.stock_now,
      s.tx_count,
      s.online_qty,
      d.qty_30,
      d.days_of_supply,
      d.restock_verdict
    FROM sales s
    LEFT JOIN dna d ON d.product_code = s.product_code
    ORDER BY s.sold_qty DESC
  `, [date]);

  const { rows: orders } = await pool.query(`
    WITH sales_lines AS (
      SELECT
        COALESCE(NULLIF(order_no::text, ''), src_id::text) AS order_no,
        CASE WHEN order_channel::text = '0' THEN '外卖' ELSE '线下' END AS channel,
        change_time,
        product_code,
        product_name,
        spec,
        (-delta)::int AS qty,
        stock_after::int AS stock_after
      FROM petstore_stock_ledger
      WHERE order_type = 'XS'
        AND delta < 0
        AND change_time::date = $1::date
    ),
    dna AS (
      SELECT DISTINCT ON (product_code)
        product_code,
        restock_verdict
      FROM petstore_sku_sales_dna
      ORDER BY product_code, as_of DESC
    ),
    items AS (
      SELECT
        s.order_no,
        s.channel,
        s.product_code,
        s.product_name,
        s.spec,
        sum(s.qty)::int AS qty,
        min(s.stock_after)::int AS stock_after,
        max(d.restock_verdict) AS restock_verdict,
        min(s.change_time) AS first_time
      FROM sales_lines s
      LEFT JOIN dna d ON d.product_code = s.product_code
      GROUP BY 1,2,3,4,5
    ),
    order_groups AS (
      SELECT
        order_no,
        CASE WHEN bool_or(channel = '外卖') THEN '外卖' ELSE '线下' END AS channel,
        to_char(min(first_time), 'HH24:MI') AS time,
        count(*)::int AS item_kinds,
        sum(qty)::int AS total_qty,
        jsonb_agg(jsonb_build_object(
          'product_name', product_name,
          'spec', spec,
          'qty', qty,
          'stock_after', stock_after,
          'restock_verdict', restock_verdict
        ) ORDER BY product_name, spec) AS items
      FROM items
      GROUP BY order_no
    )
    SELECT
      order_no,
      channel,
      time,
      item_kinds,
      total_qty,
      items,
      (total_qty >= 8) AS bulk
    FROM order_groups
    ORDER BY time ASC, order_no ASC
  `, [date]);

  const { rows: adjustments } = await pool.query(`
    SELECT
      l.src_id,
      l.product_code,
      l.product_name,
      l.spec,
      l.order_type,
      l.stock_before,
      l.stock_after,
      l.delta,
      l.remark,
      l.change_time,
      n.reason AS noted_reason
    FROM petstore_stock_ledger l
    LEFT JOIN petstore_stock_notes n ON n.ledger_src_id = l.src_id::text
    WHERE l.order_type <> 'XS'
      AND l.change_time::date = $1::date
    ORDER BY l.change_time
  `, [date]);

  const adjustmentSummary = adjustments.reduce((acc, r) => ({
    count: acc.count + 1,
    total_delta: acc.total_delta + Number(r.delta || 0),
    unnoted_count: acc.unnoted_count + (r.noted_reason ? 0 : 1),
  }), { count: 0, total_delta: 0, unnoted_count: 0 });

  const summary = rows.reduce((acc, r) => ({
    sku_count: acc.sku_count + 1,
    total_qty: acc.total_qty + Number(r.sold_qty || 0),
    online_qty: acc.online_qty + Number(r.online_qty || 0),
  }), { sku_count: 0, total_qty: 0, online_qty: 0 });

  orders.forEach((o) => {
    summary.order_count = (summary.order_count || 0) + 1;
    if (o.channel === "外卖") {
      summary.online_order_count = (summary.online_order_count || 0) + 1;
      summary.online_order_qty = (summary.online_order_qty || 0) + Number(o.total_qty || 0);
    } else {
      summary.offline_order_count = (summary.offline_order_count || 0) + 1;
      summary.offline_order_qty = (summary.offline_order_qty || 0) + Number(o.total_qty || 0);
    }
  });
  summary.order_count = summary.order_count || 0;
  summary.online_order_count = summary.online_order_count || 0;
  summary.online_order_qty = summary.online_order_qty || 0;
  summary.offline_order_count = summary.offline_order_count || 0;
  summary.offline_order_qty = summary.offline_order_qty || 0;

  return json(res, 200, { success: true, date, rows, orders, summary, adjustments, adjustment_summary: adjustmentSummary });
}

async function postStockNote(req, res, bodyArg) {
  const body = bodyArg || {}; // 主文件恒传body;不跨文件兜底readBody
  const srcId = String(body.src_id || "").trim();
  const reason = String(body.reason || "").trim();
  if (!srcId || !reason) return json(res, 400, { success: false, error: "bad_request" });

  const result = await getPool().query(`
    INSERT INTO petstore_stock_notes (ledger_src_id, product_code, change_date, delta, reason)
    SELECT src_id::text, product_code, change_time::date, delta, $2
    FROM petstore_stock_ledger
    WHERE src_id::text = $1
    ON CONFLICT (ledger_src_id) DO UPDATE
    SET reason = excluded.reason,
        created_at = now()
    RETURNING *
  `, [srcId, reason]);

  if (!result.rows.length) return json(res, 404, { success: false, error: "ledger_not_found" });
  audit("/api/db/petstore-pricing", srcId, "stock_note", null);
  return json(res, 200, { success: true, row: result.rows[0] });
}

export { getDailySales, postStockNote };
