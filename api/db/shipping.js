import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard

// Normalize a Chinese company name for matching:
//  - strip full/half-width brackets, spaces, punctuation
//  - drop leading geo prefix (厦门/上海/天津/…)
//  - drop generic corporate suffixes (有限公司/有限责任公司/股份有限公司/分公司)
// So e.g. both "万汇国际（厦门）" and "万汇国际厦门有限公司" → "万汇国际"
// while "万汇恒通(厦门)国际物流有限公司" → "万汇恒通国际物流" (distinct!)
function normCompany(s) {
  if (!s) return "";
  let x = String(s).replace(/[（）()【】\[\]\s、，,。.·\-_/\\]/g, "");
  const geo = ["厦门","上海","天津","青岛","宁波","深圳","山东","江苏","烟台","福建","广州"];
  for (const g of geo) if (x.startsWith(g) && x.length > g.length + 1) { x = x.slice(g.length); break; }
  x = x.replace(/(股份有限公司|有限责任公司|有限公司|分公司)$/g, "");
  return x;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { customer, created_by, limit = 500 } = req.query;
    let query = "SELECT * FROM shipping_plans", params = [], conds = [];
    if (customer) { params.push(`%${customer}%`); conds.push(`customer ILIKE $${params.length}`); }
    if (created_by) { params.push(created_by); conds.push(`created_by = $${params.length}`); }

    // ── Vendor data scoping: logistics users see ONLY their own shipments ──
    // Strategy: fetch candidate rows then filter in Node by bidirectional
    // normalized-substring match (tighter than SQL ILIKE on a 2-char prefix).
    const u = req.user || {};
    let scopeCol = null, scopeNeedle = "";
    if (u.role === "logistics") {
      scopeCol = u.supplierRole === "ocean" ? "forwarder_cn"
              : u.supplierRole === "customs" ? "customs_cn"
              : u.supplierRole === "truck"   ? "trucking_cn"
              : null;
      scopeNeedle = normCompany(u.company);
      if (!scopeCol || !scopeNeedle) {
        return res.status(200).json({ success: true, data: [], count: 0, scoped: "logistics:empty" });
      }
      // Pre-filter in SQL with a loose 2-char hint to avoid scanning all rows,
      // then apply tight substring check in Node.
      const hint = scopeNeedle.slice(0, 2);
      params.push(`%${hint}%`);
      conds.push(`${scopeCol} ILIKE $${params.length}`);
    }

    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY etd DESC LIMIT $${params.length}`;
    let rows = (await pool.query(query, params)).rows;

    if (scopeCol && scopeNeedle) {
      rows = rows.filter(r => {
        const cell = normCompany(r[scopeCol]);
        return cell && (cell.includes(scopeNeedle) || scopeNeedle.includes(cell));
      });
    }
    return res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
