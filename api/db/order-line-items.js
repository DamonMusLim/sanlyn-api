// /api/db/order-line-items.js — Order product line items sub-table
// GET  ?order_id=xxx              → all line items for an order
// POST                            → add a line item (enrich from products master)
// PATCH ?id=xxx                   → update a line item
// DELETE ?id=xxx                  → remove a line item
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { syncOrderFromOLI } from "./order-sync-from-oli.js";

var ENSURE_TABLE = `
  CREATE TABLE IF NOT EXISTS order_line_items (
    id              SERIAL PRIMARY KEY,
    order_id        INTEGER NOT NULL,
    sku             TEXT,
    product_id      INTEGER,
    barcode         TEXT,
    product_name    TEXT,
    brand           TEXT,
    bg_bx           INTEGER,
    qty_ctn         NUMERIC(10,2),
    unit            TEXT DEFAULT 'CTN',
    unit_price      NUMERIC(14,4),
    factory_price   NUMERIC(14,4),
    subtotal        NUMERIC(14,2),
    factory_subtotal NUMERIC(14,2),
    nw_ctn          NUMERIC(10,4),
    gw_ctn          NUMERIC(10,4),
    cbm_ctn         NUMERIC(10,6),
    size            TEXT,
    hs_code         TEXT,
    declaration_name TEXT,
    bl_description  TEXT,
    vat_rate        NUMERIC(6,4),
    tax_rebate_rate NUMERIC(6,4),
    declare_amount_per_box NUMERIC(14,4),
    sort_order      INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS order_line_items_order_id_idx ON order_line_items(order_id);
`;

