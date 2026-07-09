// /api/db/finished-goods-move.js — Finished goods in/out/adjust operation
import { getPool, setCors } from "./db.js";

function makeRefId() {
  return "fg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

async function lockInventory(client, b) {
  if (b.inventory_id) {
    const r = await client.query("SELECT * FROM finished_goods_inventory WHERE id=$1 FOR UPDATE", [b.inventory_id]);
    return r.rows[0];
  }
  const warehouseId = b.warehouse_id || 1;
  let r = await client.query(
    "SELECT * FROM finished_goods_inventory WHERE sku=$1 AND warehouse_id=$2 FOR UPDATE",
    [b.sku, warehouseId]
  );
  if (r.rows.length) return r.rows[0];

  const p = await client.query(
    "SELECT id, sku, unit, factory_code FROM products WHERE id=$1 OR sku=$2 ORDER BY id LIMIT 1",
    [b.product_id || 0, b.sku || ""]
  );
  if (!p.rows.length) return null;
  const product = p.rows[0];
  await client.query(
    `INSERT INTO finished_goods_inventory(product_id, sku, unit, current_stock, safety_stock, factory_code, warehouse_id)
     VALUES($1,$2,$3,0,0,$4,$5)
     ON CONFLICT (sku, warehouse_id) DO NOTHING`,
    [product.id, b.sku || product.sku, b.unit || product.unit || null, b.factory_code || product.factory_code || null, warehouseId]
  );
  r = await client.query(
    "SELECT * FROM finished_goods_inventory WHERE sku=$1 AND warehouse_id=$2 FOR UPDATE",
    [b.sku || product.sku, warehouseId]
  );
  return r.rows[0];
}

async function findExistingLog(client, { refType, refId, sku, warehouseId }) {
  if (!refType || !refId) return null;
  const r = await client.query(
    `SELECT * FROM inventory_logs
     WHERE ref_type=$1 AND ref_id=$2 AND sku=$3 AND warehouse_id=$4`,
    [refType, refId, sku, warehouseId]
  );
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  const pool = getPool();
  const b = req.body || {};
  if (!b.type) {
    return res.status(400).json({ success: false, error: "type required" });
  }
  if (!["in","out","adjust"].includes(b.type)) {
    return res.status(400).json({ success: false, error: "type must be: in/out/adjust" });
  }
  const hasTargetStock = b.type === "adjust" && b.target_stock !== undefined;
  if (b.quantity === undefined && !hasTargetStock) {
    return res.status(400).json({ success: false, error: "quantity required" });
  }
  if (!b.inventory_id && !b.sku && !b.product_id) {
    return res.status(400).json({ success: false, error: "inventory_id or sku/product_id required" });
  }
  const inputQty = Number(b.quantity);
  if (!hasTargetStock && (!Number.isFinite(inputQty) || inputQty === 0)) {
    return res.status(400).json({ success: false, error: "quantity must be non-zero number" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inv = await lockInventory(client, b);
    if (!inv) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Inventory or product not found" }); }

    const refType = b.ref_type || "manual";
    const refId = b.ref_id === undefined ? makeRefId() : b.ref_id;
    const existingLog = await findExistingLog(client, {
      refType,
      refId,
      sku: inv.sku,
      warehouseId: inv.warehouse_id
    });
    if (existingLog) {
      await client.query("COMMIT");
      return res.status(200).json({ success: true, data: existingLog, after_stock: existingLog.after_stock, idempotent: true });
    }

    const before = Number(inv.current_stock);
    const qtyAbs = Math.abs(inputQty);
    const targetStock = Number(b.target_stock);
    if (hasTargetStock && !Number.isFinite(targetStock)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, error: "target_stock must be number" });
    }
    const signedQty = b.type === "in" ? qtyAbs : b.type === "out" ? -qtyAbs : hasTargetStock ? targetStock - before : inputQty;
    if (signedQty === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, error: "quantity must be non-zero number" });
    }
    const after = before + signedQty;
    if (after < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, error: `Insufficient stock: ${before} available` });
    }

    await client.query(
      `UPDATE finished_goods_inventory
       SET current_stock=$1, last_move_at=NOW(), updated_at=NOW()
       WHERE id=$2`,
      [after, inv.id]
    );
    const log = await client.query(
      `INSERT INTO inventory_logs
        (product_id, sku, type, quantity, unit, before_stock, after_stock, ref_type,
         ref_id, warehouse_id, factory_code, delivery_date, note, "operator")
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        inv.product_id, inv.sku, b.type, signedQty, b.unit || inv.unit || null,
        before, after, refType, refId,
        inv.warehouse_id, b.factory_code || inv.factory_code || null,
        b.delivery_date || null, b.note || b.notes || null, b.operator || null
      ]
    );
    await client.query("COMMIT");
    return res.status(200).json({ success: true, data: log.rows[0], after_stock: after });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
}
