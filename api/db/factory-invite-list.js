// factory-invite-list.js
// Admin endpoint: list invitations with filters.
//
// GET /api/db/factory-invite-list?status=pending&type=factory&limit=50

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "GET only" });

  if (!req.user || (req.user.role !== "admin" && req.user.role !== "super_admin")) {
    return res.status(403).json({ error: "admin only" });
  }

  var pool = getPool();
  var status = req.query.status || "";
  var type   = req.query.type   || "";
  var limit  = Math.min(parseInt(req.query.limit) || 50, 200);

  try {
    var where = ["1=1"];
    var args = [];
    if (status) { args.push(status); where.push("status = $" + args.length); }
    if (type)   { args.push(type);   where.push("type   = $" + args.length); }
    args.push(limit);

    var r = await pool.query(
      `SELECT id, token, type, factory_name, contact_name, contact_email, contact_phone,
              channel, channel_value, tax_id, message, invited_by, note,
              status, reviewed_by, reviewed_at, review_note,
              documents, ip, created_at, expires_at, used_at
       FROM factory_invites
       WHERE ` + where.join(" AND ") +
      ` ORDER BY created_at DESC LIMIT $` + args.length,
      args
    );

    // Counts by status (for tab badges)
    var counts = await pool.query(
      "SELECT status, COUNT(*)::int AS c FROM factory_invites GROUP BY status"
    );
    var byStatus = {};
    counts.rows.forEach(row => { byStatus[row.status] = row.c; });

    return res.status(200).json({
      success: true,
      total: r.rows.length,
      counts: byStatus,
      invites: r.rows,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
