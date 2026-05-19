// /api/db/partner-relationships.js
// GET ?company_code_a=X | company_code_b=X [&relationship_type=Y] [&status=Z]
//   → list partner relationships (with partner names joined from customers)
//
// Auth: scope-checked — user must own one of the codes (or admin)

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const isAdmin = req.user && req.user.role === "admin";
  const userCodes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : []);

  const codeA = (req.query.company_code_a || "").trim();
  const codeB = (req.query.company_code_b || "").trim();
  const relType = (req.query.relationship_type || "").trim();
  const status = (req.query.status || "active").trim();

  if (!codeA && !codeB) return res.status(400).json({ error: "company_code_a or company_code_b required" });

  // Scope check
  if (!isAdmin) {
    if (userCodes.length === 0) return res.status(403).json({ error: "Account scope missing" });
    if (codeA && !userCodes.includes(codeA)) return res.status(403).json({ error: "Out of scope (code_a)" });
    if (codeB && !userCodes.includes(codeB)) return res.status(403).json({ error: "Out of scope (code_b)" });
  }

  try {
    const pool = getPool();
    const where = ["pr.status = $1"];
    const params = [status];
    if (codeA) { params.push(codeA); where.push(`pr.company_code_a = $${params.length}`); }
    if (codeB) { params.push(codeB); where.push(`pr.company_code_b = $${params.length}`); }
    if (relType) { params.push(relType); where.push(`pr.relationship_type = $${params.length}`); }

    // If filtering by code_a, join customers on code_b (= partner). If by code_b, join on code_a.
    const partnerJoinCol = codeA ? "pr.company_code_b" : "pr.company_code_a";
    const result = await pool.query(
      `SELECT pr.*,
              ca.name_en AS partner_name_en, ca.name_cn AS partner_name_cn
       FROM partner_relationships pr
       LEFT JOIN customers ca ON ca.company_code = ${partnerJoinCol}
       WHERE ${where.join(" AND ")}
       ORDER BY pr.company_code_b, pr.company_code_a`,
      params
    );
    return res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (e) {
    console.error("[partner-relationships]", e);
    return res.status(500).json({ error: e.message });
  }
}