async function enrichFromMaster(pool, sku) {
  if (!sku) return {};
  try {
    var r = await pool.query(
      `SELECT id AS product_id, sku, product_name, barcode, brand,
              net_weight AS nw_ctn, gross_weight AS gw_ctn, cbm AS cbm_ctn,
              carton_qty AS bg_bx, spec AS size,
              hs_code, declaration_name, bl_description
       FROM products WHERE sku = $1 AND active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [sku.trim()]
    );
    return r.rows[0] || {};
  } catch (e) { return {}; }
}

async function syncOrderAfterMutation(pool, orderId) {
  if (!orderId) return null;
  try {
    return await syncOrderFromOLI(pool, orderId);
  } catch (e) {
    console.error("[order-line-items] syncOrderFromOLI failed", { orderId: orderId, error: e.message });
    return null;
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  var isAdmin = req.user && req.user.role === "admin";
  if (!isAdmin) return res.status(403).json({ error: "Admin only" });

  var pool = getPool();
  await pool.query(ENSURE_TABLE).catch(function() {});

  // ── GET ──
  if (req.method === "GET") {
    var orderId = parseInt(req.query.order_id);
    if (!orderId) return res.status(400).json({ error: "order_id required" });
    try {
      var r = await pool.query(
        "SELECT * FROM order_line_items WHERE order_id = $1 ORDER BY sort_order ASC, id ASC",
        [orderId]
      );
      return res.status(200).json({ data: r.rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST ──
  if (req.method === "POST") {
    var b = req.body || {};
    if (!b.order_id) return res.status(400).json({ error: "order_id required" });

    // Enrich from products master table by SKU
    var master = await enrichFromMaster(pool, b.sku);

    var row = {
      order_id:       parseInt(b.order_id),
      sku:            b.sku            || master.sku            || null,
      product_id:     b.product_id     || master.product_id     || null,
      barcode:        b.barcode        || master.barcode         || null,
      product_name:   b.product_name   || master.product_name   || null,
      brand:          b.brand          || master.brand           || null,
      bg_bx:          parseInt(b.bg_bx || master.bg_bx) || null,
      qty_ctn:        parseFloat(b.qty_ctn) || 0,
      unit:           b.unit           || "CTN",
      unit_price:     parseFloat(b.unit_price)     || 0,
      factory_price:  parseFloat(b.factory_price)  || parseFloat(b.unit_price) || 0,
      subtotal:       parseFloat(b.subtotal)        || (parseFloat(b.unit_price) * parseFloat(b.qty_ctn)) || 0,
      factory_subtotal: parseFloat(b.factory_subtotal) || null,
      nw_ctn:         parseFloat(b.nw_ctn  || master.nw_ctn)  || null,
      gw_ctn:         parseFloat(b.gw_ctn  || master.gw_ctn)  || null,
      cbm_ctn:        parseFloat(b.cbm_ctn || master.cbm_ctn) || null,
      size:           b.size            || master.size          || null,
      hs_code:        b.hs_code         || master.hs_code       || null,
      declaration_name: b.declaration_name || master.declaration_name || null,
      bl_description: b.bl_description  || master.bl_description || null,
      vat_rate:       parseFloat(b.vat_rate)        || null,
      tax_rebate_rate: parseFloat(b.tax_rebate_rate) || null,
      declare_amount_per_box: parseFloat(b.declare_amount_per_box) || null,
      sort_order:     parseInt(b.sort_order) || 0,
    };

    try {
      var ins = await pool.query(
        `INSERT INTO order_line_items
          (order_id, sku, product_id, barcode, product_name, brand,
           bg_bx, qty_ctn, unit, unit_price, factory_price,
           subtotal, factory_subtotal, nw_ctn, gw_ctn, cbm_ctn, size,
           hs_code, declaration_name, bl_description,
           vat_rate, tax_rebate_rate, declare_amount_per_box, sort_order)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING *`,
        [
          row.order_id, row.sku, row.product_id, row.barcode, row.product_name, row.brand,
          row.bg_bx, row.qty_ctn, row.unit, row.unit_price, row.factory_price,
          row.subtotal, row.factory_subtotal, row.nw_ctn, row.gw_ctn, row.cbm_ctn, row.size,
          row.hs_code, row.declaration_name, row.bl_description,
          row.vat_rate, row.tax_rebate_rate, row.declare_amount_per_box, row.sort_order,
        ]
      );
      await syncOrderAfterMutation(pool, ins.rows[0].order_id);
      return res.status(200).json({ ok: true, data: ins.rows[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH ──
  if (req.method === "PATCH") {
    var id = parseInt(req.query.id);
    if (!id) return res.status(400).json({ error: "id required" });
    var b = req.body || {};

    var sets = [], vals = [], i = 1;
    var fields = [
      "sku","product_id","barcode","product_name","brand",
      "bg_bx","qty_ctn","unit","unit_price","factory_price",
      "subtotal","factory_subtotal","nw_ctn","gw_ctn","cbm_ctn","size",
      "hs_code","declaration_name","bl_description",
      "vat_rate","tax_rebate_rate","declare_amount_per_box","sort_order",
    ];
    fields.forEach(function(f) {
      if (b[f] !== undefined) {
        sets.push(f + " = $" + i);
        vals.push(b[f]);
        i++;
      }
    });
    if ((b.qty_ctn !== undefined || b.unit_price !== undefined) && b.subtotal === undefined) {
      sets.push(
        "subtotal = ROUND((CASE WHEN $" + i + " THEN $" + (i + 1) + "::numeric ELSE qty_ctn END) * (CASE WHEN $" + (i + 2) + " THEN $" + (i + 3) + "::numeric ELSE unit_price END), 2)"
      );
      vals.push(b.qty_ctn !== undefined, b.qty_ctn !== undefined ? b.qty_ctn : null, b.unit_price !== undefined, b.unit_price !== undefined ? b.unit_price : null);
      i += 4;
    }
    if ((b.qty_ctn !== undefined || b.factory_price !== undefined) && b.factory_subtotal === undefined) {
      sets.push(
        "factory_subtotal = ROUND((CASE WHEN $" + i + " THEN $" + (i + 1) + "::numeric ELSE qty_ctn END) * (CASE WHEN $" + (i + 2) + " THEN $" + (i + 3) + "::numeric ELSE factory_price END), 2)"
      );
      vals.push(b.qty_ctn !== undefined, b.qty_ctn !== undefined ? b.qty_ctn : null, b.factory_price !== undefined, b.factory_price !== undefined ? b.factory_price : null);
      i += 4;
    }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    sets.push("updated_at = NOW()");
    vals.push(id);

    try {
      var upd = await pool.query(
        "UPDATE order_line_items SET " + sets.join(", ") + " WHERE id = $" + i + " RETURNING *",
        vals
      );
      if (!upd.rows.length) return res.status(404).json({ error: "Not found" });
      await syncOrderAfterMutation(pool, upd.rows[0].order_id);
      return res.status(200).json({ ok: true, data: upd.rows[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE ──
  if (req.method === "DELETE") {
    var id = parseInt(req.query.id);
    if (!id) return res.status(400).json({ error: "id required" });
    try {
      var del = await pool.query("DELETE FROM order_line_items WHERE id = $1 RETURNING order_id", [id]);
      if (del.rows.length) await syncOrderAfterMutation(pool, del.rows[0].order_id);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
