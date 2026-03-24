// sanlyn-api/api/db/doc-auth.js
// 单证授权 API
// GET  /api/db/doc-auth?order=FS20260206024           → 查询该订单的授权状态
// POST /api/db/doc-auth { orderId, docType, action }   → 授权/撤销
//   action: "grant" | "revoke"
//   docType: "IV" | "customs_dec" | "origin_cert" | "release_note" 等
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // GET: 查询授权状态
  if (req.method === "GET") {
    const { order } = req.query;
    if (!order) return res.status(400).json({ error: "order required" });

    try {
      const result = await pool.query(
        `SELECT raw->'docPermissions' as perms FROM orders WHERE contract_no = $1`,
        [order]
      );
      const perms = result.rows[0]?.perms || {};
      return res.status(200).json({ orderId: order, permissions: perms });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST: 授权/撤销
  if (req.method === "POST") {
    const { orderId, docType, action } = req.body;
    if (!orderId || !docType || !["grant", "revoke"].includes(action)) {
      return res.status(400).json({ error: "orderId, docType, action(grant|revoke) required" });
    }

    try {
      // 用 jsonb_set 更新 raw.docPermissions.{docType}
      const granted = action === "grant";
      const now = new Date().toISOString();
      const permValue = granted
        ? JSON.stringify({ granted: true, grantedAt: now })
        : JSON.stringify({ granted: false, revokedAt: now });

      await pool.query(`
        UPDATE orders
        SET raw = jsonb_set(
          COALESCE(raw, '{}'::jsonb),
          '{docPermissions,${docType}}',
          $1::jsonb,
          true
        ),
        updated_at = NOW()
        WHERE contract_no = $2
      `, [permValue, orderId]);

      return res.status(200).json({
        success: true,
        orderId,
        docType,
        action,
        message: `${docType} ${action}ed for ${orderId}`,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "GET or POST only" });
}
