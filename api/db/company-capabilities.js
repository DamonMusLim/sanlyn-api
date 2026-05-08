import { getPool, setCors } from "../db.js";

// ═══════════════════════════════════════════════════════════════
// /api/db/company-capabilities — what each company can do (v2 Network)
//
// GET    ?company=<id>                     — list this company's capabilities
// GET    ?capability=<cap>&published=1     — directory: who can do X
// GET    ?capability=<cap>&category=<cat>&published=1 — narrowed directory
// POST   { company_id, capability, ... }   — upsert capability
// PATCH  { company_id, capability, ... }   — same as POST
// DELETE ?company=<id>&capability=<cap>    — remove capability
// ═══════════════════════════════════════════════════════════════

var VALID_CAPABILITIES = [
  'manufacture', 'trade', 'shipping', 'trucking', 'customs',
  'warehouse', 'inspection', 'insurance', 'finance', 'translation'
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();

    if (req.method === "GET") {
      var { company, capability, category, published, limit = 200 } = req.query;
      var conds = [], params = [];
      if (company)    { params.push(parseInt(company)); conds.push("cc.company_id = $" + params.length); }
      if (capability) { params.push(capability); conds.push("cc.capability = $" + params.length); }
      if (category)   { params.push(category); conds.push("cc.category = $" + params.length); }
      if (published)  { conds.push("cc.is_published = true"); }

      var query = `SELECT cc.*, c.name_en, c.name_cn, c.country, c.company_code
        FROM company_capabilities cc
        LEFT JOIN customers c ON c.id = cc.company_id`;
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      query += " ORDER BY cc.sanlyn_score DESC NULLS LAST, cc.updated_at DESC";
      params.push(parseInt(limit));
      query += " LIMIT $" + params.length;

      var result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    }

    if (req.method === "POST" || req.method === "PATCH") {
      var body = req.body || {};
      var { company_id, capability, capabilities, category, moq, lead_days, capacity, pricing_note,
            cert_list, verified_by, verified_at, sanlyn_score, is_published, raw } = body;
      if (!company_id) {
        return res.status(400).json({ success: false, error: "company_id required" });
      }

      // Batch mode: { company_id, capabilities: ['manufacture', 'trade', ...] }
      // Replaces all capabilities for this company.
      if (Array.isArray(capabilities)) {
        var invalid = capabilities.filter(c => !VALID_CAPABILITIES.includes(c));
        if (invalid.length) {
          return res.status(400).json({ success: false, error: "invalid capabilities: " + invalid.join(",") });
        }
        await pool.query("DELETE FROM company_capabilities WHERE company_id = $1", [parseInt(company_id)]);
        var inserted = [];
        for (var cap of capabilities) {
          var r = await pool.query(
            `INSERT INTO company_capabilities (company_id, capability, is_published) VALUES ($1,$2,true)
             ON CONFLICT (company_id, capability) DO UPDATE SET is_published=true, updated_at=NOW() RETURNING *`,
            [parseInt(company_id), cap]
          );
          if (r.rows[0]) inserted.push(r.rows[0]);
        }
        return res.status(200).json({ success: true, data: inserted, count: inserted.length });
      }

      // Single capability mode
      if (!capability) {
        return res.status(400).json({ success: false, error: "capability or capabilities[] required" });
      }
      if (!VALID_CAPABILITIES.includes(capability)) {
        return res.status(400).json({ success: false, error: "capability must be one of " + VALID_CAPABILITIES.join(",") });
      }
      var sql = `INSERT INTO company_capabilities
        (company_id, capability, category, moq, lead_days, capacity, pricing_note,
         cert_list, verified_by, verified_at, sanlyn_score, is_published, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (company_id, capability) DO UPDATE SET
          category = EXCLUDED.category,
          moq = EXCLUDED.moq,
          lead_days = EXCLUDED.lead_days,
          capacity = EXCLUDED.capacity,
          pricing_note = EXCLUDED.pricing_note,
          cert_list = EXCLUDED.cert_list,
          verified_by = COALESCE(EXCLUDED.verified_by, company_capabilities.verified_by),
          verified_at = COALESCE(EXCLUDED.verified_at, company_capabilities.verified_at),
          sanlyn_score = COALESCE(EXCLUDED.sanlyn_score, company_capabilities.sanlyn_score),
          is_published = EXCLUDED.is_published,
          raw = EXCLUDED.raw,
          updated_at = NOW()
        RETURNING *`;
      var result = await pool.query(sql, [
        company_id, capability, category || '', moq || '', lead_days || null,
        capacity || '', pricing_note || '', JSON.stringify(cert_list || []),
        verified_by || '', verified_at || null, sanlyn_score || null,
        !!is_published, JSON.stringify(raw || {})
      ]);
      return res.status(200).json({ success: true, data: result.rows[0] });
    }

    if (req.method === "DELETE") {
      var { company, capability } = req.query || {};
      if (!company || !capability) return res.status(400).json({ success: false, error: "company and capability required" });
      await pool.query("DELETE FROM company_capabilities WHERE company_id = $1 AND capability = $2", [parseInt(company), capability]);
      return res.status(200).json({ success: true, deleted: { company_id: parseInt(company), capability } });
    }

    return res.status(405).json({ success: false, error: "method not allowed" });
  } catch (err) {
    console.error("[company-capabilities] error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
}
