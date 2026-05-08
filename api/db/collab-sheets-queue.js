import { getPool, setCors } from "../db.js";
import {
  isInternalRole, roleFromAuth,
  filterByRole, sendError,
} from "../lib/viewmodel-adapter.js";

// GET /api/db/collab-sheets/queue?status=submitted[&owner_company_code=X][&sheet_type=Y]
//
// Aggregates pending review queue across ALL 9 sheet tables.
// Returns standardized cards for the AdminPanel CollabReviewPanel.
//
// Output shape per row:
//   { sheet_table, sheet_type, id, order_id, order_no, contract_no,
//     owner_company_code, assignee_user, assignee_name,
//     status, submitted_at, created_at }
//
// Security:
//   • Admin/internal sees all tables; non-internal MUST scope by owner_company_code.
//   • Table list HARDCODED (set below). User input never enters table-name SQL fragment.
//   • Each sub-query selects ONLY safe columns; no internal_note, no forbidden fields.
//   • Adapter filterByRole still runs over result for defense-in-depth.

// Each entry: [tableName, sheetType, companyColumn]
//   companyColumn is the column that holds the owner's company code in this
//   particular table (loading_collab_sheets uses 'factory_code' due to
//   historical naming; all newer tables use 'owner_company_code').
const QUEUE_TABLES = [
  ["loading_collab_sheets",       "factory_loading_confirmation", "factory_code"],
  ["qc_checklist_sheets",         "qc_checklist",                 "owner_company_code"],
  ["customer_info_sheets",        "customer_missing_info",        "owner_company_code"],
  ["customs_draft_sheets",        "customs_draft",                "owner_company_code"],
  ["inspection_request_sheets",   "inspection_request",           "owner_company_code"],
  ["cert_application_sheets",     "certificate_application",      "owner_company_code"],
  ["trucking_pickup_sheets",      "trucking_pickup_confirmation", "owner_company_code"],
  ["trucking_evidence_sheets",    "trucking_loading_evidence",    "owner_company_code"],
  ["doc_revision_sheets",         "document_revision_request",    "owner_company_code"],
];

const ALLOWED_STATUS = new Set([
  "submitted", "under_review", "needs_revision", "approved", "completed",
  "assigned", "in_progress", "draft", "cancelled", "expired",
]);

const SHEET_TYPE_TO_TABLE = new Map(QUEUE_TABLES.map(([t, s]) => [s, t]));

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return sendError(res, 405, "method_not_allowed");

  const role = roleFromAuth(req);
  const isAdmin = isInternalRole(role);
  const pool = getPool();

  const status = req.query?.status || "submitted";
  if (!ALLOWED_STATUS.has(status)) return sendError(res, 400, "invalid_status");

  const owner_company_code = req.query?.owner_company_code || null;
  if (!isAdmin && !owner_company_code) {
    return sendError(res, 400, "owner_company_code_required");
  }

  // Optional sheet_type filter — restrict to a single table when provided
  const sheet_type = req.query?.sheet_type || null;
  if (sheet_type && !SHEET_TYPE_TO_TABLE.has(sheet_type)) {
    return sendError(res, 400, "invalid_sheet_type");
  }

  const limit = Math.min(parseInt(req.query?.limit) || 200, 500);
  const tablesToQuery = sheet_type
    ? QUEUE_TABLES.filter(([, st]) => st === sheet_type)
    : QUEUE_TABLES;

  // Per-table, run a parameterized query. We collect rows and merge in JS.
  // Avoids the complexity of building a UNION ALL with mixed-shape company columns.
  const out = [];
  for (const [table, sheetType, companyCol] of tablesToQuery) {
    try {
      const conds = ["status = $1"];
      const vals = [status];
      if (owner_company_code) {
        vals.push(owner_company_code);
        // companyCol is from the hardcoded constant above — never user input.
        conds.push(companyCol + " = $" + vals.length);
      }
      vals.push(limit);
      // SELECT only safe columns. Table name from constant, never user input.
      const sql = "\n        SELECT id,\n               order_id,\n               order_no,\n               contract_no,\n               " + companyCol + " AS owner_company_code,\n               assignee_user,\n               assignee_name,\n               status,\n               submitted_at,\n               created_at\n          FROM " + table + "\n         WHERE " + (conds.join(" AND ")) + "\n         ORDER BY submitted_at DESC NULLS LAST, created_at DESC\n         LIMIT $" + vals.length;
      const r = await pool.query(sql, vals);
      for (const row of r.rows) {
        out.push({ sheet_table: table, sheet_type: sheetType, ...row });
      }
    } catch (e) {
      // Tolerate tables that don't exist yet (early deploy). 42P01 = undefined_table.
      if (e.code !== "42P01") {
        console.warn("[queue] " + table + ": " + e.message);
      }
    }
  }

  // Merge-sort by submitted_at then created_at desc; cap to limit.
  out.sort((a, b) => {
    const ta = new Date(a.submitted_at || a.created_at).getTime();
    const tb = new Date(b.submitted_at || b.created_at).getTime();
    return tb - ta;
  });
  const capped = out.slice(0, limit);

  // Defense in depth — scrub through adapter
  const safe = filterByRole(capped, { role });

  return res.status(200).json({ data: safe, count: safe.length });
}
