// api/db/migrate-cleanup-test-orders.js
// ONE-SHOT: Delete 9 bogus test orders created 2026-05-12 (portal testing session)
// IDs 1153-1161, order_no LIKE 'ORD-20260512-%', created_at IS NULL, status='pending'
// Idempotent — safe to run multiple times (returns count=0 if already deleted)
// Admin-only POST.
// Usage: curl -X POST https://api.sanlyn.cn/api/db/migrate-cleanup-test-orders \
//          -H "Authorization: Bearer <ADMIN_JWT>"

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).end();

  const user = requireAuth(req, res);
  if (!user) return;
  if (user.role !== "admin") return res.status(403).json({ error: "admin only" });

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const pool = getPool();
  try {
    // Dry-run: show what would be deleted
    const preview = await pool.query(
      `SELECT id, order_no, status, created_at
       FROM orders
       WHERE (created_at IS NULL OR id BETWEEN 1153 AND 1161)
         AND order_no LIKE 'ORD-20260512-%'
       ORDER BY id`
    );

    if (req.query.dry === "1") {
      return res.json({
        success: true,
        dry_run: true,
        would_delete: preview.rows,
        count: preview.rows.length,
      });
    }

    // Delete
    const del = await pool.query(
      `DELETE FROM orders
       WHERE (created_at IS NULL OR id BETWEEN 1153 AND 1161)
         AND order_no LIKE 'ORD-20260512-%'
       RETURNING id, order_no`
    );

    return res.json({
      success: true,
      deleted: del.rows,
      count: del.rows.length,
    });
  } catch (err) {
    console.error("[migrate-cleanup-test-orders]", err);
    return res.status(500).json({ error: err.message });
  }
}
