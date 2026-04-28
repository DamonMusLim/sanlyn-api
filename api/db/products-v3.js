// products-v3.js
// Products list with role-based field filtering + filters.
//
// GET /api/db/products-v3
//   ?role=admin|factory|buyer|trader   (default: admin in dev; from JWT in prod)
//   ?factory_code=ZC                    (factory role: forced to own; admin/buyer can pick)
//   ?company_code=PETSOME               (buyer role: applies price_overrides)
//   ?category=dry|wet|treat|acc
//   ?brand=DIBAQ
//   ?search=salmon
//   ?stock=in|low|out
//   ?limit=200 (default), &offset=0
//
// Returns rows shaped per role (factory_price hidden from buyer, etc.)

import { getPool, setCors } from "../db.js";

// Field whitelists per role
var FIELDS_BY_ROLE = {
  admin:   "*",
  factory: ["id","sku","barcode","product_name","product_name_cn","brand","size","unit","cbm","net_weight","gross_weight","hs_code","factory_code","category","stock","inner_qty","inner_unit","factory_price","moq","declaration_name","declaration_elements","bl_description"],
  buyer:   ["id","sku","barcode","product_name","product_name_cn","brand","size","unit","cbm","net_weight","gross_weight","hs_code","factory_code","category","stock","inner_qty","inner_unit","sanlyn_price","price_usd","moq","image_url"],
  trader:  ["id","sku","barcode","product_name","product_name_cn","brand","size","unit","cbm","net_weight","gross_weight","hs_code","factory_code","category","stock","inner_qty","inner_unit","price_usd","moq","image_url"],
};

function pickFields(row, role) {
  var fields = FIELDS_BY_ROLE[role];
  if (fields === "*") return row;
  var out = {};
  fields.forEach(function(f) { if (row[f] !== undefined) out[f] = row[f]; });
  return out;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  var pool = getPool();
  var role         = req.query.role || "admin";
  var factoryCode  = req.query.factory_code || "";
  var companyCode  = req.query.company_code || "";
  var category     = req.query.category || "";
  var brand        = req.query.brand || "";
  var search       = req.query.search || "";
  var stock        = req.query.stock || "";
  var limit  = Math.min(parseInt(req.query.limit) || 200, 500);
  var offset = parseInt(req.query.offset) || 0;

  if (!FIELDS_BY_ROLE[role]) return res.status(400).json({ error: "unknown role: " + role });

  try {
    // ── Build query ──
    var where = ["active = true"];
    var args = [];

    // Factory role: forced to own factory_code (read from JWT in prod)
    if (role === "factory") {
      if (!factoryCode) return res.status(400).json({ error: "factory role requires factory_code" });
      args.push(factoryCode); where.push("factory_code = $" + args.length);
    } else if (factoryCode) {
      args.push(factoryCode); where.push("factory_code = $" + args.length);
    }

    if (category) { args.push(category); where.push("category = $" + args.length); }
    if (brand)    { args.push(brand);    where.push("brand    = $" + args.length); }
    if (search)   {
      args.push("%" + search + "%");
      where.push("(sku ILIKE $" + args.length + " OR product_name ILIKE $" + args.length + " OR barcode ILIKE $" + args.length + " OR hs_code ILIKE $" + args.length + ")");
    }
    if (stock === "in")  where.push("stock > 0");
    if (stock === "low") where.push("stock > 0 AND stock < 500");
    if (stock === "out") where.push("stock = 0");

    var whereSQL = where.join(" AND ");

    // Total count
    var countQ = await pool.query("SELECT COUNT(*)::int AS c FROM products WHERE " + whereSQL, args);
    var total = countQ.rows[0].c;

    // Rows
    args.push(limit); var limitIdx = args.length;
    args.push(offset); var offsetIdx = args.length;
    var rowsQ = await pool.query(
      "SELECT * FROM products WHERE " + whereSQL + " ORDER BY sku LIMIT $" + limitIdx + " OFFSET $" + offsetIdx,
      args
    );

    // Apply role field filter
    var rows = rowsQ.rows.map(function(r) { return pickFields(r, role); });

    // For buyer: apply customer.price_overrides if companyCode present
    if (role === "buyer" && companyCode) {
      var custQ = await pool.query("SELECT price_overrides FROM customers WHERE company_code = $1", [companyCode]);
      var overrides = custQ.rows[0]?.price_overrides || {};
      rows = rows.map(function(r) {
        if (overrides[r.sku] !== undefined) {
          r.customer_price = overrides[r.sku];
          r.list_price     = r.sanlyn_price;          // keep visible "list" so buyer can see they have a discount
        }
        return r;
      });
    }

    return res.status(200).json({ success: true, role, total, count: rows.length, rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
