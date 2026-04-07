// /api/db/admin.js — Admin backend API for all tables
// Provides: list tables, query records, update records, stats
import { getPool, setCors } from "../db.js";

var ALLOWED_TABLES = {
  orders: { label: "订单管理", key: "_id", columns: ["_id","order_no","contract_no","customer_po","customer","company_code","destination","etd","eta","status","production_status","total_amount","currency","source","created_by","jdy_synced","created_at","updated_at"] },
  shipping_plans: { label: "海运计划", key: "_id", columns: ["_id","shipment_no","bl_no","vessel","voyage","etd","eta","cutoff_date","container_no","container_type","customer","forwarder_cn","trucking_cn","customs_cn","pol","pod","freight_cost","freight_sale_usd","flow_status","created_at","updated_at"] },
  finance_payments: { label: "财务收款", key: "_id", columns: ["_id","plan_id","customer","amount","currency","paid_date","status","created_at","updated_at"] },
  customs_data: { label: "报关资料", key: "_id", columns: ["_id","customs_no","shipment_no","contract_no","created_at","updated_at"] },
  products: { label: "产品库", key: "_id", columns: ["_id","sku","product_name","product_name_cn","brand","category","spec","factory_price","sanlyn_price","cbm","weight","image_url","created_at","updated_at"] },
  accounts: { label: "账号管理", key: "username", columns: ["id","username","role","company","supplier_role","department","created_at","updated_at"] },
  tenants: { label: "租户管理", key: "id", columns: ["id","company_code","name","config","created_at","updated_at"] },
  customers: { label: "客户管理", key: "_id", columns: ["_id","company_code","company_name_cn","company_name_en","created_at","updated_at"] },
  local_charges: { label: "港口费用", key: "id", columns: ["id","carrier","pol","pod","container_type","company","cost_total","sell_total","fee_items","created_at"] },
};

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  var pool = getPool();

  try {
    var action = req.query.action || req.body?.action || "list";

    // ── GET /api/db/admin?action=schema — return table definitions
    if (action === "schema") {
      var tables = {};
      for (var t in ALLOWED_TABLES) {
        tables[t] = { label: ALLOWED_TABLES[t].label, key: ALLOWED_TABLES[t].key, columns: ALLOWED_TABLES[t].columns };
      }
      return res.status(200).json({ success: true, tables: tables });
    }

    // ── GET /api/db/admin?action=stats — dashboard overview
    if (action === "stats") {
      var stats = {};
      var queries = [
        { key: "orders", sql: "SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='pending') as pending, COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days') as recent FROM orders" },
        { key: "shipping", sql: "SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE flow_status IN ('已订舱','已装柜','已开船')) as active FROM shipping_plans" },
        { key: "payments", sql: "SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as total_amount FROM finance_payments" },
        { key: "products", sql: "SELECT COUNT(*) as total FROM products" },
        { key: "accounts", sql: "SELECT COUNT(*) as total FROM accounts" },
        { key: "customers", sql: "SELECT COUNT(*) as total FROM customers" },
      ];
      for (var q of queries) {
        try { var r = await pool.query(q.sql); stats[q.key] = r.rows[0]; }
        catch (e) { stats[q.key] = { error: e.message }; }
      }
      return res.status(200).json({ success: true, stats: stats });
    }

    // ── GET /api/db/admin?action=list&table=orders&limit=50&offset=0&search=xxx
    if (action === "list") {
      var table = req.query.table || req.body?.table;
      if (!table || !ALLOWED_TABLES[table]) return res.status(400).json({ error: "Invalid table: " + table });
      var limit = parseInt(req.query.limit || 50);
      var offset = parseInt(req.query.offset || 0);
      var search = req.query.search || "";
      var sortBy = req.query.sort || "created_at";
      var sortDir = (req.query.dir || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
      var filters = {};
      try { filters = req.query.filters ? JSON.parse(req.query.filters) : {}; } catch(e) {}

      var params = [];
      var conds = [];

      // Apply column filters
      for (var col in filters) {
        if (filters[col] && ALLOWED_TABLES[table].columns.includes(col)) {
          params.push("%" + filters[col] + "%");
          conds.push(col + "::text ILIKE $" + params.length);
        }
      }

      // Global search across text columns
      if (search) {
        var searchConds = [];
        var textCols = ALLOWED_TABLES[table].columns.filter(function(c) { return !c.includes("_at") && c !== "config" && c !== "raw"; });
        params.push("%" + search + "%");
        var searchIdx = params.length;
        for (var sc of textCols) {
          searchConds.push(sc + "::text ILIKE $" + searchIdx);
        }
        if (searchConds.length) conds.push("(" + searchConds.join(" OR ") + ")");
      }

      var sql = "SELECT * FROM " + table;
      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      // Validate sort column
      if (!ALLOWED_TABLES[table].columns.includes(sortBy)) sortBy = "created_at";
      sql += " ORDER BY " + sortBy + " " + sortDir;
      params.push(limit);
      sql += " LIMIT $" + params.length;
      params.push(offset);
      sql += " OFFSET $" + params.length;

      var result = await pool.query(sql, params);

      // Get total count
      var countSql = "SELECT COUNT(*) as total FROM " + table;
      if (conds.length) countSql += " WHERE " + conds.join(" AND ");
      var countParams = params.slice(0, params.length - 2); // remove limit/offset
      var countResult = await pool.query(countSql, countParams);

      return res.status(200).json({
        success: true,
        data: result.rows,
        total: parseInt(countResult.rows[0].total),
        limit: limit,
        offset: offset,
        table: table,
        tableLabel: ALLOWED_TABLES[table].label
      });
    }

    // ── GET /api/db/admin?action=detail&table=orders&id=xxx
    if (action === "detail") {
      var table = req.query.table;
      var id = req.query.id;
      if (!table || !ALLOWED_TABLES[table]) return res.status(400).json({ error: "Invalid table" });
      if (!id) return res.status(400).json({ error: "id required" });
      var keyCol = ALLOWED_TABLES[table].key;
      var result = await pool.query("SELECT * FROM " + table + " WHERE " + keyCol + " = $1", [id]);
      if (!result.rows.length) return res.status(404).json({ error: "Not found" });
      return res.status(200).json({ success: true, data: result.rows[0] });
    }

    // ── POST /api/db/admin { action:"update", table:"orders", id:"xxx", fields:{status:"confirmed"} }
    if (action === "update" && req.method === "POST") {
      var table = req.body.table;
      var id = req.body.id;
      var fields = req.body.fields || {};
      if (!table || !ALLOWED_TABLES[table]) return res.status(400).json({ error: "Invalid table" });
      if (!id) return res.status(400).json({ error: "id required" });

      var keyCol = ALLOWED_TABLES[table].key;
      var sets = [];
      var params = [];
      for (var col in fields) {
        if (ALLOWED_TABLES[table].columns.includes(col) && col !== keyCol && !col.includes("created_at")) {
          params.push(fields[col]);
          sets.push(col + " = $" + params.length);
        }
      }
      if (!sets.length) return res.status(400).json({ error: "No valid fields to update" });
      params.push(new Date().toISOString());
      sets.push("updated_at = $" + params.length);
      params.push(id);
      var sql = "UPDATE " + table + " SET " + sets.join(", ") + " WHERE " + keyCol + " = $" + params.length + " RETURNING *";
      var result = await pool.query(sql, params);
      return res.status(200).json({ success: true, data: result.rows[0] });
    }

    // ── POST /api/db/admin { action:"delete", table:"orders", id:"xxx" }
    if (action === "delete" && req.method === "POST") {
      var table = req.body.table;
      var id = req.body.id;
      if (!table || !ALLOWED_TABLES[table]) return res.status(400).json({ error: "Invalid table" });
      if (!id) return res.status(400).json({ error: "id required" });
      var keyCol = ALLOWED_TABLES[table].key;
      var result = await pool.query("DELETE FROM " + table + " WHERE " + keyCol + " = $1 RETURNING *", [id]);
      return res.status(200).json({ success: true, deleted: result.rowCount });
    }

    // ── POST /api/db/admin { action:"sql", query:"SELECT ..." } (admin raw SQL, read-only)
    if (action === "sql" && req.method === "POST") {
      var query = (req.body.query || "").trim();
      if (!query.toUpperCase().startsWith("SELECT")) return res.status(400).json({ error: "Only SELECT queries allowed" });
      var result = await pool.query(query);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    }

    return res.status(400).json({ error: "Unknown action: " + action });
  } catch (err) {
    console.error("[admin]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
