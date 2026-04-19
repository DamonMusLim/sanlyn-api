import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, PUT, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // PUT = update single product
  if (req.method === "PUT") {
    try {
      var pool = getPool();
      var b = req.body || {};
      if (!b.sku) return res.status(400).json({ error: "sku required" });
      var sets = [], vals = [], n = 0;
      var fields = [
        "product_name","product_name_cn","brand","size","unit","price","cbm",
        "net_weight","gross_weight","barcode","hs_code","active",
        "factory_price","sanlyn_price","price_usd","tax_rate","rebate_rate",
        "cat1","cat2","cat3","cat1_cn","cat2_cn","cat3_cn",
        "trade_terms","declaration_name","declaration_elements","bl_description",
        "factory_name","declaration_amount","bg_bx","flavor","moq","spec","image_url",
        "shelf_life_days"
      ];
      for (var f of fields) {
        if (b[f] !== undefined) {
          n++;
          sets.push(f + " = $" + n);
          vals.push(b[f]);
        }
      }
      if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });
      n++;
      sets.push("updated_at = NOW()");
      vals.push(b.sku);
      var sql = "UPDATE products SET " + sets.join(", ") + " WHERE sku = $" + n + " RETURNING *";
      var result = await pool.query(sql, vals);
      if (result.rows.length === 0) return res.status(404).json({ error: "product not found" });
      return res.status(200).json({ data: result.rows[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // PATCH = update HS Code / declaration fields on a product by id
  if (req.method === "PATCH") {
    try {
      if (!req.user || !["admin", "logistics"].includes(req.user.role)) {
        return res.status(403).json({ error: "Forbidden: admin or logistics only" });
      }
      const pool = getPool();
      const id = req.params?.id || req.query?.id || req.body?.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const { hsCode, declarationName, declarationElements, declarationPrice, blDescription } = req.body;
      const patch = {};
      if (hsCode             != null) patch.hsCode             = hsCode;
      if (declarationName    != null) patch.declarationName    = declarationName;
      if (declarationElements!= null) patch.declarationElements= declarationElements;
      if (declarationPrice   != null) patch.declarationPrice   = declarationPrice;
      if (blDescription      != null) patch.blDescription      = blDescription;
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: "no fields to patch" });
      const r = await pool.query(
        `UPDATE products SET raw = COALESCE(raw,'{}') || $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING id`,
        [JSON.stringify(patch), id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: "product not found" });
      return res.status(200).json({ success: true, id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    var pool = getPool();
    var { brand, category, cat1, cat2, cat3, search, limit = 1000, offset = 0 } = req.query;

    var query = "SELECT * FROM products", params = [], conds = [];

    if (brand) {
      params.push(brand);
      conds.push("brand = $" + params.length);
    }
    if (category || cat1) {
      params.push(cat1 || category);
      conds.push("(cat1 = $" + params.length + " OR category = $" + params.length + ")");
    }
    if (cat2) {
      params.push(cat2);
      conds.push("cat2 = $" + params.length);
    }
    if (cat3) {
      params.push(cat3);
      conds.push("cat3 = $" + params.length);
    }
    if (search) {
      params.push("%" + search + "%");
      conds.push("(sku ILIKE $" + params.length + " OR product_name ILIKE $" + params.length + " OR product_name_cn ILIKE $" + params.length + " OR brand ILIKE $" + params.length + ")");
    }

    // Default: only active
    conds.push("active = true");

    if (conds.length) query += " WHERE " + conds.join(" AND ");

    // Count total
    var countQ = query.replace("SELECT *", "SELECT COUNT(*) as total");
    var countR = await pool.query(countQ, params);

    params.push(parseInt(limit));
    query += " ORDER BY id DESC LIMIT $" + params.length;
    params.push(parseInt(offset));
    query += " OFFSET $" + params.length;

    var result = await pool.query(query, params);

    // Category summary
    var catSummary = null;
    if (req.query.summary === "1") {
      var catQ = await pool.query("SELECT cat1, cat2, COUNT(*) as cnt FROM products WHERE active = true AND cat1 != '' GROUP BY cat1, cat2 ORDER BY cat1, cnt DESC");
      catSummary = catQ.rows;
    }

    return res.status(200).json({
      data: result.rows,
      count: result.rows.length,
      total: parseInt(countR.rows[0].total),
      categories: catSummary,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
