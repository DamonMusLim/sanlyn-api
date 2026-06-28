import { getPool, setCors } from "../db.js";
import {
  isInternalRole, roleFromAuth,
  adaptCollabSheet, filterByRole,
  assertNoForbiddenInBody, sendError, callerCompanyScope,
} from "../lib/viewmodel-adapter.js";

// trucking_loading_evidence sheet API · table: trucking_evidence_sheets
// State machine (10 states, all sheets common):
//   draft → assigned → in_progress → submitted → under_review →
//     (needs_revision ↻ | approved → completed) | cancelled | expired
//
// GET   ?id=N                              → detail (lens applied)
// GET   ?owner_company_code=X[&status=Y]   → list scoped to caller's company
// GET   ?status=Y                          → admin queue
// POST                                     → admin assigns (status=assigned)
// PATCH ?id=N                              → owner role updates fields
// PATCH ?id=N&action=submit                → owner submits
// PATCH ?id=N&action=approve               → admin approves
// PATCH ?id=N&action=reject                → admin requests revision

const TABLE = "trucking_evidence_sheets";
const SHEET_TYPE = "trucking_loading_evidence";
const ALLOWED_OWNER_FIELDS = ["evidence", "container_no", "seal_no", "gate_location", "participant_note", "driver_visible_note", "forwarder_visible_note"];
const JSONB_COLUMNS = new Set(["evidence"]);
const REQUIRED_CREATE_FIELDS = ["order_id", "owner_company_code"];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const role = roleFromAuth(req);
  const pool = getPool();
  const ctx = { role, sheetType: SHEET_TYPE };
  // Watchtower fix (codex P1-1 2026-05-08): scope derived from JWT, never query.
  const company = callerCompanyScope(req);

  try {
    // ── GET ────────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const id = req.query?.id;
      const owner_company_code = req.query?.owner_company_code;
      const status = req.query?.status;
      const limit = Math.min(parseInt(req.query?.limit) || 100, 500);

      if (id) {
        const r = await pool.query("SELECT * FROM " + TABLE + " WHERE id = $1", [parseInt(id)]);
        if (!r.rows.length) return sendError(res, 404, "not_found");
        const row = r.rows[0];
        if (!isInternalRole(role) && !company.all.includes(row.owner_company_code)) {
          return sendError(res, 403, "forbidden");
        }
        return res.status(200).json({ data: adaptCollabSheet(row, ctx) });
      }

      const conds = [];
      const vals = [];
      // Watchtower fix (codex P1-1): scope from JWT for non-admin.
      let _scopeCompany;
      if (isInternalRole(role)) {
        _scopeCompany = owner_company_code || null;
      } else {
        if (!company.primary) return sendError(res, 403, "forbidden");
        _scopeCompany = company.primary;
      }
      if (_scopeCompany) { vals.push(_scopeCompany); conds.push("owner_company_code = $" + vals.length); }
      if (status)         { vals.push(status);         conds.push("status = $" + vals.length); }

      const where = conds.length ? "WHERE " + (conds.join(" AND ")) : "";
      vals.push(limit);
      const sql = "SELECT * FROM " + TABLE + " " + where + " ORDER BY created_at DESC LIMIT $" + vals.length;
      const rl = await pool.query(sql, vals);
      return res.status(200).json({ data: filterByRole(rl.rows, ctx) });
    }

    // ── POST (admin assigns) ──────────────────────────────────────────
    if (req.method === "POST") {
      if (!isInternalRole(role)) return sendError(res, 403, "admin_only");
      const b = req.body || {};
      assertNoForbiddenInBody(b);

      for (const f of REQUIRED_CREATE_FIELDS) {
        if (b[f] === undefined || b[f] === null || b[f] === "") {
          return sendError(res, 400, "missing_field", f);
        }
      }

      // Snapshot order context for fast list rendering
      const ord = await pool.query("SELECT order_no, contract_no FROM orders WHERE id = $1", [parseInt(b.order_id)]);
      if (!ord.rows.length) return sendError(res, 404, "order_not_found");
      const o = ord.rows[0];

      const ins = await pool.query("\n        INSERT INTO " + TABLE + "\n          (order_id, order_no, contract_no, owner_company_code, assignee_user, assignee_name,\n           due_at, status, evidence, container_no, seal_no, gate_location, magic_link_assignment_id)\n        VALUES ($1,$2,$3,$4,$5,$6,$7,'assigned',$8::jsonb,$9,$10,$11,$12)\n        RETURNING *\n      ", [
        parseInt(b.order_id), o.order_no || null, o.contract_no || null,
        b.owner_company_code, b.assignee_user || null, b.assignee_name || null,
        b.due_at || null,
        JSON.stringify(b.evidence || {}),
        b.container_no || null, b.seal_no || null, b.gate_location || null,
        b.magic_link_assignment_id != null ? parseInt(b.magic_link_assignment_id) : null,
      ]);
      return res.status(201).json({ data: adaptCollabSheet(ins.rows[0], ctx) });
    }

    // ── PATCH ────────────────────────────────────────────────────────
    if (req.method === "PATCH") {
      const id = req.query?.id;
      if (!id) return sendError(res, 400, "id_required");
      const action = req.query?.action || "";
      const b = req.body || {};
      assertNoForbiddenInBody(b);

      const cur = await pool.query("SELECT * FROM " + TABLE + " WHERE id = $1", [parseInt(id)]);
      if (!cur.rows.length) return sendError(res, 404, "not_found");
      const existing = cur.rows[0];

      // RBAC: non-internal must scope by owner_company_code
      if (!isInternalRole(role)) {
        if (!company.all.includes(existing.owner_company_code)) return sendError(res, 403, "forbidden");
        if (action === "approve" || action === "reject") return sendError(res, 403, "admin_only_action");
      }

      // Action shortcuts
      if (action === "submit") {
        const rs = await pool.query(
          "UPDATE " + TABLE + "\n              SET status='submitted', submitted_at=NOW()\n            WHERE id=$1 AND status IN ('assigned','in_progress','needs_revision')\n            RETURNING *", [parseInt(id)]);
        if (!rs.rows.length) return sendError(res, 409, "invalid_status_transition");
        return res.status(200).json({ data: adaptCollabSheet(rs.rows[0], ctx) });
      }
      if (action === "approve") {
        const ra = await pool.query(
          "UPDATE " + TABLE + "\n              SET status='approved', approved_at=NOW(), reviewed_by=$2, reviewed_at=NOW()\n            WHERE id=$1 AND status IN ('submitted','under_review')\n            RETURNING *", [parseInt(id), b.reviewed_by || (req.user && req.user.username) || "admin"]);
        if (!ra.rows.length) return sendError(res, 409, "invalid_status_transition");
        return res.status(200).json({ data: adaptCollabSheet(ra.rows[0], ctx) });
      }
      if (action === "reject") {
        if (!b.revision_reason) return sendError(res, 400, "revision_reason_required");
        const rr = await pool.query(
          "UPDATE " + TABLE + "\n              SET status='needs_revision', reviewed_by=$2, reviewed_at=NOW(), revision_reason=$3\n            WHERE id=$1 AND status IN ('submitted','under_review')\n            RETURNING *", [parseInt(id), b.reviewed_by || (req.user && req.user.username) || "admin", b.revision_reason]);
        if (!rr.rows.length) return sendError(res, 409, "invalid_status_transition");
        return res.status(200).json({ data: adaptCollabSheet(rr.rows[0], ctx) });
      }
      if (action === "cancel") {
        if (!isInternalRole(role)) return sendError(res, 403, "admin_only_action");
        const rc = await pool.query(
          "UPDATE " + TABLE + " SET status='cancelled' WHERE id=$1 AND status NOT IN ('completed') RETURNING *",
          [parseInt(id)]);
        if (!rc.rows.length) return sendError(res, 409, "invalid_status_transition");
        return res.status(200).json({ data: adaptCollabSheet(rc.rows[0], ctx) });
      }

      // Field updates — whitelist by role
      const allowedAdmin = ALLOWED_OWNER_FIELDS.concat([
        "internal_note", "audit_note", "due_at", "assignee_user", "assignee_name", "status",
      ]);
      const allowed = isInternalRole(role) ? allowedAdmin : ALLOWED_OWNER_FIELDS;

      const sets = [];
      const vals2 = [];
      let n = 0;
      for (const f of allowed) {
        if (b[f] !== undefined) {
          n++;
          let v = b[f];
          if (JSONB_COLUMNS.has(f)) v = JSON.stringify(v);
          sets.push(f + " = $" + n);
          vals2.push(v);
        }
      }

      // Auto-promote 'assigned' → 'in_progress' on first owner edit
      if (!isInternalRole(role) && existing.status === "assigned" && sets.length > 0) {
        sets.push("status = 'in_progress'");
      }

      if (sets.length === 0) return sendError(res, 400, "no_fields_to_update");
      n++;
      vals2.push(parseInt(id));
      const sqlU = "UPDATE " + TABLE + " SET " + (sets.join(", ")) + " WHERE id = $" + n + " RETURNING *";
      const ru = await pool.query(sqlU, vals2);
      return res.status(200).json({ data: adaptCollabSheet(ru.rows[0], ctx) });
    }

    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[" + SHEET_TYPE + "] error:", err);
    if (err.statusCode) return sendError(res, err.statusCode, err.message);
    return sendError(res, 500, "internal_error", err.message);
  }
}
