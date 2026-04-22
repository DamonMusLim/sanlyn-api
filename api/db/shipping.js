import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard

// Derive a short matching keyword from a Chinese company name.
// Strategy: strip brackets/punctuation, take leading 2–3 Chinese chars.
// Examples:
//   "万汇国际（厦门）"            → "万汇"
//   "厦门欣力通报关有限公司"     → "欣力通"  (skip leading geo prefix)
//   "瀚龙物流"                     → "瀚龙"
function supplierKeyword(company) {
  if (!company) return "";
  const geoPrefixes = ["厦门", "上海", "天津", "青岛", "宁波", "深圳", "山东", "江苏"];
  let s = String(company).replace(/[（）()【】\[\]\s]/g, "");
  for (const g of geoPrefixes) if (s.startsWith(g) && s.length > g.length + 1) s = s.slice(g.length);
  const m = s.match(/[\u4e00-\u9fa5]{2,4}/);
  return m ? m[0].slice(0, 2) : "";
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
    const u = req.user || {};
    if (u.role === "logistics") {
      const col = u.supplierRole === "ocean" ? "forwarder_cn"
               : u.supplierRole === "customs" ? "customs_cn"
               : u.supplierRole === "truck"   ? "trucking_cn"
               : null;
      const kw = supplierKeyword(u.company);
      if (!col || !kw) {
        // Misconfigured account → return empty set rather than leak everything
        return res.status(200).json({ success: true, data: [], count: 0, scoped: "logistics:empty" });
      }
      params.push(`%${kw}%`);
      conds.push(`${col} ILIKE $${params.length}`);
    }

    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY etd DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
