// GET /api/db/collab-sheets?id=N
// Generic collab sheet reader — resolves the right table by sheet_type.
// Used by CollabSheetForm (Air-C) to load any sheet by numeric ID.
//
// Strategy: we store a cross-table index in collab_sheet_outputs.
// If not found there, fall back to scanning each sheet table.
import { getPool, setCors } from "../db.js";
import { roleFromAuth, isInternalRole, sendError } from "../lib/viewmodel-adapter.js";

// Map sheet_type → table name
const SHEET_TABLES = {
  loading_confirmation:   "loading_collab_sheets",
  customs_draft:          "customs_draft_sheets",
  inspection_request:     "inspection_request_sheets",
  cert_application:       "cert_application_sheets",
  trucking_pickup:        "trucking_pickup_sheets",
  trucking_evidence:      "trucking_evidence_sheets",
  doc_revision:           "doc_revision_sheets",
};

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return sendError(res, 405, "method_not_allowed");

  const { id, sheet_type } = req.query || {};
  if (!id) return sendError(res, 400, "id_required");

  const numId = parseInt(id);
  if (!numId || isNaN(numId)) return sendError(res, 400, "invalid_id");

  const pool = getPool();
  const role = roleFromAuth(req);

  try {
    // If sheet_type is provided, query that table directly
    if (sheet_type && SHEET_TABLES[sheet_type]) {
      const table = SHEET_TABLES[sheet_type];
      const r = await pool.query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [numId]);
      if (!r.rows.length) return sendError(res, 404, "not_found");
      const row = r.rows[0];
      row.sheet_type = sheet_type;
      return res.status(200).json({ data: row });
    }

    // No sheet_type: scan all tables to find the sheet
    for (const [type, table] of Object.entries(SHEET_TABLES)) {
      try {
        const r = await pool.query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [numId]);
        if (r.rows.length) {
          const row = r.rows[0];
          row.sheet_type = type;
          return res.status(200).json({ data: row });
        }
      } catch (_) {
        // Table may not exist yet, skip
      }
    }

    return sendError(res, 404, "not_found");
  } catch (err) {
    console.error("[collab-sheets]", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
