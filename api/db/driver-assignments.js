import { getPool, setCors } from "../db.js";
import {
  isInternalRole, roleFromAuth,
  generateRawToken, hashToken,
  sendError,
} from "../lib/viewmodel-adapter.js";

// Driver assignment endpoint — issues Magic Link tokens.
//
// POST /api/db/driver-assignments
//   body: { driver_id, collab_sheet_table, collab_sheet_id, order_id, task_type,
//           ttl_hours? (default 24) }
//   → returns: {
//       assignment_id, expires_at,
//       raw_token,             ← one-time-only, NEVER stored, used for SMS link
//       magic_link_url
//     }
//
// PATCH /api/db/driver-assignments?id=N
//   body: { revoked: true } | { extend_hours: N }
//   → admin-only revoke / extend
//
// GET   /api/db/driver-assignments?driver_id=N
//   → admin/internal lists assignments for a driver
//
// Security:
//   • Only internal roles can issue / revoke / list.
//   • raw_token is generated with crypto.randomBytes(32), only the SHA-256
//     hash is persisted. raw_token returned ONCE in POST response.
//   • Whitelist of legal collab_sheet_table values.

const ALLOWED_SHEET_TABLES = new Set([
  "trucking_evidence_sheets",
  "loading_collab_sheets",
]);

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 168; // 7 days hard cap

const APP_BASE_URL = process.env.MAGIC_LINK_BASE_URL || "https://app.sanlyn.cn";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const role = roleFromAuth(req);
  if (!isInternalRole(role)) return sendError(res, 403, "admin_only");

  const pool = getPool();

  try {
    if (req.method === "POST") {
      const b = req.body || {};
      const required = ["driver_id", "collab_sheet_table", "collab_sheet_id", "order_id", "task_type"];
      for (const f of required) {
        if (b[f] === undefined || b[f] === null || b[f] === "") {
          return sendError(res, 400, "missing_field", f);
        }
      }
      if (!ALLOWED_SHEET_TABLES.has(b.collab_sheet_table)) {
        return sendError(res, 400, "invalid_sheet_table");
      }

      // Validate driver exists and is not blacklisted
      const drv = await pool.query(
        "SELECT id, blacklist FROM drivers WHERE id = $1",
        [parseInt(b.driver_id)]
      );
      if (!drv.rows.length) return sendError(res, 404, "driver_not_found");
      if (drv.rows[0].blacklist) return sendError(res, 403, "driver_blacklisted");

      const ttl = Math.min(parseInt(b.ttl_hours) || DEFAULT_TTL_HOURS, MAX_TTL_HOURS);
      const rawToken = generateRawToken(32);
      const tokenHash = hashToken(rawToken);

      const createdBy = (req.user && (req.user.username || req.user.account)) || "admin";

      const ins = await pool.query(
        `INSERT INTO driver_assignments
           (driver_id, collab_sheet_table, collab_sheet_id, order_id, task_type,
            magic_token_hash, expires_at, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6, NOW() + ($7 || ' hours')::interval, 'assigned', $8)
         RETURNING id, expires_at`,
        [
          parseInt(b.driver_id), b.collab_sheet_table, parseInt(b.collab_sheet_id),
          parseInt(b.order_id), b.task_type, tokenHash, String(ttl), createdBy,
        ]
      );

      return res.status(201).json({
        data: {
          assignment_id: ins.rows[0].id,
          expires_at: ins.rows[0].expires_at,
          raw_token: rawToken, // one-time return
          magic_link_url: APP_BASE_URL + "/driver/" + rawToken,
        },
      });
    }

    if (req.method === "PATCH") {
      const id = req.query?.id;
      if (!id) return sendError(res, 400, "id_required");
      const b = req.body || {};

      if (b.revoked === true) {
        const r = await pool.query(
          `UPDATE driver_assignments
              SET revoked_at = NOW(), status = 'revoked'
            WHERE id = $1 AND revoked_at IS NULL AND used_at IS NULL
            RETURNING id, revoked_at`,
          [parseInt(id)]
        );
        if (!r.rows.length) return sendError(res, 409, "already_revoked_or_used");
        return res.status(200).json({ data: r.rows[0] });
      }

      if (b.extend_hours) {
        const hrs = Math.min(parseInt(b.extend_hours) || 0, MAX_TTL_HOURS);
        if (hrs <= 0) return sendError(res, 400, "invalid_extend_hours");
        const r = await pool.query(
          `UPDATE driver_assignments
              SET expires_at = expires_at + ($2 || ' hours')::interval
            WHERE id = $1 AND revoked_at IS NULL AND used_at IS NULL
            RETURNING id, expires_at`,
          [parseInt(id), String(hrs)]
        );
        if (!r.rows.length) return sendError(res, 409, "cannot_extend");
        return res.status(200).json({ data: r.rows[0] });
      }

      return sendError(res, 400, "no_action");
    }

    if (req.method === "GET") {
      const driver_id = req.query?.driver_id;
      const order_id = req.query?.order_id;
      const conds = [];
      const vals = [];
      if (driver_id) { vals.push(parseInt(driver_id)); conds.push("driver_id = $" + vals.length); }
      if (order_id)  { vals.push(parseInt(order_id));  conds.push("order_id = $" + vals.length);  }
      const where = conds.length ? "WHERE " + (conds.join(" AND ")) : "";
      // Never return magic_token_hash (avoid leak surface).
      const sql = "\n        SELECT id, driver_id, collab_sheet_id, collab_sheet_table, order_id, task_type,\n               issued_at, expires_at, revoked_at, used_at, status, created_by, created_at\n          FROM driver_assignments\n          " + where + "\n          ORDER BY issued_at DESC\n          LIMIT 200";
      const r = await pool.query(sql, vals);
      return res.status(200).json({ data: r.rows });
    }

    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[driver-assignments] error:", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
