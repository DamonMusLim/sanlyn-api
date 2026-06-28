// /api/db/packaging.js — Packaging materials inventory CRUD
import { getPool, setCors } from "./db.js";

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS packaging_materials (
  id             SERIAL PRIMARY KEY,
  sku_code       VARCHAR(64) UNIQUE NOT NULL,
  name           VARCHAR(255) NOT NULL,
  spec           VARCHAR(255),
  unit           VARCHAR(32) DEFAULT '个',
  current_stock  NUMERIC(12,2) DEFAULT 0,
  safety_stock   NUMERIC(12,2) DEFAULT 0,
  product_skus   JSONB DEFAULT '[]',
  supplier       VARCHAR(255),
  unit_cost      NUMERIC(12,4),
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS packaging_logs (
  id             SERIAL PRIMARY KEY,
  material_id    INT REFERENCES packaging_materials(id) ON DELETE CASCADE,
  type           VARCHAR(32) NOT NULL, -- 'in' | 'out' | 'transfer' | 'adjust'
  quantity       NUMERIC(12,2) NOT NULL,
  before_stock   NUMERIC(12,2),
  after_stock    NUMERIC(12,2),
  operator       VARCHAR(128),
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
`;

let inited = false;
async function ensureTable(pool) {
  if (inited) return;
  await pool.query(INIT_SQL);
  inited = true;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  await ensureTable(pool);

  // ── GET /api/db/packaging ──────────────────────────────────
  if (req.method === "GET") {
    try {
      const { sku, sku_code, low_stock, limit = 500 } = req.query;
      let q = "SELECT * FROM packaging_materials", params = [], conds = [];
      const skuVal = sku || sku_code;
      if (skuVal) { params.push(`%${skuVal}%`); conds.push(`sku_code ILIKE $${params.length}`); }
      if (low_stock === "1") conds.push("current_stock < safety_stock");
      if (conds.length) q += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      q += ` ORDER BY sku_code ASC LIMIT $${params.length}`;
      const r = await pool.query(q, params);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST /api/db/packaging ─────────────────────────────────
  if (req.method === "POST") {
    try {
      const { sku_code, name, spec, unit, current_stock, safety_stock, product_skus, supplier, unit_cost, notes } = req.body || {};
      if (!sku_code || !name) return res.status(400).json({ success: false, error: "sku_code and name required" });
      const r = await pool.query(
        `INSERT INTO packaging_materials(sku_code,name,spec,unit,current_stock,safety_stock,product_skus,supplier,unit_cost,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [sku_code, name, spec||null, unit||"个",
         current_stock||0, safety_stock||0,
         JSON.stringify(product_skus||[]),
         supplier||null, unit_cost||null, notes||null]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── PATCH /api/db/packaging ────────────────────────────────
  if (req.method === "PATCH") {
    try {
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: "id required" });
      const allowed = ["name","spec","unit","current_stock","safety_stock","product_skus","supplier","unit_cost","notes"];
      const setClauses = [], params = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!allowed.includes(k)) continue;
        params.push(k === "product_skus" ? JSON.stringify(v) : v);
        setClauses.push(`${k} = $${params.length}`);
      }
      if (!setClauses.length) return res.status(400).json({ success: false, error: "no valid fields" });
      params.push(new Date().toISOString());
      setClauses.push(`updated_at = $${params.length}`);
      params.push(id);
      const r = await pool.query(
        `UPDATE packaging_materials SET ${setClauses.join(",")} WHERE id=$${params.length} RETURNING *`,
        params
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── DELETE /api/db/packaging ───────────────────────────────
  if (req.method === "DELETE") {
    try {
      const id = req.query.id || req.body?.id;
      if (!id) return res.status(400).json({ success: false, error: "id required" });
      await pool.query("DELETE FROM packaging_materials WHERE id=$1", [id]);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
