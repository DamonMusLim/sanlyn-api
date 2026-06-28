import { getPool, setCors } from "../db.js";
import { isInternalRole, roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";

// Field Visibility Config API
//
// GET   /api/db/field-visibility?screen=customer_order_detail&role=customer
//   → { data: [ { field_key, visible, editable, sort_order } ] } sorted ASC
//   → any authenticated role (callers fetch their own config)
//
// POST  /api/db/field-visibility
//   body: { screen, field_key, role, visible?, editable?, sort_order? }
//   → upsert (ON CONFLICT (screen,field_key,role) DO UPDATE)
//   → admin/internal only
//
// PATCH /api/db/field-visibility/bulk
//   body: { screen, role, updates: [{ field_key, visible?, editable?, sort_order? }, ...] }
//   → batch upsert in single transaction (drag-and-drop reorder save)
//   → admin/internal only
//
// Security:
//   • Validation: screen/role/field_key are short identifiers (regex below);
//     reject anything that looks like an injection attempt before SQL.
//   • All SQL parameterized — no template-literal interpolation of user input.
//   • POST/PATCH gated by isInternalRole(); GET allows any logged-in caller.

const IDENT_RE = /^[a-z][a-z0-9_]{0,63}$/i;
const MAX_BULK_UPDATES = 200;

function validIdent(s) {
  return typeof s === "string" && IDENT_RE.test(s);
}

function normalizeBoolean(v, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  return dflt;
}

function normalizeInt(v, dflt) {
  if (v === undefined || v === null) return dflt;
  const n = parseInt(v);
  return Number.isFinite(n) ? n : dflt;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const role = roleFromAuth(req);
  const pool = getPool();

  try {
    // ── GET ─────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const screen = req.query?.screen;
      const queryRole = req.query?.role;
      if (!validIdent(screen)) return sendError(res, 400, "invalid_screen");
      if (queryRole !== undefined && !validIdent(queryRole)) {
        return sendError(res, 400, "invalid_role");
      }

      const conds = ["screen = $1"];
      const vals = [screen];
      if (queryRole) {
        vals.push(queryRole);
        conds.push("role = $" + vals.length);
      }

      // Always returned in stable sort order so frontend can render directly
      const sql =
        "SELECT screen, field_key, role, visible, editable, sort_order, updated_at " +
        "FROM field_visibility_config " +
        "WHERE " + conds.join(" AND ") + " " +
        "ORDER BY sort_order ASC, field_key ASC";
      const r = await pool.query(sql, vals);
      return res.status(200).json({ data: r.rows });
    }

    // ── POST (single upsert) ────────────────────────────────────────
    if (req.method === "POST") {
      if (!isInternalRole(role)) return sendError(res, 403, "admin_only");
      const b = req.body || {};
      if (!validIdent(b.screen))    return sendError(res, 400, "invalid_screen");
      if (!validIdent(b.field_key)) return sendError(res, 400, "invalid_field_key");
      if (!validIdent(b.role))      return sendError(res, 400, "invalid_role");

      const visible    = normalizeBoolean(b.visible,  true);
      const editable   = normalizeBoolean(b.editable, false);
      const sort_order = normalizeInt(b.sort_order,   0);

      const r = await pool.query(
        "INSERT INTO field_visibility_config " +
        "  (screen, field_key, role, visible, editable, sort_order, updated_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6, NOW()) " +
        "ON CONFLICT (screen, field_key, role) DO UPDATE SET " +
        "  visible = EXCLUDED.visible, " +
        "  editable = EXCLUDED.editable, " +
        "  sort_order = EXCLUDED.sort_order, " +
        "  updated_at = NOW() " +
        "RETURNING *",
        [b.screen, b.field_key, b.role, visible, editable, sort_order]
      );
      return res.status(200).json({ data: r.rows[0] });
    }

    // ── PATCH /bulk (batch upsert) ──────────────────────────────────
    // Express handles "/api/db/field-visibility/bulk" via the same handler
    // because the mount is on the prefix; we detect via req.url path tail.
    if (req.method === "PATCH") {
      if (!isInternalRole(role)) return sendError(res, 403, "admin_only");

      // Accept either /bulk path tail OR explicit ?action=bulk for proxy resilience.
      const isBulk = (req.url && req.url.includes("/bulk")) || req.query?.action === "bulk";
      if (!isBulk) return sendError(res, 400, "use_bulk_endpoint");

      const b = req.body || {};
      if (!validIdent(b.screen)) return sendError(res, 400, "invalid_screen");
      if (!validIdent(b.role))   return sendError(res, 400, "invalid_role");
      if (!Array.isArray(b.updates) || b.updates.length === 0) {
        return sendError(res, 400, "updates_required");
      }
      if (b.updates.length > MAX_BULK_UPDATES) {
        return sendError(res, 413, "too_many_updates");
      }

      // Validate every update first; fail fast before opening a transaction
      for (let i = 0; i < b.updates.length; i++) {
        const u = b.updates[i];
        if (!u || !validIdent(u.field_key)) {
          return sendError(res, 400, "invalid_field_key_at_index_" + i);
        }
      }

      const client = await pool.connect();
      const written = [];
      try {
        await client.query("BEGIN");
        for (const u of b.updates) {
          const visible    = normalizeBoolean(u.visible,  true);
          const editable   = normalizeBoolean(u.editable, false);
          const sort_order = normalizeInt(u.sort_order,   0);
          const r = await client.query(
            "INSERT INTO field_visibility_config " +
            "  (screen, field_key, role, visible, editable, sort_order, updated_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6, NOW()) " +
            "ON CONFLICT (screen, field_key, role) DO UPDATE SET " +
            "  visible = EXCLUDED.visible, " +
            "  editable = EXCLUDED.editable, " +
            "  sort_order = EXCLUDED.sort_order, " +
            "  updated_at = NOW() " +
            "RETURNING field_key, visible, editable, sort_order",
            [b.screen, u.field_key, b.role, visible, editable, sort_order]
          );
          written.push(r.rows[0]);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      return res.status(200).json({ data: written, count: written.length });
    }

    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[field-visibility] error:", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
