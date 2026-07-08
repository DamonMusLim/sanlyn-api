// /api/db/finished-goods.js — Finished goods inventory CRUD
import { getPool, setCors } from "./db.js";

function parseLimit(v, fallback = 500) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : fallback;
}

async function getProduct(pool, { product_id, sku }) {
  if (product_id) {
    const r = await pool.query(
      "SELECT id, sku, unit, factory_code FROM products WHERE id=$1",
      [product_id]
    );
    return r.rows[0];
  }
  if (sku) {
    const r = await pool.query(
      "SELECT id, sku, unit, factory_code FROM products WHERE sku=$1",
      [sku]
    );
    return r.rows[0];
  }
  return null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  if (req.method === "GET") {
    try {
      const { sku, warehouse_id, low_stock, factory_code, limit = 500 } = req.query;
      const params = [], conds = [];
      let q = `
        SELECT f.*, p.product_name, p.product_name_cn, w.code AS warehouse_code, w.name AS warehouse_name
        FROM finished_goods_inventory f
        LEFT JOIN products p ON p.id = f.product_id
        LEFT JOIN warehouses w ON w.id = f.warehouse_id`;
      if (sku) { params.push(`%${sku}%`); conds.push(`f.sku ILIKE $${params.length}`); }
      if (warehouse_id) { params.push(warehouse_id); conds.push(`f.warehouse_id = $${params.length}`); }
      if (factory_code) { params.push(factory_code); conds.push(`f.factory_code = $${params.length}`); }
      if (low_stock === "1") conds.push("f.current_stock <= f.safety_stock");
      if (conds.length) q += " WHERE " + conds.join(" AND ");
      params.push(parseLimit(limit));
      q += ` ORDER BY f.sku ASC, f.warehouse_id ASC LIMIT $${params.length}`;
      const r = await pool.query(q, params);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const b = req.body || {};
      const product = await getProduct(pool, b);
      if (!product) return res.status(400).json({ success: false, error: "valid product_id or sku required" });
      const warehouseId = b.warehouse_id || 1;
      const r = await pool.query(
        `INSERT INTO finished_goods_inventory
          (product_id, sku, unit, current_stock, safety_stock, factory_code, warehouse_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          product.id,
          b.sku || product.sku,
          b.unit || product.unit || null,
          b.current_stock || 0,
          b.safety_stock || 0,
          b.factory_code || product.factory_code || null,
          warehouseId
        ]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: "id required" });
      const allowed = ["product_id","sku","unit","current_stock","safety_stock","factory_code","warehouse_id","last_move_at"];
      const setClauses = [], params = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!allowed.includes(k)) continue;
        params.push(v);
        setClauses.push(`${k} = $${params.length}`);
      }
      if (!setClauses.length) return res.status(400).json({ success: false, error: "no valid fields" });
      setClauses.push("updated_at = NOW()");
      params.push(id);
      const r = await pool.query(
        `UPDATE finished_goods_inventory SET ${setClauses.join(", ")}
         WHERE id=$${params.length} RETURNING *`,
        params
      );
      if (!r.rows.length) return res.status(404).json({ success: false, error: "Inventory not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      const id = req.query.id || req.body?.id;
      if (!id) return res.status(400).json({ success: false, error: "id required" });
      await pool.query("DELETE FROM finished_goods_inventory WHERE id=$1", [id]);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
