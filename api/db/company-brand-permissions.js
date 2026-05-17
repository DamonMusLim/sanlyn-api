// /api/db/company-brand-permissions.js
// GET  ?companyCode=XXX → brand permissions for that company (admin or self).
// POST { company_code, brand, visibility, note? } → upsert permission (admin only).
// DELETE ?companyCode=XXX&brand=YYY → remove permission (admin only).
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const isAdmin = req.user && req.user.role === "admin";

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const code = (req.query.companyCode || "").trim();
    if (!code) return res.status(400).json({ error: "companyCode is required" });
    if (!isAdmin) {
      const userCodes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : []);
      if (!Array.isArray(userCodes) || userCodes.length === 0)
        return res.status(403).json({ error: "Account scope missing", code: "SCOPE_MISSING" });
      if (!userCodes.includes(code))
        return res.status(403).json({ error: "Out of scope" });
    }
    try {
      const pool = getPool();
      const r = await pool.query(
        `SELECT brand, visibility, source, note
           FROM company_brand_permissions
          WHERE tenant_code = 'SANLYN'
            AND company_code = $1
            AND visibility IN ('full','rfq')
          ORDER BY brand`,
        [code]
      );
      return res.status(200).json({ success: true, companyCode: code, data: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST — upsert permission (admin only) ─────────────────────────────
  if (req.method === "POST") {
    if (!isAdmin) return res.status(403).json({ error: "Admin only" });
    const body = req.body || {};
    const rows = Array.isArray(body) ? body : [body];
    if (!rows.length) return res.status(400).json({ error: "Empty payload" });
    try {
      const pool = getPool();
      const results = [];
      for (const item of rows) {
        const { company_code, brand, visibility = "full", note = "", created_by = "admin" } = item;
        if (!company_code || !brand) { results.push({ error: "company_code and brand required", item }); continue; }
        const r = await pool.query(
          `INSERT INTO company_brand_permissions
             (tenant_code, company_code, brand, visibility, source, note, created_by, updated_by, updated_at)
           VALUES ('SANLYN', $1, $2, $3, 'manual', $4, $5, $5, NOW())
           ON CONFLICT (tenant_code, company_code, brand)
           DO UPDATE SET visibility=$3, note=$4, updated_by=$5, updated_at=NOW()
           RETURNING *`,
          [company_code, brand, visibility, note, created_by]
        );
        results.push(r.rows[0]);
      }
      return res.status(200).json({ success: true, data: results });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── DELETE ────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    if (!isAdmin) return res.status(403).json({ error: "Admin only" });
    const { companyCode, brand } = req.query;
    if (!companyCode || !brand) return res.status(400).json({ error: "companyCode and brand required" });
    try {
      const pool = getPool();
      await pool.query(
        `DELETE FROM company_brand_permissions WHERE tenant_code='SANLYN' AND company_code=$1 AND brand=$2`,
        [companyCode, brand]
      );
      return res.status(200).json({ success: true, deleted: { companyCode, brand } });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
