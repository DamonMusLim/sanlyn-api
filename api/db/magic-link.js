import { getPool, setCors } from "../db.js";
import { hashToken, sendError } from "../lib/viewmodel-adapter.js";

// Magic Link route — driver scans QR / clicks link, no JWT required.
//
// GET   /api/db/magic-link?token=<raw>     → fetch single task (minimal data)
// PATCH /api/db/magic-link?token=<raw>     → submit task evidence, mark used
//
// Security:
//   • token comes in raw, hashed via SHA-256 to look up driver_assignments.
//   • Reject if expires_at < NOW(), revoked_at IS NOT NULL, or used_at IS NOT NULL.
//   • Response NEVER includes customer_name, prices, order totals, or any
//     forbidden field. Returns minimal task envelope only.
//   • On PATCH success, mark used_at = NOW() so token cannot be reused.
//   • Whitelist of legal collab_sheet_table values to prevent SQL injection
//     when mirroring submission to the sheet table.

const ALLOWED_SHEET_TABLES = new Set([
  "trucking_evidence_sheets",
  "loading_collab_sheets",
]);

async function fetchMinimalSheet(pool, table, id) {
  if (!ALLOWED_SHEET_TABLES.has(table)) {
    throw new Error("invalid_sheet_table");
  }
  // Pull only safe columns. Ordering by hand-listed names — never inject `table` into SELECT cols.
  const safeCols = "id, status, container_no, seal_no, gate_location";
  // Table name validated against whitelist set above; safe to interpolate now.
  const { rows } = await pool.query(
    "SELECT " + safeCols + " FROM " + table + " WHERE id = $1",
    [id]
  );
  return rows[0] || null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const raw = req.query?.token;
  if (!raw || typeof raw !== "string" || raw.length < 16) {
    return sendError(res, 400, "token_required");
  }

  const pool = getPool();
  const tokenHash = hashToken(raw);

  try {
    const { rows } = await pool.query(
      `SELECT id, driver_id, collab_sheet_id, collab_sheet_table, order_id, task_type,
              expires_at, revoked_at, used_at, status, uploaded_files
         FROM driver_assignments
        WHERE magic_token_hash = $1
          AND expires_at > NOW()
          AND revoked_at IS NULL
          AND used_at IS NULL
        LIMIT 1`,
      [tokenHash]
    );
    if (!rows.length) return sendError(res, 401, "invalid_or_expired_link");
    const assignment = rows[0];

    if (req.method === "GET") {
      const drv = await pool.query(
        "SELECT name, phone, credit_score FROM drivers WHERE id = $1",
        [assignment.driver_id]
      );
      const sheet = assignment.collab_sheet_table && assignment.collab_sheet_id
        ? await fetchMinimalSheet(pool, assignment.collab_sheet_table, assignment.collab_sheet_id)
        : null;
      return res.status(200).json({
        data: {
          assignment_id: assignment.id,
          task_type: assignment.task_type,
          status: assignment.status,
          expires_at: assignment.expires_at,
          driver: drv.rows[0] || null,
          sheet,
        },
      });
    }

    if (req.method === "PATCH") {
      const body = req.body || {};
      const evidence = (body.evidence && typeof body.evidence === "object") ? body.evidence : {};
      const photos = Array.isArray(body.photos) ? body.photos : [];

      if (!assignment.collab_sheet_table || !assignment.collab_sheet_id) {
        return sendError(res, 400, "no_sheet_attached");
      }
      if (!ALLOWED_SHEET_TABLES.has(assignment.collab_sheet_table)) {
        return sendError(res, 400, "invalid_sheet_table");
      }

      // Atomic: mark used + mirror to sheet, in one connection (best-effort transaction)
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `UPDATE driver_assignments
              SET uploaded_files = $1, used_at = NOW(), status = 'done'
            WHERE id = $2 AND used_at IS NULL`,
          [JSON.stringify(photos), assignment.id]
        );

        // Mirror submitted evidence to the sheet's table.
        // Whitelisted table name → safe to interpolate.
        await client.query(
          "UPDATE " + assignment.collab_sheet_table + "\n              SET evidence    = COALESCE(evidence, '{}'::jsonb) || $1::jsonb,\n                  status      = CASE WHEN status IN ('assigned','in_progress','needs_revision')\n                                     THEN 'submitted' ELSE status END,\n                  submitted_at = COALESCE(submitted_at, NOW())\n            WHERE id = $2",
          [JSON.stringify(evidence), assignment.collab_sheet_id]
        );

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      return res.status(200).json({ ok: true });
    }

    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[magic-link] error:", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
