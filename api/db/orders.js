import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    let { customer, status, limit = 500, brands, factory, company_code, company_codes } = req.query;
    // Tenant scoping: non-admin users can only see their own company's orders
    if (req.user && req.user.role !== "admin") {
      const userCodes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : null);
      if (userCodes && userCodes.length > 0) {
        company_codes = JSON.stringify(userCodes);
        company_code  = undefined;
      }
    }
    let query = "SELECT * FROM orders", params = [], conds = [];
    if (customer) { params.push(`%${customer}%`); conds.push(`customer ILIKE $${params.length}`); }
    if (status)   { params.push(status);           conds.push(`status = $${params.length}`); }
    if (factory)  { params.push(factory);           conds.push(`raw->>'factory' = $${params.length}`); }
    if (company_codes) {
      let codeList; try { codeList = JSON.parse(company_codes); } catch { codeList = company_codes.split(","); }
      if (codeList.length > 0) {
        const ph = codeList.map(function(c) { params.push(c); return "$" + params.length; });
        // Match either the buyer (company_code / raw.companyCode) OR the factory
        // (raw.factoryCompanyCode). Lets factory portal accounts see the orders
        // they are supplying, e.g. HENGAN sees HARMONIOUS's 48-4 because it ships it.
        conds.push(
          "(raw->>'companyCode' IN (" + ph.join(",") + ")" +
          " OR company_code IN (" + ph.join(",") + ")" +
          " OR raw->>'factoryCompanyCode' IN (" + ph.join(",") + "))"
        );
      }
    } else if (company_code) {
      params.push(company_code);
      conds.push(
        "(raw->>'companyCode' = $" + params.length +
        " OR company_code = $" + params.length +
        " OR raw->>'factoryCompanyCode' = $" + params.length + ")"
      );
    }
    if (brands) {
      let brandList;
      try { brandList = JSON.parse(brands); } catch { brandList = [brands]; }
      if (brandList.length > 0) {
        const orClauses = [];
        brandList.forEach(brand => { params.push(brand); orClauses.push(`raw->>'_widget_1775071325804' = $${params.length}`); });
        brandList.forEach(brand => { params.push(`%${brand}%`); orClauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(raw->'products') p WHERE p->>'name' ILIKE $${params.length})`); });
        conds.push(`(${orClauses.join(' OR ')})`);
      }
    }
    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
