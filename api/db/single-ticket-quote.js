// GET /api/db/single-ticket-quote — 单票报价只读工作台
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const PLAN_COLS = ["id", "_id", "shipment_no", "bl_no", "order_nos", "contract_nos", "pol", "pod", "carrier_code", "forwarder_cn", "container_type", "container_qty", "etd", "customer", "customer_cn", "customer_en", "company_code", "freight_sale_usd", "freight_sale_cny", "customs_cost_total", "trucking_cost_total", "insurance_required"];
const OLI_COLS = ["id", "order_id", "product_name", "sku", "qty_ctn", "qty_pcs", "gw_kg", "nw_kg", "cbm", "factory_price", "factory_subtotal", "currency"];
const RATE_COLS = ["id", "pol", "pod", "carrier", "forwarder", "route_code", "via", "terminal", "transit_days", "next_sailing", "free_days_base", "free_days_ext", "customer_gp20", "customer_hq40", "status", "remarks"];

function clean(v, max = 160) {
  return String(v ?? "").trim().slice(0, max);
}

function day(v) {
  return v ? String(v).slice(0, 10) : null;
}

function pct(filled, total) {
  if (!total) return null;
  return Math.round((Number(filled || 0) * 1000) / Number(total)) / 10;
}

function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

async function columns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function selectList(cols, wanted) {
  return wanted.filter((c) => cols.has(c)).map((c) => `"${c}"`).join(", ");
}

function coverage(row, names) {
  const fields = names.map((name) => ({ name, filled: hasValue(row?.[name]) ? 1 : 0, total: 1 }));
  const filled = fields.reduce((s, f) => s + f.filled, 0);
  return { filled, total: fields.length, fill_rate: pct(filled, fields.length), fields };
}

async function loadPlan(pool, planCols, query) {
  const q = clean(query.q || query.key || query.bl_no || query.order_no || query.shipment_no);
  if (!q) return { error: "q required" };
  const conds = [];
  const vals = [q];
  if (planCols.has("id")) conds.push(`id::text=$1`);
  if (planCols.has("_id")) conds.push(`_id::text=$1`);
  if (planCols.has("bl_no")) conds.push(`bl_no=$1`);
  if (planCols.has("shipment_no")) conds.push(`shipment_no=$1`);
  if (planCols.has("order_nos")) conds.push(`$1 = ANY(order_nos)`);
  if (planCols.has("contract_nos")) conds.push(`$1 = ANY(contract_nos)`);
  if (!conds.length) return { error: "shipping_plans key fields not connected" };
  const select = selectList(planCols, PLAN_COLS);
  const deleted = planCols.has("deleted_at") ? "AND deleted_at IS NULL" : "";
  const r = await pool.query(
    `SELECT ${select} FROM shipping_plans
      WHERE (${conds.join(" OR ")}) ${deleted}
      ORDER BY ${planCols.has("id") ? "id" : "1"} DESC LIMIT 1`,
    vals
  );
  return r.rows[0] || null;
}

async function loadOrderIds(pool, orderCols, plan) {
  if (!orderCols.has("id") || !orderCols.has("order_no")) return [];
  const nos = []
    .concat(Array.isArray(plan.order_nos) ? plan.order_nos : [])
    .concat(Array.isArray(plan.contract_nos) ? plan.contract_nos : [])
    .filter(Boolean);
  if (!nos.length) return [];
  const r = await pool.query(`SELECT id FROM orders WHERE order_no = ANY($1::text[])`, [nos]);
  return r.rows.map((x) => x.id).filter(Boolean);
}

async function loadLineItems(pool, oliCols, orderIds) {
  if (!oliCols.has("order_id") || !orderIds.length) return [];
  const select = selectList(oliCols, OLI_COLS);
  const r = await pool.query(
    `SELECT ${select} FROM order_line_items
      WHERE order_id = ANY($1::int[])
      ORDER BY ${oliCols.has("id") ? "id" : "1"} LIMIT 300`,
    [orderIds]
  );
  return r.rows;
}

async function loadRates(pool, rateCols, plan) {
  if (!rateCols.has("pol") || !rateCols.has("pod")) return [];
  const pol = clean(plan.pol);
  const pod = clean(plan.pod);
  if (!pol || !pod) return [];
  const select = selectList(rateCols, RATE_COLS);
  const conds = ["pol=$1", "pod=$2"];
  const vals = [pol, pod];
  if (rateCols.has("status")) conds.push("COALESCE(status,'active')='active'");
  if (rateCols.has("next_sailing")) conds.push("(next_sailing IS NULL OR next_sailing::date >= CURRENT_DATE)");
  if (rateCols.has("carrier") && plan.carrier_code) {
    vals.push(plan.carrier_code);
    conds.push(`(carrier IS NULL OR carrier=$${vals.length})`);
  }
  const order = rateCols.has("id") ? "id DESC" : "1";
  const r = await pool.query(
    `SELECT ${select} FROM freight_rates WHERE ${conds.join(" AND ")}
      ORDER BY ${rateCols.has("next_sailing") ? "next_sailing NULLS LAST," : ""} ${order} LIMIT 20`,
    vals
  );
  return r.rows;
}

function priceState(plan, rates) {
  const fields = ["freight_sale_usd", "freight_sale_cny", "customs_cost_total", "trucking_cost_total"];
  return {
    plan_fields: fields.map((name) => ({
      name,
      value: hasValue(plan?.[name]) ? plan[name] : null,
      state: hasValue(plan?.[name]) ? "ready" : "unset",
    })),
    freight_rate_matches: rates.map((r) => ({
      id: r.id,
      carrier: r.carrier || null,
      forwarder: r.forwarder || null,
      route_code: r.route_code || null,
      via: r.via || null,
      terminal: r.terminal || null,
      transit_days: r.transit_days ?? null,
      next_sailing: day(r.next_sailing),
      free_days_base: r.free_days_base ?? null,
      free_days_ext: r.free_days_ext ?? null,
      customer_gp20: r.customer_gp20 ?? null,
      customer_hq40: r.customer_hq40 ?? null,
      remarks: r.remarks || null,
    })),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    const [planCols, orderCols, oliCols, rateCols] = await Promise.all([
      columns(pool, "shipping_plans"),
      columns(pool, "orders"),
      columns(pool, "order_line_items"),
      columns(pool, "freight_rates"),
    ]);
    if (!planCols.size) return res.status(200).json({ success: true, state: "not_connected", missing: "shipping_plans", fill_rate: null, data: null });
    const plan = await loadPlan(pool, planCols, req.query || {});
    if (plan?.error) return res.status(400).json({ success: false, error: plan.error });
    if (!plan) return res.status(404).json({ success: false, error: "未接入 · 缺匹配 shipping_plans 记录，当前填充率 未接入。" });
    const orderIds = await loadOrderIds(pool, orderCols, plan);
    const [items, rates] = await Promise.all([
      loadLineItems(pool, oliCols, orderIds),
      loadRates(pool, rateCols, plan),
    ]);
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      state: "ready",
      coverage: {
        ticket: coverage(plan, PLAN_COLS.filter((c) => planCols.has(c))),
        line_items: { rows: items.length, fields: OLI_COLS.filter((c) => oliCols.has(c)), fill_rate: items.length ? 100 : null },
        rates: { rows: rates.length, fields: RATE_COLS.filter((c) => rateCols.has(c)), fill_rate: rates.length ? 100 : null },
      },
      data: { plan, order_ids: orderIds, line_items: items, quote: priceState(plan, rates) },
    });
  } catch (err) {
    console.error("[single-ticket-quote]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
