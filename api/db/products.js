import { getPool, setCors } from "../db.js";
import { getBrandScope } from "./brand-scoping.js";

const PRODUCT_WRITABLE = ["sku","barcode","product_name","product_name_cn","brand","size","cbm",
  "net_weight","gross_weight","hs_code","declaration_name","declaration_elements",
  "bl_description","vat_rate","rebate_rate","factory_price","price_usd","declaration_amount","profit",
  "bg_bx","cat1","cat2","cat3","flavor","pallet_size","active",
  "origin_country","spec","unit","raw","factory_code","category","stock","sale_price_cny","image_url",
  "images","colors","material","product_dims","carton_qty","display_brand","weight_unit","is_canonical",
  "declaration_name_en","quarantine_required","quarantine_note"];

let productReadPartsCache = null;

function nullIfEmpty(expr) {
  return `NULLIF(${expr}, '')`;
}

async function getProductReadParts(pool) {
  if (productReadPartsCache) return productReadPartsCache;

  const meta = await pool.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('companies', 'factories')`
  );
  const cols = { companies: new Set(), factories: new Set() };
  for (const row of meta.rows) {
    if (cols[row.table_name]) cols[row.table_name].add(row.column_name);
  }

  const joins = [];
  const nameParts = [];
  const cityParts = [];

  if (cols.companies.has("code")) {
    joins.push("LEFT JOIN companies c ON c.code = p.factory_code");
    if (cols.companies.has("name_cn")) nameParts.push(nullIfEmpty("c.name_cn"));
    if (cols.companies.has("name_en")) nameParts.push(nullIfEmpty("c.name_en"));
    if (cols.companies.has("city")) cityParts.push(nullIfEmpty("c.city"));
    if (cols.companies.has("province")) cityParts.push(nullIfEmpty("c.province"));
  }

  const factoryJoinKeys = [];
  if (cols.factories.has("company_code")) factoryJoinKeys.push("f.company_code = p.factory_code");
  if (cols.factories.has("po_prefix")) factoryJoinKeys.push("f.po_prefix = p.factory_code");
  if (factoryJoinKeys.length) {
    const factoryOrder = cols.factories.has("id") ? " ORDER BY f0.id" : "";
    joins.push(
      "LEFT JOIN LATERAL (SELECT * FROM factories f0 WHERE " +
      factoryJoinKeys.map(k => k.replaceAll("f.", "f0.")).join(" OR ") +
      factoryOrder + " LIMIT 1) f ON true"
    );
    if (cols.factories.has("name")) nameParts.push(nullIfEmpty("f.name"));
    if (cols.factories.has("name_short")) nameParts.push(nullIfEmpty("f.name_short"));
    if (cols.factories.has("city")) cityParts.push(nullIfEmpty("f.city"));
    if (cols.factories.has("province")) cityParts.push(nullIfEmpty("f.province"));
  }

  const factoryName = nameParts.length ? `COALESCE(${nameParts.join(", ")})` : "NULL";
  const factoryCity = cityParts.length ? `COALESCE(${cityParts.join(", ")})` : "NULL";
  productReadPartsCache = {
    from: "FROM products p " + joins.join(" "),
    select: `p.*, ${factoryName} AS factory_name, ${factoryCity} AS factory_city`,
  };
  return productReadPartsCache;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PUT, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // POST = create new product（修复 +New 写不进 / 405）
  if (req.method === "POST") {
    try {
      const pool = getPool();
      const body = req.body || {};
      if (!body.sku || !body.product_name) return res.status(400).json({ success:false, error:"sku 和 product_name 必填" });
      const PRODUCT_JSONB = new Set(["raw","images"]);
      const cols = [], vals = [], params = [];
      for (const k of PRODUCT_WRITABLE) if (Object.prototype.hasOwnProperty.call(body, k)) {
        const v = body[k]; cols.push(k);
        if (PRODUCT_JSONB.has(k)) { params.push(v == null ? null : JSON.stringify(v)); vals.push(`$${params.length}::jsonb`); }
        else { params.push(v); vals.push(`$${params.length}`); }
      }
      // NOT NULL 兜底（缺失 或 显式传 null/空 都补默认）
      const wuI = cols.indexOf("weight_unit");
      if (wuI < 0 || body.weight_unit == null || body.weight_unit === "") {
        if (wuI < 0) { cols.push("weight_unit"); params.push("per_ctn"); vals.push(`$${params.length}`); }
        else { params[wuI] = "per_ctn"; }
      }
      const icI = cols.indexOf("is_canonical");
      if (icI < 0 || body.is_canonical == null) {
        if (icI < 0) { cols.push("is_canonical"); params.push(false); vals.push(`$${params.length}`); }
        else { params[icI] = false; }
      }
      cols.push("created_at","updated_at"); vals.push("NOW()","NOW()");
      const r = await pool.query(`INSERT INTO products (${cols.join(",")}) VALUES (${vals.join(",")}) RETURNING *`, params);
      return res.status(201).json({ success:true, data:r.rows[0] });
    } catch (err) { return res.status(500).json({ success:false, error: err.message }); }
  }

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
        "declaration_amount","inner_qty","inner_unit","flavor","moq","spec","image_url",
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
    var { brand, category, cat1, cat2, cat3, search, q, limit = 1000, offset = 0 } = req.query;
    // ?q= is an alias for ?search= (used by product picker in OrdersModule)
    if (q && !search) search = q;

    var readParts = await getProductReadParts(pool);
    var query = "SELECT " + readParts.select + " " + readParts.from, params = [], conds = [];

    // ── Brand scoping (open default + exclusive locks) ──
    // Internal roles see everything; everyone else sees open brands, excluding
    // brands held exclusively by other customers.
    var INTERNAL_ROLES = ["admin", "logistics", "sales", "finance", "operator", "ceo", "superadmin"];
    if (req.user && !INTERNAL_ROLES.includes(req.user.role)) {
      var codes = Array.isArray(req.user.companyCodes) && req.user.companyCodes.length
        ? req.user.companyCodes
        : (req.user.companyCode ? [req.user.companyCode] : []);
      if (codes.length === 0) {
        return res.status(200).json({ data: [], count: 0, total: 0, scopedBrands: [], scoped: true });
      }
      var scope = await getBrandScope(pool, codes);
      if (scope.exclusiveByOthers.length > 0) {
        params.push(scope.exclusiveByOthers);
        conds.push("p.brand <> ALL($" + params.length + "::text[])");
      }
    }

    if (brand) {
      params.push(brand);
      conds.push("p.brand = $" + params.length);
    }
    if (category || cat1) {
      params.push(cat1 || category);
      conds.push("(p.cat1 = $" + params.length + " OR p.category = $" + params.length + ")");
    }
    if (cat2) {
      params.push(cat2);
      conds.push("p.cat2 = $" + params.length);
    }
    if (cat3) {
      params.push(cat3);
      conds.push("p.cat3 = $" + params.length);
    }
    if (search) {
      params.push("%" + search + "%");
      conds.push("(p.sku ILIKE $" + params.length + " OR p.product_name ILIKE $" + params.length + " OR p.product_name_cn ILIKE $" + params.length + " OR p.brand ILIKE $" + params.length + ")");
    }

    // Default: only active
    conds.push("p.active = true");

    if (conds.length) query += " WHERE " + conds.join(" AND ");

    // Count total
    var countQ = "SELECT COUNT(*) as total " + readParts.from + (conds.length ? " WHERE " + conds.join(" AND ") : "");
    var countR = await pool.query(countQ, params);

    params.push(parseInt(limit));
    query += " ORDER BY p.id DESC LIMIT $" + params.length;
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
