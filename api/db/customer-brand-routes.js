// /api/db/customer-brand-routes.js
// Factory-self-managed brand→customer authorization routes
//
// GET    ?factory_code=X[&customer_code=Y][&brand=Z]
//   → list routes for this factory (admin can see all)
// POST   { factory_code, brand, customer_code, signed_nda?, notes? }
//   → add a new authorization
// PATCH  /:id  { signed_nda?, status?, notes? }
//   → update existing route
// DELETE /:id
//   → remove route
//
// Auth: factory self (companyCode === factory_code) OR admin
// Schema: see data-ops/brand-authorizations-2026-05-18.sql

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const isAdmin = req.user && req.user.role === "admin";
  const userCodes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : []);

  // Extract :id from URL path (handles /api/db/customer-brand-routes/123)
  const pathParts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idFromPath = pathParts.length > 0 && /^\d+$/.test(pathParts[pathParts.length - 1])
    ? parseInt(pathParts[pathParts.length - 1], 10) : null;

  try {
    // ── GET: list routes ──
    if (req.method === "GET") {
      const factoryCode = (req.query.factory_code || "").trim();
      const customerCode = (req.query.customer_code || "").trim();
      const brand = (req.query.brand || "").trim();

      const where = ["r.status = 'active'"];
      const params = [];
      if (factoryCode) {
        params.push(factoryCode);
        where.push(`r.factory_code = $${params.length}`);
      }
      if (customerCode) {
        params.push(customerCode);
        where.push(`r.customer_code = $${params.length}`);
      }
      if (brand) {
        params.push(brand);
        where.push(`r.brand = $${params.length}`);
      }

      // Scope: factory self OR customer self OR admin
      if (!isAdmin) {
        if (userCodes.length === 0) return res.status(403).json({ error: "Account scope missing" });
        const placeholders = userCodes.map((_, i) => `$${params.length + i + 1}`).join(",");
        userCodes.forEach((c) => params.push(c));
        where.push(`(r.factory_code IN (${placeholders}) OR r.customer_code IN (${placeholders.split(",").map((_, i) => `$${params.length - userCodes.length + i + 1}`).join(",")}))`);
        // The above is messy — simpler: require either factory_code or customer_code to be in user's scope
        // Rebuild cleanly:
      }

      // Cleaner scope filter
      let query = `SELECT r.*,
                          c1.name_en AS customer_name,
                          c1.name_cn AS customer_name_cn
                   FROM customer_brand_routes r
                   LEFT JOIN customers c1 ON c1.company_code = r.customer_code
                   WHERE r.status = 'active'`;
      const qp = [];
      if (factoryCode) { qp.push(factoryCode); query += ` AND r.factory_code = $${qp.length}`; }
      if (customerCode) { qp.push(customerCode); query += ` AND r.customer_code = $${qp.length}`; }
      if (brand) { qp.push(brand); query += ` AND r.brand = $${qp.length}`; }
      if (!isAdmin && userCodes.length > 0) {
        const ph = userCodes.map((_, i) => `$${qp.length + i + 1}`).join(",");
        userCodes.forEach((c) => qp.push(c));
        query += ` AND (r.factory_code IN (${ph}) OR r.customer_code IN (${ph}))`;
      } else if (!isAdmin) {
        return res.status(403).json({ error: "Out of scope" });
      }
      query += ` ORDER BY r.factory_code, r.brand, r.customer_code`;

      const result = await pool.query(query, qp);
      return res.json({ success: true, data: result.rows, count: result.rows.length });
    }

    // ── POST: add a route ──
    if (req.method === "POST") {
      const { factory_code, brand, customer_code, signed_nda, notes } = req.body || {};
      if (!factory_code || !brand || !customer_code) {
        return res.status(400).json({ error: "factory_code, brand, customer_code required" });
      }
      // Scope: must own this factory_code (or admin)
      if (!isAdmin && !userCodes.includes(factory_code)) {
        return res.status(403).json({ error: "Cannot authorize routes for a factory you don't own" });
      }
      const result = await pool.query(
        `INSERT INTO customer_brand_routes (customer_code, brand, factory_code, signed_nda, status, granted_at, granted_by, notes)
         VALUES ($1, $2, $3, $4, 'active', NOW(), $5, $6)
         ON CONFLICT (customer_code, brand, factory_code)
           DO UPDATE SET signed_nda = EXCLUDED.signed_nda, status = 'active', notes = COALESCE(EXCLUDED.notes, customer_brand_routes.notes)
         RETURNING *`,
        [customer_code, brand, factory_code, !!signed_nda, req.user.username || req.user.account || null, notes || null]
      );
      return res.json({ success: true, data: result.rows[0] });
    }

    // ── PATCH /:id ──
    if (req.method === "PATCH") {
      if (!idFromPath) return res.status(400).json({ error: "id required in URL" });
      const { signed_nda, status, notes } = req.body || {};
      // Check ownership first
      const existing = await pool.query(`SELECT factory_code FROM customer_brand_routes WHERE id = $1`, [idFromPath]);
      if (!existing.rows.length) return res.status(404).json({ error: "Not found" });
      if (!isAdmin && !userCodes.includes(existing.rows[0].factory_code)) {
        return res.status(403).json({ error: "Cannot modify routes for a factory you don't own" });
      }
      const sets = [];
      const params = [];
      if (typeof signed_nda === "boolean") { params.push(signed_nda); sets.push(`signed_nda = $${params.length}`); }
      if (typeof status === "string") { params.push(status); sets.push(`status = $${params.length}`); }
      if (typeof notes === "string") { params.push(notes); sets.push(`notes = $${params.length}`); }
      if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
      params.push(idFromPath);
      const result = await pool.query(
        `UPDATE customer_brand_routes SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params
      );
      return res.json({ success: true, data: result.rows[0] });
    }

    // ── DELETE /:id (soft delete via status='revoked') ──
    if (req.method === "DELETE") {
      if (!idFromPath) return res.status(400).json({ error: "id required in URL" });
      const existing = await pool.query(`SELECT factory_code FROM customer_brand_routes WHERE id = $1`, [idFromPath]);
      if (!existing.rows.length) return res.status(404).json({ error: "Not found" });
      if (!isAdmin && !userCodes.includes(existing.rows[0].factory_code)) {
        return res.status(403).json({ error: "Cannot delete routes for a factory you don't own" });
      }
      await pool.query(`UPDATE customer_brand_routes SET status = 'revoked' WHERE id = $1`, [idFromPath]);
      return res.json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[customer-brand-routes]", e);
    return res.status(500).json({ error: e.message });
  }
}
