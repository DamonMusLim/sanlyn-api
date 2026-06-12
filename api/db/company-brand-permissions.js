// /api/db/company-brand-permissions.js
// GET  ?companyCode=XXX → brand permissions for that company (admin or self).
// POST { company_code, brand, visibility, is_exclusive?, nda_note?, note? } → upsert (admin only).
// DELETE ?companyCode=XXX&brand=YYY → remove permission (admin only).
//
// Phase 7 (FAIL-CLOSED-2026-05-19): is_exclusive=true marks a brand as NDA-exclusive
// for one company — getBrandScope() will hide that brand from ALL other customers.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// Lazy column migration — adds columns that may be missing on older installs.
let _cbpInited = false;
async function ensureCbpCols(pool) {
  if (_cbpInited) return;
  const cols = [
    ["is_exclusive", "BOOLEAN DEFAULT false"],
    ["nda_note",     "TEXT"],
    ["note",         "TEXT DEFAULT ''"],
    ["updated_by",   "VARCHAR(64) DEFAULT 'admin'"],
    ["updated_at",   "TIMESTAMPTZ DEFAULT NOW()"],
    ["source",       "VARCHAR(32) DEFAULT 'manual'"],
    ["created_by",   "VARCHAR(64) DEFAULT 'admin'"],
  ];
  for (const [col, def] of cols) {
    try {
      await pool.query(`ALTER TABLE company_brand_permissions ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    } catch (_) { /* ignore */ }
  }
  _cbpInited = true;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const isAdmin = req.user && req.user.role === "admin";

  const pool = getPool();
  await ensureCbpCols(pool);

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
      const r = await pool.query(
        `SELECT brand, visibility, source, note,
                COALESCE(is_exclusive, false) AS is_exclusive, nda_note
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
      const results = [];
      for (const item of rows) {
        const {
          company_code, brand, visibility = "full",
          is_exclusive = false, nda_note = null,
          note = "", created_by = "admin",
        } = item;
        if (!company_code || !brand) { results.push({ error: "company_code and brand required", item }); continue; }
        // Explicit UPDATE-then-INSERT avoids requiring a UNIQUE constraint on
        // (tenant_code, company_code, brand) — which may not exist on all envs.
        const upd = await pool.query(
          `UPDATE company_brand_permissions
              SET visibility=$3, note=$4, is_exclusive=$5, nda_note=$6,
                  updated_by=$7, updated_at=NOW()
            WHERE tenant_code='SANLYN' AND company_code=$1 AND brand=$2
            RETURNING id`,
          [company_code, brand, visibility, note, is_exclusive, nda_note, created_by]
        );
        if (upd.rowCount > 0) {
          results.push({ id: upd.rows[0].id, company_code, brand, updated: true });
        } else {
          const ins = await pool.query(
            `INSERT INTO company_brand_permissions
               (tenant_code, company_code, brand, visibility, source, note,
                is_exclusive, nda_note, created_by, updated_by, updated_at)
             VALUES ('SANLYN', $1, $2, $3, 'manual', $4, $5, $6, $7, $7, NOW())
             RETURNING *`,
            [company_code, brand, visibility, note, is_exclusive, nda_note, created_by]
          );
          results.push(ins.rows[0]);
        }
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
