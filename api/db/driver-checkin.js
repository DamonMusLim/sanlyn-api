// ═══════════════════════════════════════════════════════════════
// api/db/driver-checkin.js  — 司机协同表多步骤打卡
//
// POST /api/db/driver-checkin
//   body: {
//     token:     <raw magic-link token>   (required)
//     action:    "arrived"|"loaded"|"vgm"|"delivered"  (required)
//     photo_url: <string>    (optional — DAS URL from prior oss-upload call)
//     gps:       { lat, lng, acc }        (optional)
//   }
//
// Unlike PATCH /api/db/magic-link, this endpoint:
//   • Does NOT mark used_at, so the token stays valid for further steps
//   • Appends each action into driver_assignments.access_log (JSONB array)
//   • Returns the driver's current credit_score for display
//
// Security:
//   • No auth required (magic-link pattern)
//   • token validated via SHA-256 hash against driver_assignments.magic_token_hash
//   • Reject expired / revoked tokens
//   • action whitelist — no free-form strings stored
// ═══════════════════════════════════════════════════════════════
import { getPool, setCors } from "../db.js";
import { hashToken, sendError } from "../lib/viewmodel-adapter.js";

const ALLOWED_ACTIONS = new Set(["arrived", "loaded", "vgm", "delivered"]);

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return sendError(res, 405, "method_not_allowed");

  const body = req.body || {};
  const { token: rawToken, action, photo_url, gps } = body;

  // ── Input validation ────────────────────────────────────────
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 16) {
    return sendError(res, 400, "token_required");
  }
  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return sendError(res, 400, "invalid_action",
      "Allowed: " + [...ALLOWED_ACTIONS].join(", "));
  }

  const pool = getPool();
  const tokenHash = hashToken(rawToken);

  try {
    // ── Validate assignment ─────────────────────────────────────
    const { rows } = await pool.query(
      `SELECT da.id AS assignment_id,
              da.driver_id,
              da.status,
              da.access_log,
              d.credit_score
         FROM driver_assignments da
         LEFT JOIN drivers d ON d.id = da.driver_id
        WHERE da.magic_token_hash = $1
          AND da.expires_at > NOW()
          AND da.revoked_at IS NULL
        LIMIT 1`,
      [tokenHash]
    );

    if (!rows.length) return sendError(res, 401, "invalid_or_expired_link");
    const { assignment_id, driver_id, access_log, credit_score } = rows[0];

    // ── Build log entry ─────────────────────────────────────────
    const entry = {
      action,
      ts:        new Date().toISOString(),
      photo_url: photo_url || null,
      gps:       (gps && typeof gps === "object") ? {
        lat: Number(gps.lat) || null,
        lng: Number(gps.lng) || null,
        acc: Number(gps.acc) || null,
      } : null,
    };

    // ── Append to access_log (JSONB array) ──────────────────────
    const currentLog = Array.isArray(access_log) ? access_log : [];
    const updatedLog = [...currentLog, entry];

    // Also update status based on action
    const newStatus = action === "delivered" ? "completed"
                    : action === "arrived"   ? "in_progress"
                    : rows[0].status; // loaded/vgm don't change status

    await pool.query(
      `UPDATE driver_assignments
          SET access_log = $1::jsonb,
              status     = $2,
              updated_at = NOW()
        WHERE id = $3`,
      [JSON.stringify(updatedLog), newStatus, assignment_id]
    );

    // ── Return confirmation ─────────────────────────────────────
    return res.status(200).json({
      ok: true,
      action,
      ts: entry.ts,
      credit_score: credit_score ?? null,
    });

  } catch (err) {
    console.error("[driver-checkin] error:", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
