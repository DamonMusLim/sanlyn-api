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
//
// MIN_FIX_BATCH_20260526 A-1 (2026-05-25):
// Role is now derived from JWT (req.user.role), NOT ?role= query param.
// Previously ?role=admin worked for any logged-in user → full catalog leak
// (factory_price, profit, vat_rate, rebate_rate, factory_name/code/city,
//  issuing_company). Fixed: query ?role= is IGNORED; JWT role wins.
// Same hardening for company_code (buyer) and factory_code (factory):
// derived from JWT, query values ignored.

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { getBrandScope } from "./brand-scoping.js";

// Field whitelists per role
var FIELDS_BY_ROLE = {
  admin:   "*",
  factory: ["id","sku","barcode","product_name","product_name_cn","brand","size","unit","cbm","net_weight","gross_weight","hs_code","factory_code","category","stock","inner_qty","inner_unit","factory_price","moq","declaration_name","declaration_elements","bl_description"],
  // A-1 (2026-05-25): factory_code removed from buyer/trader — per
  // feedback_customer_code_anti_counterfeit.md and Damon's MIN_FIX_BATCH_20260526
  // directive ("factory_name/code/city" 不得 customer-facing).
  buyer:   ["id","sku","barcode","product_name","product_name_cn","brand","size","unit","cbm","net_weight","gross_weight","hs_code","category","stock","inner_qty","inner_unit","sanlyn_price","price_usd","moq","image_url"],
  trader:  ["id","sku","barcode","product_name","product_name_cn","brand","size","unit","cbm","net_weight","gross_weight","hs_code","category","stock","inner_qty","inner_unit","price_usd","moq","image_url"],
};

function pickFields(row, role) {
  var fields = FIELDS_BY_ROLE[role];
  if (fields === "*") return row;
  var out = {};
  fields.forEach(function(f) { if (row[f] !== undefined) out[f] = row[f]; });
  return out;
}

// Map JWT role → products-v3 audience tier.
// Anything not explicitly admin/internal/factory defaults to 'buyer' (least-privileged).
function jwtRoleToAudience(jwtRole) {
  var r = String(jwtRole || "").toLowerCase();
  if (r === "admin" || r === "super_admin" || r === "root" ||
      r === "finance" || r === "logistics" || r === "trader" || r === "sales" ||
      r === "internal") return "admin";
  if (r === "factory" || r === "factory_user" || r === "supplier") return "factory";
  // customer, customer_user, forwarder, driver, unknown → buyer
  return "buyer";
}

function firstCompanyCodeFromJwt(user) {
  if (!user) return "";
  if (Array.isArray(user.companyCodes) && user.companyCodes.length) return String(user.companyCodes[0]).trim().toUpperCase();
  if (user.companyCode) return String(user.companyCode).trim().toUpperCase();
  return "";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  var pool = getPool();
  // A-1 fix: role from JWT, NOT query. Query ?role= is silently ignored.
  var role = jwtRoleToAudience(req.user && req.user.role);

  // factory role: factory_code MUST come from JWT companyCode (the factory's own code).
  // buyer role: company_code (for brand scope + price overrides) MUST come from JWT.
  // Query values for factory_code / company_code are IGNORED when they would be
  // privilege-relevant (i.e. for factory / buyer). Admin may still supply them
  // as filters since they already have full visibility.
  var jwtCode = firstCompanyCodeFromJwt(req.user);
  var factoryCode = "";
  var companyCode = "";
  if (role === "admin") {
    factoryCode = req.query.factory_code || "";
    companyCode = req.query.company_code || "";
  } else if (role === "factory") {
    factoryCode = jwtCode;
    if (!factoryCode) return res.status(403).json({ error: "factory scope missing in JWT" });
  } else { // buyer
    companyCode = jwtCode; // may be empty; price_overrides simply won't apply
  }

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

    // Factory role: pinned to JWT factory_code above
    if (role === "factory") {
      args.push(factoryCode); where.push("factory_code = $" + args.length);
    } else if (factoryCode) {
      // admin-supplied filter
      args.push(factoryCode); where.push("factory_code = $" + args.length);
    }

    if (role === "buyer") {
      if (!companyCode) return res.status(200).json({ success: true, role, total: 0, count: 0, rows: [] });
      var scope = await getBrandScope(pool, [companyCode]);
      if (scope.exclusiveByOthers.length > 0) {
        args.push(scope.exclusiveByOthers);
        where.push("brand <> ALL($" + args.length + "::text[])");
      }
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
