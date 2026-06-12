// brand-permissions.js — CRUD for company_brand_permissions
// GET/POST/PATCH/DELETE /api/db/brand-permissions
import { getPool, setCors } from "../db.js";
import { requireRole } from "../auth.js";

const VALID_VISIBILITY = ["full", "rfq", "hidden"];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireRole(req, res, ["admin"])) return;

  const pool = getPool();

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { company_code } = req.query;
    if (company_code) {
      const { rows } = await pool.query(
        `SELECT * FROM company_brand_permissions
         WHERE company_code = $1
         ORDER BY brand`,
        [company_code]
      );
      return res.status(200).json({ data: rows });
    } else {
      // All rows — useful for overview; include per-company brand count
      const { rows } = await pool.query(
        `SELECT *, COUNT(*) OVER (PARTITION BY company_code) AS brand_count
         FROM company_brand_permissions
         ORDER BY company_code, brand`
      );
      return res.status(200).json({ data: rows });
    }
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const { company_code, brand, visibility = "full", note = "" } = req.body || {};

    if (!company_code || !brand) {
      return res.status(400).json({ error: "company_code and brand are required" });
    }
    if (!VALID_VISIBILITY.includes(visibility)) {
      return res.status(400).json({ error: `visibility must be one of: ${VALID_VISIBILITY.join(", ")}` });
    }

    const actor = req.user?.account || req.user?.sub || "admin";

    const { rows } = await pool.query(
      `INSERT INTO company_brand_permissions
         (tenant_code, company_code, brand, visibility, source, note, created_by, updated_by)
       VALUES ('SANLYN', $1, $2, $3, 'manual', $4, $5, $5)
       ON CONFLICT (tenant_code, company_code, brand)
       DO UPDATE SET
         visibility = $3,
         note       = $4,
         updated_by = $5,
         updated_at = NOW()
       RETURNING *`,
      [company_code, brand.trim().toUpperCase(), visibility, note, actor]
    );

    return res.status(200).json({ success: true, data: rows[0] });
  }

  // ── PATCH ─────────────────────────────────────────────────────────────────
  if (req.method === "PATCH") {
    const id = req.params?.id || req.query?.id || req.body?.id;
    if (!id) return res.status(400).json({ error: "id is required" });

    const { visibility, note } = req.body || {};
    const actor = req.user?.account || req.user?.sub || "admin";

    const sets = [];
    const vals = [];
    let idx = 1;

    if (visibility !== undefined) {
      if (!VALID_VISIBILITY.includes(visibility)) {
        return res.status(400).json({ error: `visibility must be one of: ${VALID_VISIBILITY.join(", ")}` });
      }
      sets.push(`visibility = $${idx++}`);
      vals.push(visibility);
    }
    if (note !== undefined) {
      sets.push(`note = $${idx++}`);
      vals.push(note);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    sets.push(`updated_by = $${idx++}`);
    vals.push(actor);
    sets.push(`updated_at = NOW()`);
    // idx now points to the next placeholder for the WHERE clause
    vals.push(id);

    const { rows } = await pool.query(
      `UPDATE company_brand_permissions
       SET ${sets.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      vals
    );

    if (rows.length === 0) return res.status(404).json({ error: "Row not found" });
    return res.status(200).json({ success: true, data: rows[0] });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    const id = req.params?.id || req.query?.id || req.body?.id;
    if (!id) return res.status(400).json({ error: "id is required" });

    const { rowCount } = await pool.query(
      `DELETE FROM company_brand_permissions WHERE id = $1`,
      [id]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Row not found" });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
