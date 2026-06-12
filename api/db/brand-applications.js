// /api/db/brand-applications.js
// POST    → submit a new brand application (customer-initiated)
// GET     → list applications (admin = all; non-admin = own only)
// PATCH   → admin approves/rejects an application
//
// On approve: writes a row into company_brand_permissions (full visibility).
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const isAdmin = req.user && req.user.role === "admin";
  const pool = getPool();

  // ── POST: new application ──────────────────────────────────────────────
  if (req.method === "POST") {
    const body = req.body || {};
    const brand = String(body.brand || "").trim();
    const factoryCode = String(body.factoryCode || "").trim() || null;
    const targetCountry = String(body.targetCountry || "").trim() || null;
    const notes = body.notes || null;

    // Applicant company: caller's own (non-admin) or specified (admin)
    let applicant = String(body.applicantCompanyCode || "").trim();
    if (!isAdmin) {
      const codes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : []);
      if (!codes.length) return res.status(403).json({ error: "Account scope missing" });
      if (applicant && !codes.includes(applicant)) {
        return res.status(403).json({ error: "Out of scope" });
      }
      if (!applicant) applicant = codes[0];
    }
    if (!applicant || !brand) {
      return res.status(400).json({ error: "applicantCompanyCode and brand are required" });
    }

    try {
      const r = await pool.query(
        `INSERT INTO brand_applications
           (applicant_company_code, brand, factory_code, target_country, status, applied_by, notes)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         RETURNING id, status, applied_at`,
        [applicant, brand, factoryCode, targetCountry, req.user.account || req.user.companyCode || "", notes]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── GET: list applications ──────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const status = (req.query.status || "").trim();
      const params = [];
      let where = [];
      if (status) { params.push(status); where.push("status = $" + params.length); }
      if (!isAdmin) {
        const codes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : []);
        if (!codes.length) return res.status(403).json({ error: "Account scope missing" });
        params.push(codes);
        where.push("applicant_company_code = ANY($" + params.length + "::text[])");
      } else if (req.query.applicantCompanyCode) {
        params.push(req.query.applicantCompanyCode);
        where.push("applicant_company_code = $" + params.length);
      }
      const sql = "SELECT * FROM brand_applications" +
                  (where.length ? " WHERE " + where.join(" AND ") : "") +
                  " ORDER BY applied_at DESC LIMIT 200";
      const r = await pool.query(sql, params);
      return res.status(200).json({ success: true, data: r.rows, count: r.rows.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── PATCH: admin approves/rejects ───────────────────────────────────────
  if (req.method === "PATCH") {
    if (!isAdmin) return res.status(403).json({ error: "Admin only" });
    const id = req.query.id || (req.body && req.body.id);
    const action = (req.body && req.body.status) || "";
    const reviewNotes = (req.body && req.body.reviewNotes) || null;
    if (!id || !["approved", "rejected"].includes(action)) {
      return res.status(400).json({ error: "id + status (approved|rejected) required" });
    }
    const reviewer = req.user.account || req.user.companyCode || "admin";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const app = await client.query(
        `UPDATE brand_applications
            SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_notes = $3, updated_at = NOW()
          WHERE id = $4
          RETURNING *`,
        [action, reviewer, reviewNotes, id]
      );
      if (!app.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
      const row = app.rows[0];

      if (action === "approved") {
        // Idempotent grant: upsert company_brand_permissions(company_code, brand) = full
        // source CHECK constraint allows: manual / migrated_from_customers_brands / contract / system / import
        await client.query(
          `INSERT INTO company_brand_permissions
             (tenant_code, company_code, brand, visibility, source, created_by, note)
           VALUES ('SANLYN', $1, $2, 'full', 'manual', $3, $4)
           ON CONFLICT DO NOTHING`,
          [row.applicant_company_code, row.brand, reviewer, "Granted via brand application #" + row.id + ". " + (reviewNotes || "")]
        );
      }
      await client.query("COMMIT");
      return res.status(200).json({ success: true, data: row });
    } catch (e) {
      await client.query("ROLLBACK");
      return res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
