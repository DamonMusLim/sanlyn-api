// /api/db/packaging-move.js — 包材入库/出库/调拨操作
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  const pool = getPool();
  try {
    const { material_id, type, quantity, operator, notes } = req.body || {};
    if (!material_id || !type || !quantity) {
      return res.status(400).json({ success: false, error: "material_id, type, quantity required" });
    }
    if (!["in","out","transfer","adjust"].includes(type)) {
      return res.status(400).json({ success: false, error: "type must be: in/out/transfer/adjust" });
    }
    const qty = Number(quantity);
    if (isNaN(qty) || qty <= 0) return res.status(400).json({ success: false, error: "quantity must be positive number" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query("SELECT current_stock FROM packaging_materials WHERE id=$1 FOR UPDATE", [material_id]);
      if (!cur.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Material not found" }); }
      const before = Number(cur.rows[0].current_stock);
      const delta = (type === "in" || type === "adjust") ? qty : -qty;
      const after = before + delta;
      if (after < 0) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: `Insufficient stock: ${before} available` }); }
      await client.query("UPDATE packaging_materials SET current_stock=$1, updated_at=NOW() WHERE id=$2", [after, material_id]);
      const log = await client.query(
        `INSERT INTO packaging_logs(material_id,type,quantity,before_stock,after_stock,operator,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [material_id, type, qty, before, after, operator||null, notes||null]
      );
      await client.query("COMMIT");
      return res.status(200).json({ success: true, data: log.rows[0], after_stock: after });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
