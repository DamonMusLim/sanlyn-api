// api/db/freight-supplier-bills.js
// GET /api/db/freight-supplier-bills
//
// Read/Write access to freight_supplier_bills table.
// POST: admin only — create new bill row.
// PATCH: admin/finance — correct amount, sale_amount, category.
// DELETE: admin only.
// No finance state changes beyond this table.
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
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── POST: admin only — create new bill row ──
  if (req.method === "POST") {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "admin role required" });
    try {
      const b = req.body || {};
      if (!b.bl_no || !b.cost_category || b.amount == null || !b.currency)
        return res.status(400).json({ error: "bl_no, cost_category, amount, currency required" });
      const pool = getPool();
      const r = await pool.query(
        `INSERT INTO freight_supplier_bills
           (bl_no, link_plan_id, cost_category, amount, currency, sale_amount, rebill_status, supplier, bill_month, raw, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now()) RETURNING *`,
        [b.bl_no, b.link_plan_id ?? null, b.cost_category, b.amount, b.currency,
         b.sale_amount ?? null, b.rebill_status ?? null, b.supplier ?? "待补",
         b.bill_month ?? null, b.raw ? JSON.stringify(b.raw) : null]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  }

  // ── PATCH: admin/finance only — correct FSB records (amount, category, notes) ──
  if (req.method === "PATCH") {
    const pRole = req.user?.role;
    if (pRole !== "admin" && pRole !== "finance") {
      return res.status(403).json({ error: "admin or finance role required for corrections" });
    }
    try {
      const body = req.body || {};
      if (!body.id) return res.status(400).json({ success: false, error: "id required" });
      const PATCHABLE = ["amount","sale_amount","cost_category","rebill_status","reconcile_note","container_no","link_plan_id","incoterm","supplier_type","currency","rebill_to_type","rebill_to_name","rebill_dn_no","rebill_finance_slip_id","confirmed_at","confirmed_by","unit_price","qty","charge_basis","remarks"];
      const pool = getPool();
      const params = [], sets = [];
      for (const col of PATCHABLE) {
        if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
        params.push(body[col]); sets.push(`${col} = $${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ success: false, error: "no patchable fields" });
      sets.push(`updated_at = now()`);
      params.push(body.id);
      const r = await pool.query(
        `UPDATE freight_supplier_bills SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!r.rows.length) return res.status(404).json({ success: false, error: "record not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  }

  // ── DELETE: admin only — remove wrong FSB entries ──
  if (req.method === "DELETE") {
    const dRole = req.user?.role;
    if (dRole !== "admin") return res.status(403).json({ error: "admin role required for deletion" });
    try {
      const body = req.body || {};
      if (!body.id) return res.status(400).json({ success: false, error: "id required" });
      const pool = getPool();
      const r = await pool.query("DELETE FROM freight_supplier_bills WHERE id = $1 RETURNING id", [body.id]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "not found" });
      return res.status(200).json({ success: true, deleted: r.rows[0].id });
    } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  }

  // Only GET (and above PATCH/DELETE) allowed
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed.",
      allowed: ["GET", "PATCH", "DELETE"],
    });
  }

  if (!requireAuth(req, res)) return;

  // ── Access control ────────────────────────────────────────────────────────
  // admin / finance : full access (all suppliers, all filters honoured)
  // logistics       : read-only access to OWN supplier rows only
  //                   company binding is taken from JWT; ?supplier= query param
  //                   is IGNORED to prevent cross-supplier data leakage
  // others          : 403
  const role        = req.user?.role;
  const userCompany     = req.user?.company || req.user?.companyName || null;
  const userCompanyCode = req.user?.companyCode || (Array.isArray(req.user?.companyCodes) && req.user.companyCodes[0]) || null;

  if (role !== "admin" && role !== "finance" && role !== "logistics") {
    return res.status(403).json({
      error: "Access denied. finance, admin, or logistics role required.",
    });
  }
  if (role === "logistics" && !userCompanyCode) {
    return res.status(403).json({
      error: "logistics user missing companyCode binding — cannot scope supplier filter",
    });
  }

  const pool = getPool();

  try {
    const {
      bl_no,
      supplier,          // NOTE: ignored for logistics role (see below)
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

    // supplier filter — logistics role: enforce company_code binding from JWT (stable across name format variations)
    // ?supplier= query param is IGNORED for logistics to prevent cross-supplier data leakage
    if (role === "logistics") {
      params.push(userCompanyCode);
      conds.push(`supplier_company_code = $${params.length}`);
      // req.query.supplier is intentionally dropped — JWT companyCode is the only source of truth
    } else if (supplier) {
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
         sale_amount,
         currency,
         qty,
         unit_price,
         charge_basis,
         remarks,
         pair_id,
         rebill_status,
         incoterm,
         link_plan_id,
         link_agency_id,
         reconciled,
         reconcile_note,
         source_row,
         confirmed_at,
         confirmed_by,
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
