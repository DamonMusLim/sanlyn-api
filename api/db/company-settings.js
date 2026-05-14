import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// /api/db/company-settings
// GET  — return trade_terms + port_default for the caller's own company
// PATCH { trade_terms?, port_default? } — self-service update (own company only)
//
// No admin-only gate: a factory should be able to set its own defaults.

const ALLOWED_TRADE_TERMS = ['FOB', 'CIF', 'CFR', 'EXW', 'DAP', 'DDP', 'FCA', 'CPT'];

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const userId = req.user?.id;
  const companyId = req.user?.company_id;

  if (!companyId) {
    return res.status(400).json({ success: false, error: "No company_id on token — cannot identify company." });
  }

  try {
    if (req.method === "GET") {
      const r = await pool.query(
        "SELECT id, company_code, trade_terms, port_default FROM customers WHERE id = $1",
        [companyId]
      );
      if (!r.rows[0]) return res.status(404).json({ success: false, error: "Company not found." });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    if (req.method === "PATCH") {
      const { trade_terms, port_default } = req.body || {};
      const sets = [], params = [];

      if (trade_terms !== undefined) {
        const val = String(trade_terms).toUpperCase().trim();
        if (val && !ALLOWED_TRADE_TERMS.includes(val)) {
          return res.status(400).json({ success: false, error: `trade_terms must be one of: ${ALLOWED_TRADE_TERMS.join(', ')}` });
        }
        params.push(val || null);
        sets.push(`trade_terms = $${params.length}`);
      }

      if (port_default !== undefined) {
        params.push(String(port_default).trim() || null);
        sets.push(`port_default = $${params.length}`);
      }

      if (!sets.length) return res.status(400).json({ success: false, error: "Nothing to update." });

      params.push(companyId);
      sets.push("updated_at = NOW()");

      const r = await pool.query(
        `UPDATE customers SET ${sets.join(", ")} WHERE id = $${params.length - 1} RETURNING id, trade_terms, port_default`,
        params
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    return res.status(405).json({ success: false, error: "Method not allowed." });
  } catch (err) {
    console.error("[company-settings]", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
}
