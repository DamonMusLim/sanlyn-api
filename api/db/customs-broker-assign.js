// customs-broker-assign.js
// POST /api/db/customs-broker-assign
//   body: { customs_draft_sheet_id, order_id, ttl_hours? }
//   → admin creates a magic link for a customs broker (no login required on their end).
//   → Inserts a row into driver_assignments with task_type='CUSTOMS_BROKER', driver_id=NULL.
//   → Returns raw_token ONCE — store the link immediately.
//
// PATCH /api/db/customs-broker-assign?id=N
//   body: { revoked: true } | { extend_hours: N }
//   → admin revokes or extends the link.
//
// GET /api/db/customs-broker-assign?sheet_id=N
//   → list active links for a given sheet.

import { getPool, setCors } from "../db.js";
import {
  isInternalRole, roleFromAuth,
  generateRawToken, hashToken,
  sendError,
} from "../lib/viewmodel-adapter.js";

const DEFAULT_TTL_HOURS = 72;   // 3 days default
const MAX_TTL_HOURS     = 336;  // 14 days hard cap
const APP_BASE_URL = process.env.MAGIC_LINK_BASE_URL || "https://ai.sanlyn.cn";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const role = roleFromAuth(req);
  if (!isInternalRole(role)) return sendError(res, 403, "admin_only");

  const pool = getPool();

  try {
    // ── GET: list active links for a sheet ──────────────────────────
    if (req.method === "GET") {
      const sheetId = req.query?.sheet_id;
      if (!sheetId) return sendError(res, 400, "sheet_id_required");

      const { rows } = await pool.query(
        `SELECT id, task_type, status, expires_at, revoked_at, used_at,
                created_at, assigned_by, notes
           FROM driver_assignments
          WHERE collab_sheet_table = 'customs_draft_sheets'
            AND collab_sheet_id    = $1
          ORDER BY created_at DESC
          LIMIT 20`,
        [parseInt(sheetId)]
      );
      return res.status(200).json({ data: rows });
    }

    // ── POST: create magic link ──────────────────────────────────────
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.customs_draft_sheet_id) return sendError(res, 400, "customs_draft_sheet_id_required");
      if (!b.order_id)               return sendError(res, 400, "order_id_required");

      // Verify sheet exists
      const sheetRes = await pool.query(
        "SELECT id, status, order_no, contract_no FROM customs_draft_sheets WHERE id = $1",
        [parseInt(b.customs_draft_sheet_id)]
      );
      if (!sheetRes.rows.length) return sendError(res, 404, "sheet_not_found");
      const sheet = sheetRes.rows[0];

      const ttlHours = Math.min(
        parseInt(b.ttl_hours) || DEFAULT_TTL_HOURS,
        MAX_TTL_HOURS
      );
      const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

      const rawToken   = generateRawToken(32);
      const tokenHash  = hashToken(rawToken);
      const callerUser = (req.user && (req.user.username || req.user.uid)) || "admin";

      const ins = await pool.query(
        `INSERT INTO driver_assignments
           (driver_id, collab_sheet_table, collab_sheet_id, order_id,
            task_type, status, magic_token_hash, expires_at, assigned_by, notes)
         VALUES (NULL, 'customs_draft_sheets', $1, $2,
                 'CUSTOMS_BROKER', 'pending', $3, $4, $5, $6)
         RETURNING id, expires_at, created_at`,
        [
          parseInt(b.customs_draft_sheet_id),
          parseInt(b.order_id),
          tokenHash,
          expiresAt,
          callerUser,
          b.notes || null,
        ]
      );

      const asmRow = ins.rows[0];
      const magicUrl = `${APP_BASE_URL}/m/customs/${rawToken}`;

      return res.status(201).json({
        success: true,
        data: {
          assignment_id: asmRow.id,
          expires_at:    asmRow.expires_at,
          raw_token:     rawToken,   // only returned once
          magic_link_url: magicUrl,
          sheet: {
            id:           sheet.id,
            order_no:     sheet.order_no,
            contract_no:  sheet.contract_no,
            status:       sheet.status,
          },
        },
      });
    }

    // ── PATCH: revoke or extend ──────────────────────────────────────
    if (req.method === "PATCH") {
      const id = req.query?.id;
      if (!id) return sendError(res, 400, "id_required");
      const b = req.body || {};

      if (b.revoked === true) {
        const r = await pool.query(
          `UPDATE driver_assignments
              SET revoked_at = NOW(), status = 'revoked'
            WHERE id = $1 AND collab_sheet_table = 'customs_draft_sheets'
            RETURNING id, revoked_at`,
          [parseInt(id)]
        );
        if (!r.rows.length) return sendError(res, 404, "not_found");
        return res.status(200).json({ success: true, data: r.rows[0] });
      }

      if (b.extend_hours) {
        const hours = Math.min(parseInt(b.extend_hours) || 24, MAX_TTL_HOURS);
        const r = await pool.query(
          `UPDATE driver_assignments
              SET expires_at = expires_at + ($2 || ' hours')::interval
            WHERE id = $1 AND collab_sheet_table = 'customs_draft_sheets'
            RETURNING id, expires_at`,
          [parseInt(id), hours]
        );
        if (!r.rows.length) return sendError(res, 404, "not_found");
        return res.status(200).json({ success: true, data: r.rows[0] });
      }

      return sendError(res, 400, "no_action");
    }

    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[customs-broker-assign]", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
