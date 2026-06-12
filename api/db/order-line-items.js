// /api/db/order-line-items.js — Order product line items sub-table
// GET  ?order_id=xxx              → all line items for an order
// POST                            → add a line item (price auto-derived from products.sale_price_cny)
// PATCH ?id=xxx                   → update a line item (warns if unit_price deviates from master)
// DELETE ?id=xxx                  → remove a line item
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

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

// Enrich from products master — includes sale_price_cny and factory_price
async function enrichFromMaster(pool, sku) {
  if (!sku) return {};
  try {
    var r = await pool.query(
      `SELECT id AS product_id, sku, product_name, barcode, brand,
              net_weight AS nw_ctn, gross_weight AS gw_ctn, cbm AS cbm_ctn,
              carton_qty AS bg_bx, spec AS size,
              hs_code, declaration_name, bl_description,
              sale_price_cny, factory_price,
              vat_rate, rebate_rate AS tax_rebate_rate
       FROM products WHERE sku = $1 AND active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [sku.trim()]
    );
    return r.rows[0] || {};
  } catch (e) { return {}; }
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

    var master = await enrichFromMaster(pool, b.sku);

    // unit_price = sale_price_cny（每件/罐）× bg_bx（每箱件数）= 每箱单价
    // sale_price_cny 是每罐/件价，unit 是 CTN，必须乘以每箱件数才是正确单价。
    // DG/代购 orders have no SKU → fall back to provided value.
    var masterSalePrice = master.sale_price_cny ? parseFloat(master.sale_price_cny) : null;
    var masterBgBx      = parseInt(b.bg_bx || master.bg_bx) || 1;
    var providedPrice   = parseFloat(b.unit_price) || 0;
    var unitPrice       = masterSalePrice !== null
      ? parseFloat((masterSalePrice * masterBgBx).toFixed(4))
      : providedPrice;

    // factory_price: from products.factory_price (per-piece × bg_bx gives per-CTN cost)
    var masterFactoryPrice = master.factory_price ? parseFloat(master.factory_price) : null;
    var factoryPrice       = masterFactoryPrice !== null ? masterFactoryPrice
                           : (parseFloat(b.factory_price) || parseFloat(b.unit_price) || 0);

    var qtyCtn   = parseFloat(b.qty_ctn) || 0;
    var subtotal = parseFloat((unitPrice * qtyCtn).toFixed(2));

    var row = {
      order_id:       parseInt(b.order_id),
      sku:            b.sku            || master.sku            || null,
      product_id:     b.product_id     || master.product_id     || null,
      barcode:        b.barcode        || master.barcode         || null,
      product_name:   b.product_name   || master.product_name   || null,
      brand:          b.brand          || master.brand           || null,
      bg_bx:          parseInt(b.bg_bx || master.bg_bx) || null,
      qty_ctn:        qtyCtn,
      unit:           b.unit           || "CTN",
      unit_price:     unitPrice,
      factory_price:  factoryPrice,
      subtotal:       parseFloat(b.subtotal) || subtotal,
      factory_subtotal: parseFloat(b.factory_subtotal) || null,
      nw_ctn:         parseFloat(b.nw_ctn  || master.nw_ctn)  || null,
      gw_ctn:         parseFloat(b.gw_ctn  || master.gw_ctn)  || null,
      cbm_ctn:        parseFloat(b.cbm_ctn || master.cbm_ctn) || null,
      size:           b.size            || master.size          || null,
      hs_code:        b.hs_code         || master.hs_code       || null,
      declaration_name: b.declaration_name || master.declaration_name || null,
      bl_description: b.bl_description  || master.bl_description || null,
      vat_rate:       parseFloat(b.vat_rate        || master.vat_rate)        || null,
      tax_rebate_rate: parseFloat(b.tax_rebate_rate || master.tax_rebate_rate) || null,
      declare_amount_per_box: parseFloat(b.declare_amount_per_box) || null,
      sort_order:     parseInt(b.sort_order) || 0,
    };

    // Attach price_source so frontend knows where the price came from
    var priceSource = masterSalePrice !== null ? "master" : "manual";

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
      return res.status(200).json({ ok: true, data: ins.rows[0], price_source: priceSource });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH ──
  if (req.method === "PATCH") {
    var id = parseInt(req.query.id);
    if (!id) return res.status(400).json({ error: "id required" });
    var b = req.body || {};

    // If unit_price is being patched and SKU is known, warn if it deviates from master
    var priceWarning = null;
    if (b.unit_price !== undefined && b.sku) {
      var master = await enrichFromMaster(pool, b.sku);
      if (master.sale_price_cny) {
        var mp = parseFloat(master.sale_price_cny);
        var up = parseFloat(b.unit_price);
        if (Math.abs(up - mp) > 0.01) {
          priceWarning = {
            sku: b.sku,
            unit_price: up,
            master_price: mp,
            diff: parseFloat((up - mp).toFixed(4)),
            diff_pct: parseFloat(((up - mp) / mp * 100).toFixed(2)),
            message: `单价 ${up} 与产品表 ${mp} 不符，偏差 ${((up - mp) / mp * 100).toFixed(2)}%`,
          };
        }
      }
    }

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
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    sets.push("updated_at = NOW()");
    vals.push(id);

    try {
      var upd = await pool.query(
        "UPDATE order_line_items SET " + sets.join(", ") + " WHERE id = $" + i + " RETURNING *",
        vals
      );
      if (!upd.rows.length) return res.status(404).json({ error: "Not found" });
      var resp = { ok: true, data: upd.rows[0] };
      if (priceWarning) resp.price_warning = priceWarning;
      return res.status(200).json(resp);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE ──
  if (req.method === "DELETE") {
    var id = parseInt(req.query.id);
    if (!id) return res.status(400).json({ error: "id required" });
    try {
      await pool.query("DELETE FROM order_line_items WHERE id = $1", [id]);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
