// api/db/ciq-no.js
// 单一窗口报检申请号 per order_no
// GET  /api/db/ciq-no?order_no=X           → { order_no, ciq_application_no, requires_ciq }
// PATCH /api/db/ciq-no { order_no, ciq_application_no } → save
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!["admin", "finance", "logistics"].includes(req.user?.role)) {
    return res.status(403).json({ error: "无权限" });
  }

  const pool = getPool();
  // 自动建列(幂等)
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ciq_application_no TEXT`).catch(() => {});

  if (req.method === "GET") {
    const { order_no } = req.query;
    if (!order_no) return res.status(400).json({ error: "order_no required" });
    const r = await pool.query(
      `SELECT o.order_no, o.ciq_application_no,
              COALESCE(f.requires_ciq, false) AS requires_ciq
       FROM orders o
       LEFT JOIN factories f ON f.name = o.raw->>'factory'
       WHERE o.order_no = $1
       LIMIT 1`,
      [order_no]
    );
    const row = r.rows[0] || {};
    return res.json({
      order_no,
      ciq_application_no: row.ciq_application_no || "",
      requires_ciq: row.requires_ciq || false,
    });
  }

  if (req.method === "PATCH") {
    const { order_no, ciq_application_no } = req.body || {};
    if (!order_no) return res.status(400).json({ error: "order_no required" });
    await pool.query(
      "UPDATE orders SET ciq_application_no = $1, updated_at = now() WHERE order_no = $2",
      [ciq_application_no || null, order_no]
    );
    return res.json({ success: true, order_no, ciq_application_no });
  }

  return res.status(405).end();
}
