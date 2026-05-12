// api/db/freight-supplier-bills.js
// GET /api/db/freight-supplier-bills
//
// Read-only access to freight_supplier_bills table.
// No writes: POST / PUT / PATCH / DELETE all return 405.
// No finance state changes. No DB writes of any kind.
//
// Query params:
//   bl_no          — filter by BL number (exact)
//   supplier       — filter by supplier name (ILIKE)
//   supplier_type  — filter by supplier type (exact)
//   bill_month     — filter by bill_month string (exact, e.g. "2026-04")
//   reconciled     — "true" | "false" | unset (no filter)
//   cost_category  — filter by cost_category (exact)
//   currency       — filter by currency (exact)
//   limit          — max rows (default 200, max 1000)
//   offset         — pagination offset (default 0)
//
// Response: { success: true, data: [...], count: N, total: N }

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Only GET allowed — all write methods rejected
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed. This endpoint is read-only.",
      allowed: ["GET"],
    });
  }

  if (!requireAuth(req, res)) return;

  // Access control: finance + admin only
  const role = req.user?.role;
  if (role !== "admin" && role !== "finance") {
    return res.status(403).json({
      error: "Access denied. finance or admin role required.",
    });
  }

  const pool = getPool();

  try {
    const {
      bl_no,
      supplier,
      supplier_type,
      bill_month,
      reconciled,
      cost_category,
      currency,
      limit: rawLimit = "200",
      offset: rawOffset = "0",
    } = req.query;

    const safeLimit  = Math.min(Math.max(parseInt(rawLimit)  || 200, 1), 1000);
    const safeOffset = Math.max(parseInt(rawOffset) || 0, 0);

    const params = [];
    const conds  = [];

    if (bl_no) {
      params.push(bl_no);
      conds.push(`bl_no = $${params.length}`);
    }
    if (supplier) {
      params.push(`%${supplier}%`);
      conds.push(`supplier ILIKE $${params.length}`);
    }
    if (supplier_type) {
      params.push(supplier_type);
      conds.push(`supplier_type = $${params.length}`);
    }
    if (bill_month) {
      params.push(bill_month);
      conds.push(`bill_month = $${params.length}`);
    }
    if (reconciled === "true" || reconciled === "false") {
      params.push(reconciled === "true");
      conds.push(`reconciled = $${params.length}`);
    }
    if (cost_category) {
      params.push(cost_category);
      conds.push(`cost_category = $${params.length}`);
    }
    if (currency) {
      params.push(currency);
      conds.push(`currency = $${params.length}`);
    }

    const whereClause = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";

    // Count query (no limit/offset)
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM freight_supplier_bills ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.total ?? 0);

    // Data query
    params.push(safeLimit);
    params.push(safeOffset);
    const dataResult = await pool.query(
      `SELECT
         id,
         supplier,
         supplier_type,
         bill_month,
         bill_file,
         bl_no,
         container_no,
         cost_category,
         amount,
         currency,
         qty,
         unit_price,
         pair_id,
         rebill_status,
         incoterm,
         link_plan_id,
         link_agency_id,
         reconciled,
         reconcile_note,
         source_row,
         created_at,
         updated_at
       FROM freight_supplier_bills
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params
    );

    return res.status(200).json({
      success: true,
      data: dataResult.rows,
      count: dataResult.rowCount,
      total,
      limit: safeLimit,
      offset: safeOffset,
      data_source: "REAL",
    });
  } catch (err) {
    console.error("[freight-supplier-bills] GET error:", err.message);
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
}
