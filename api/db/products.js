import { getPool, setCors } from "../db.js";

// ── Unknown Field Policy (P1-A) ──────────────────────────────────────────────
// Products PUT: canonical snake_case fields only. 'sku' is the identifier key.
const PRODUCTS_PUT_ALLOWED = new Set([
  "sku",
  "product_name","product_name_cn","brand","size","unit","price","cbm",
  "net_weight","gross_weight","barcode","hs_code","active",
  "factory_price","sanlyn_price","price_usd","tax_rate","rebate_rate",
  "cat1","cat2","cat3","cat1_cn","cat2_cn","cat3_cn",
  "trade_terms","declaration_name","declaration_elements","bl_description",
  "factory_name","declaration_amount","inner_qty","inner_unit","flavor","moq","spec","image_url",
  "shelf_life_days",
]);

// Products PATCH: camelCase collab/declaration fields + identifier. No others.
const PRODUCTS_PATCH_ALLOWED = new Set([
  "id",
  "hsCode","declarationName","declarationElements","declarationPrice","blDescription",
]);

function rejectUnknownFields(allowed, body, res) {
  const bodyKeys = Object.keys(body || {});
  const unknown = bodyKeys.filter(k => !allowed.has(k));
  if (unknown.length > 0) {
    res.status(400).json({
      success: false,
      error: "UNKNOWN_FIELD",
      unknown_fields: unknown,
      allowed_fields: Array.from(allowed).sort(),
      message: "Request contains fields that are not accepted by this endpoint.",
    });
    return true; // signal: response already sent, caller must return
  }
  return false;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PUT, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // PUT = update single product
  if (req.method === "PUT") {
    try {
      var pool = getPool();
      var b = req.body || {};
      if (!b.sku) return res.status(400).json({ error: "sku required" });

      // P1-A: reject any field not in the canonical whitelist
      if (rejectUnknownFields(PRODUCTS_PUT_ALLOWED, b, res)) return;

      var sets = [], vals = [], n = 0;
      // Iterate the whitelist (excludes 'sku' — used as WHERE key, not SET target)
      var fields = Array.from(PRODUCTS_PUT_ALLOWED).filter(f => f !== "sku");
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
  // Syncs both raw JSONB (legacy read path) and canonical main columns (downstream read path)
  if (req.method === "PATCH") {
    try {
      if (!req.user || !["admin", "logistics"].includes(req.user.role)) {
        return res.status(403).json({ error: "Forbidden: admin or logistics only" });
      }
      const pool = getPool();
      const id = req.params?.id || req.query?.id || req.body?.id;
      if (!id) return res.status(400).json({ error: "id required" });

      // P1-A: reject any field not in the PATCH canonical set
      if (rejectUnknownFields(PRODUCTS_PATCH_ALLOWED, req.body, res)) return;

      const { hsCode, declarationName, declarationElements, declarationPrice, blDescription } = req.body;

      // Build raw JSONB patch object (legacy read compatibility)
      const rawPatch = {};
      if (hsCode              != null) rawPatch.hsCode              = hsCode;
      if (declarationName     != null) rawPatch.declarationName     = declarationName;
      if (declarationElements != null) rawPatch.declarationElements = declarationElements;
      if (declarationPrice    != null) rawPatch.declarationPrice    = declarationPrice;
      if (blDescription       != null) rawPatch.blDescription       = blDescription;
      if (Object.keys(rawPatch).length === 0) return res.status(400).json({ error: "no fields to patch" });

      // Build main column updates (canonical DB columns — downstream reads these)
      const colSets = [];
      const colVals = [];
      let idx = 1;
      if (hsCode              != null) { colSets.push(`hs_code = $${idx++}`);              colVals.push(hsCode); }
      if (declarationName     != null) { colSets.push(`declaration_name = $${idx++}`);     colVals.push(declarationName); }
      if (declarationElements != null) { colSets.push(`declaration_elements = $${idx++}`); colVals.push(declarationElements); }
      if (declarationPrice    != null) { colSets.push(`declaration_amount = $${idx++}`);   colVals.push(declarationPrice); }
      if (blDescription       != null) { colSets.push(`bl_description = $${idx++}`);       colVals.push(blDescription); }

      // Always update raw and updated_at in the same statement
      colSets.push(`raw = COALESCE(raw,'{}') || $${idx++}::jsonb`);
      colVals.push(JSON.stringify(rawPatch));
      colSets.push(`updated_at = NOW()`);
      colVals.push(id);

      const r = await pool.query(
        `UPDATE products SET ${colSets.join(", ")} WHERE id = $${idx} RETURNING id`,
        colVals
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
    var { brand, category, cat1, cat2, cat3, search, q, limit = 1000, offset = 0 } = req.query;
    // ?q= is an alias for ?search= (used by product picker in OrdersModule)
    if (q && !search) search = q;

    var query = "SELECT * FROM products", params = [], conds = [];

    // ── Brand scoping (fail-closed) ──
    // Internal roles see everything; everyone else is scoped to the brands
    // assigned to their customer record(s). This enforces price isolation
    // server-side so prices can't leak even if the frontend is bypassed.
    var INTERNAL_ROLES = ["admin", "logistics", "sales", "finance", "operator", "ceo", "superadmin"];
    if (req.user && !INTERNAL_ROLES.includes(req.user.role)) {
      var codes = Array.isArray(req.user.companyCodes) && req.user.companyCodes.length
        ? req.user.companyCodes
        : (req.user.companyCode ? [req.user.companyCode] : []);
      if (codes.length === 0) {
        return res.status(200).json({ data: [], count: 0, total: 0, scopedBrands: [], scoped: true });
      }
      var custR = await pool.query(
        "SELECT brands FROM customers WHERE company_code = ANY($1::text[]) AND is_active = true",
        [codes]
      );
      var brandSet = new Set();
      for (var row of custR.rows) {
        var bs = row.brands;
        if (typeof bs === "string") { try { bs = JSON.parse(bs); } catch (_) { bs = []; } }
        if (Array.isArray(bs)) for (var br of bs) if (br) brandSet.add(String(br).trim());
      }
      if (brandSet.size === 0) {
        // No brand assigned → return nothing (fail-closed).
        return res.status(200).json({ data: [], count: 0, total: 0, scopedBrands: [], scoped: true });
      }
      params.push(Array.from(brandSet));
      conds.push("brand = ANY($" + params.length + "::text[])");
    }

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

    // ── P0: strip internal fields for non-internal roles (v3.2 §8) ──────────
    // "价格/利润字段永隐外部" — factory_price, profit, sale_price_cny etc.
    // must never reach portal / external user responses.
    const PRICE_INTERNAL_FIELDS = [
      "factory_price", "profit", "sale_price_cny",
      "vat_rate", "rebate_rate", "sanlyn_price",
      "bg_bx", "factory_name", "factory_city",
      "issuing_company", "jdy_id", "declaration_amount",
    ];
    if (req.user && !INTERNAL_ROLES.includes(req.user.role)) {
      for (const row of result.rows) {
        for (const f of PRICE_INTERNAL_FIELDS) delete row[f];
        // Also strip from raw JSONB if present
        if (row.raw && typeof row.raw === "object") {
          for (const f of PRICE_INTERNAL_FIELDS) delete row.raw[f];
        }
      }
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
