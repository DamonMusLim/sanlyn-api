// ═══════════════════════════════════════════════════════════════
// orders-recompute.js
// POST /api/db/orders-recompute        — recompute one order
// POST /api/db/orders-recompute-all    — recompute all 86 orders
//
// Computes totals from raw.products and writes back to orders columns.
// raw.products item fields used:
//   qty, cbm, netWeight, grossWeight, factoryPrice, subtotal
// ═══════════════════════════════════════════════════════════════
import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../../.env.local", import.meta.url) });

const pool = new pg.Pool({
  host:     process.env.DB_HOST     || "127.0.0.1",
  port:     parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME     || "sanlyn_db",
  user:     process.env.DB_USER     || "sanlyn_admin",
  password: process.env.DB_PASSWORD || "Snlnb7f92c74d6fbaa8b97b0379b",
  max: 5,
});

// ── Core computation (mirrors formulaEngine.js FORMULAS.orders) ──
function computeOrder(order) {
  const products = Array.isArray(order.raw?.products) ? order.raw.products : [];

  const sum  = (fn) => products.reduce((s, p) => s + (Number(fn(p)) || 0), 0);

  const total_qty           = sum(p => p.qty);
  const total_cbm           = sum(p => p.cbm);
  const gross_weight        = sum(p => p.grossWeight);
  const net_weight          = sum(p => p.netWeight);
  const factory_amount      = sum(p => (Number(p.factoryPrice) || 0) * (Number(p.qty) || 0));
  const customer_amount     = sum(p => p.subtotal);
  const margin_amount       = customer_amount - factory_amount;
  const margin_pct          = factory_amount > 0
    ? Math.round((margin_amount / factory_amount) * 10000) / 100
    : 0;

  // Suggested container: 1×40HQ per 28 CBM
  const suggested_container = total_cbm <= 0
    ? null
    : total_cbm <= 28
      ? "1×40HQ"
      : `${Math.ceil(total_cbm / 28)}×40HQ`;

  return {
    total_qty:        Math.round(total_qty),
    total_cbm:        Math.round(total_cbm * 1e6) / 1e6,
    gross_weight:     Math.round(gross_weight * 1e4) / 1e4,
    net_weight:       Math.round(net_weight  * 1e4) / 1e4,
    factory_amount:   Math.round(factory_amount  * 100) / 100,
    customer_amount:  Math.round(customer_amount * 100) / 100,
    margin_amount:    Math.round(margin_amount   * 100) / 100,
    margin_pct:       Math.round(margin_pct * 100) / 100,
    suggested_container,
  };
}

async function recomputeOne(client, orderId) {
  const { rows } = await client.query(
    "SELECT id, raw FROM orders WHERE id = $1",
    [orderId]
  );
  if (!rows.length) throw new Error(`Order ${orderId} not found`);
  const order   = rows[0];
  const c       = computeOrder(order);

  // Write back — also persist suggested_container into raw.computed
  await client.query(
    `UPDATE orders SET
       total_qty       = $2,
       total_cbm       = $3,
       gross_weight    = $4,
       net_weight      = $5,
       factory_amount  = $6,
       customer_amount = $7,
       margin_amount   = $8,
       margin_pct      = $9,
       raw             = jsonb_set(
                           COALESCE(raw, '{}'),
                           '{computed}',
                           $10::jsonb
                         ),
       updated_at      = now()
     WHERE id = $1`,
    [
      orderId,
      c.total_qty,
      c.total_cbm,
      c.gross_weight,
      c.net_weight,
      c.factory_amount,
      c.customer_amount,
      c.margin_amount,
      c.margin_pct,
      JSON.stringify({ suggested_container: c.suggested_container }),
    ]
  );
  return { id: orderId, ...c };
}

export default async function handler(req, res) {
  const url = req.url || "";

  // ── POST /api/db/orders-recompute-all ──────────────────────
  if (url.includes("orders-recompute-all")) {
    if (req.method !== "POST") return res.writeHead(405).end("Method Not Allowed");
    const client = await pool.connect();
    let ok = 0, fail = 0, errors = [];
    try {
      const { rows } = await client.query(
        "SELECT id FROM orders WHERE raw->'products' IS NOT NULL ORDER BY id"
      );
      for (const { id } of rows) {
        try { await recomputeOne(client, id); ok++; }
        catch (e) { fail++; errors.push({ id, err: e.message }); }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok, fail, total: rows.length, errors }));
    } finally { client.release(); }
    return;
  }

  // ── POST /api/db/orders-recompute ─────────────────────────
  if (req.method !== "POST") return res.writeHead(405).end("Method Not Allowed");

  let body = "";
  for await (const chunk of req) body += chunk;
  const { id } = JSON.parse(body || "{}");
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "id required" }));
  }

  const client = await pool.connect();
  try {
    const result = await recomputeOne(client, id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, computed: result }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  } finally { client.release(); }
}


// Named export so order-create-v2.js can recompute order pricing right after
// inserting line items. recalcOrderPricing(poolOrClient, orderId) — a pg Pool
// works as a client here (pool.query exists). Reuses recomputeOne (no duplication).
export async function recalcOrderPricing(poolOrClient, orderId) {
  return recomputeOne(poolOrClient, orderId);
}
