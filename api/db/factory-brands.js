// /api/db/factory-brands.js
// GET ?factoryCode=X[&buyerCompanyCode=Y]
//   → brands available at this factory, with authorization flag per buyer.
//
// Response shape:
//   { success: true,
//     factoryCode, buyerCompanyCode,
//     data: [ { brand, status, source, authorized: bool, unlocked_countries: [...] } ] }
//
// Auth: admin or self-scope (buyerCompanyCode must be within JWT companyCodes when not admin).
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const factoryCode = (req.query.factoryCode || "").trim();
  const buyerCompanyCode = (req.query.buyerCompanyCode || "").trim();
  if (!factoryCode) return res.status(400).json({ error: "factoryCode is required" });

  const isAdmin = req.user && req.user.role === "admin";
  if (!isAdmin && buyerCompanyCode) {
    const userCodes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : []);
    if (!Array.isArray(userCodes) || userCodes.length === 0) {
      return res.status(403).json({ error: "Account scope missing", code: "SCOPE_MISSING" });
    }
    if (!userCodes.includes(buyerCompanyCode)) {
      return res.status(403).json({ error: "Out of scope" });
    }
  }

  try {
    const pool = getPool();

    // 1) Brands available at this factory
    const fbRes = await pool.query(
      `SELECT brand, status, source
         FROM factory_brands
        WHERE factory_code = $1 AND status = 'active'
        ORDER BY brand`,
      [factoryCode]
    );

    // 2) Authorization map for the buyer (if provided)
    let authSet = new Set();
    if (buyerCompanyCode) {
      const authRes = await pool.query(
        `SELECT brand FROM company_brand_permissions
          WHERE tenant_code = 'SANLYN'
            AND company_code = $1
            AND visibility IN ('full','rfq')`,
        [buyerCompanyCode]
      );
      authSet = new Set(authRes.rows.map(r => String(r.brand).toUpperCase()));
    }

    // 3) Country-unlock map (which countries have ever been sold for each brand)
    const brands = fbRes.rows.map(r => r.brand);
    let countryMap = new Map();
    if (brands.length) {
      const cuRes = await pool.query(
        `SELECT brand, ARRAY_AGG(country ORDER BY country) AS countries
           FROM brand_country_unlocks
          WHERE brand = ANY($1::text[])
          GROUP BY brand`,
        [brands]
      );
      cuRes.rows.forEach(r => countryMap.set(r.brand, r.countries || []));
    }

    const data = fbRes.rows.map(r => ({
      brand: r.brand,
      status: r.status,
      source: r.source,
      authorized: buyerCompanyCode ? authSet.has(String(r.brand).toUpperCase()) : null,
      unlocked_countries: countryMap.get(r.brand) || [],
    }));

    return res.status(200).json({
      success: true,
      factoryCode,
      buyerCompanyCode: buyerCompanyCode || null,
      data,
      count: data.length,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
