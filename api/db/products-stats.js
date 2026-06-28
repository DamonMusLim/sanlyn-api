// products-stats.js
// Aggregate KPIs for the Product Library page header.
//
// GET /api/db/products-stats
//   ?role=admin|factory|buyer|trader   (filters scope; factory only sees own)
//   ?factory_code=ZC                    (factory role: forced)
//
// Returns: { total, factories, categories, brands, low_stock, by_factory[], by_category[] }

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  var pool = getPool();
  var role = req.query.role || "admin";
  var factoryCode = req.query.factory_code || "";

  try {
    var where = ["active = true"];
    var args = [];
    if (role === "factory") {
      if (!factoryCode) return res.status(400).json({ error: "factory role requires factory_code" });
      args.push(factoryCode); where.push("factory_code = $" + args.length);
    } else if (factoryCode) {
      args.push(factoryCode); where.push("factory_code = $" + args.length);
    }
    var whereSQL = where.join(" AND ");

    var headline = await pool.query(
      "SELECT " +
        "COUNT(*)::int AS total, " +
        "COUNT(DISTINCT factory_code)::int AS factories, " +
        "COUNT(DISTINCT category)::int AS categories, " +
        "COUNT(DISTINCT brand)::int AS brands, " +
        "COUNT(*) FILTER (WHERE stock > 0 AND stock < 500)::int AS low_stock, " +
        "COUNT(*) FILTER (WHERE stock = 0)::int AS out_of_stock " +
      "FROM products WHERE " + whereSQL,
      args
    );

    var byFactory = await pool.query(
      "SELECT factory_code, COUNT(*)::int AS count FROM products WHERE " + whereSQL +
      " AND factory_code IS NOT NULL AND factory_code != '' GROUP BY factory_code ORDER BY count DESC",
      args
    );

    var byCategory = await pool.query(
      "SELECT category, COUNT(*)::int AS count FROM products WHERE " + whereSQL +
      " AND category IS NOT NULL AND category != '' GROUP BY category ORDER BY count DESC",
      args
    );

    var byBrand = await pool.query(
      "SELECT brand, COUNT(*)::int AS count FROM products WHERE " + whereSQL +
      " AND brand IS NOT NULL AND brand != '' GROUP BY brand ORDER BY count DESC LIMIT 20",
      args
    );

    return res.status(200).json({
      success: true,
      role,
      headline: headline.rows[0],
      by_factory:  byFactory.rows,
      by_category: byCategory.rows,
      by_brand:    byBrand.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
