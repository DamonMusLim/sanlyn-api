// api/db/sample-assign.js
// Create factory confirmation magic links for sample_delivery_sheets.
// Generates the link only.
import { getPool, setCors } from "../db.js";
import {
  isInternalRole,
  roleFromAuth,
  generateRawToken,
  hashToken,
  sendError,
} from "../lib/viewmodel-adapter.js";

const DEFAULT_TTL_HOURS = 168;
const MAX_TTL_HOURS = 336;
const APP_BASE_URL = "https://api.sanlyn.cn";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const role = roleFromAuth(req);
  if (!isInternalRole(role)) return sendError(res, 403, "admin_only");

  const pool = getPool();

  try {
    if (req.method === "GET") {
      const sheetId = req.query?.sheet_id;
      if (!sheetId) return sendError(res, 400, "sheet_id_required");
      const { rows } = await pool.query(
        `SELECT id, task_type, status, expires_at, revoked_at, used_at,
                created_at, assigned_by, notes
           FROM driver_assignments
          WHERE collab_sheet_table = 'sample_delivery_sheets'
            AND collab_sheet_id = $1
          ORDER BY created_at DESC
          LIMIT 20`,
        [parseInt(sheetId, 10)]
      );
      return res.status(200).json({ ok: true, data: rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const sheetId = parseInt(b.sheet_id || b.sample_sheet_id, 10);
      if (!sheetId) return sendError(res, 400, "sheet_id_required");

      const sheetRes = await pool.query(
        `SELECT id, status, order_no, contract_no, owner_company_code, sample_brief
           FROM sample_delivery_sheets
          WHERE id = $1`,
        [sheetId]
      );
      if (!sheetRes.rows.length) return sendError(res, 404, "sheet_not_found");
      const sheet = sheetRes.rows[0];

      const ttlHours = Math.min(parseInt(b.ttl_hours, 10) || DEFAULT_TTL_HOURS, MAX_TTL_HOURS);
      const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
      const rawToken = generateRawToken(32);
      const tokenHash = hashToken(rawToken);
      const callerUser = (req.user && (req.user.username || req.user.uid)) || "admin";

      const ins = await pool.query(
        `INSERT INTO driver_assignments
           (driver_id, collab_sheet_table, collab_sheet_id, order_id,
            task_type, status, magic_token_hash, expires_at, assigned_by, notes)
         VALUES (NULL, 'sample_delivery_sheets', $1, NULL,
                 'sample_factory_confirm', 'pending', $2, $3, $4, $5)
         RETURNING id, expires_at, created_at`,
        [sheetId, tokenHash, expiresAt, callerUser, b.notes || null]
      );

      const assignment = ins.rows[0];
      const magicUrl = `${APP_BASE_URL}/public/collab-sample.html?token=${rawToken}`;

      return res.status(201).json({
        ok: true,
        data: {
          assignment_id: assignment.id,
          expires_at: assignment.expires_at,
          raw_token: rawToken,
          magic_link_url: magicUrl,
          sheet: {
            id: sheet.id,
            order_no: sheet.order_no,
            contract_no: sheet.contract_no,
            status: sheet.status,
            owner_company_code: sheet.owner_company_code,
            sample_brief: sheet.sample_brief,
          },
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
            WHERE id = $1 AND collab_sheet_table = 'sample_delivery_sheets'
            RETURNING id, revoked_at`,
          [parseInt(id, 10)]
        );
        if (!r.rows.length) return sendError(res, 404, "not_found");
        return res.status(200).json({ ok: true, data: r.rows[0] });
      }

      if (b.extend_hours) {
        const hours = Math.min(parseInt(b.extend_hours, 10) || 24, MAX_TTL_HOURS);
        const r = await pool.query(
          `UPDATE driver_assignments
              SET expires_at = expires_at + ($2 || ' hours')::interval
            WHERE id = $1 AND collab_sheet_table = 'sample_delivery_sheets'
            RETURNING id, expires_at`,
          [parseInt(id, 10), hours]
        );
        if (!r.rows.length) return sendError(res, 404, "not_found");
        return res.status(200).json({ ok: true, data: r.rows[0] });
      }

      return sendError(res, 400, "no_action");
    }

    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[sample-assign]", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
