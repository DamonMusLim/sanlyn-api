// /api/db/admin.js — Admin backend API for all tables
// Provides: list tables, query records, update records, stats
import { getPool, setCors } from "../db.js";

var ALLOWED_TABLES = {
  orders: { label: "订单管理", key: "_id", columns: ["_id","order_no","contract_no","customer_po","customer","company_code","company_name_cn","company_name_en","consignee","customer_address","country","destination_port","pol","delivery_date","confirmed_delivery","required_arrival","total_qty","total_cbm","gross_weight","net_weight","container_type","container_qty","total_amount","total_amount_factory","currency","exchange_rate","profit","declare_amount","tax_rebate_amount","trade_terms","status","production_status","factory","remarks","created_at","updated_at"] },
  shipping_plans: { label: "海运计划", key: "_id", columns: ["_id","shipment_no","so_no","bl_no","vessel","voyage","shipping_line","transit","schedule","call_port","pol","pod","container_type","container_qty","container_no","cutoff_date","si_cutoff_date","port_open_date","shipment_date","etd","atd","eta","ata","customer","customer_en","customer_cn","order_nos","contract_nos","forwarder_cn","forwarder_en","trucking_cn","customs_cn","insurance_cn","freight_cost","freight_sale_usd","doc_fee","tlx_fee","info_trans_fee","bkg_fee","thc_fee","eir_fee","seal_fee","freight_total_usd","freight_total_cny","trucking_cost_total","customs_cost_total","insurance_cost","is_ddp","ddp_total","ddp_agent","flow_status","status","current_status","current_status_cn","remarks","raw","created_at","updated_at"] },
  finance_payments: { label: "财务收款", key: "_id", columns: ["_id","jdy_id","type","direction","contract_no","order_no","customer_en","customer_cn","issuing_co","total_customer","total_factory","paid_amount","pending_amount","this_amount","currency","bank_ref","payment_date","pay_type","pay_item","forwarder_cn","freight_recv","freight_pay","port_recv","port_pay","truck_recv","truck_pay","customs_recv","customs_pay","audit_issues","audit_status","status","raw","created_at","updated_at"] },
  customs_data: { label: "报关资料", key: "_id", columns: ["_id","customs_no","shipment_no","contract_no","created_at","updated_at"] },
  products: { label: "产品库", key: "sku", columns: ["id","sku","barcode","product_name","product_name_cn","brand","size","cbm","net_weight","gross_weight","factory_name","hs_code","declaration_name","declaration_elements","bl_description","vat_rate","rebate_rate","factory_price","price_usd","declaration_amount","profit","bg_bx","cat1","cat2","cat3","flavor","issuing_company","pallet_size","jdy_id","active","created_at","updated_at"] },
  accounts: { label: "账号管理", key: "username", columns: ["id","username","role","company","company_code","company_codes","supplier_role","department","created_at","updated_at"] },
  tenants: { label: "租户管理", key: "id", columns: ["id","company_code","name","config","created_at","updated_at"] },
  customers: { label: "客户管理", key: "_id", columns: ["_id","company_code","name_cn","name_en","country","currency","grade","destination_port","address","consignee","contact_tel","contact_phone","contact_email","brands","trade_terms","payment_policy","payment_terms","bl_type","our_shipping","role_type","role_types","group_id","company_codes","is_active","raw","created_at","updated_at"] },
  local_charges: { label: "海运报价", key: "id", columns: ["id","carrier","pol","pod","container_type","company","cost_total","sell_total","fee_items","created_at"] },
  customs_rates: { label: "报关费率", key: "_id", columns: ["_id","vendor_cn","pol","base_fee","currency","max_free_descs","extra_per_desc","notes","created_at"] },
  trucking_rates: { label: "车队费率", key: "_id", columns: ["_id","vendor_cn","factory_name","pol","valid_from","valid_to","rates","surge","currency","created_at"] },
  factories: { label: "工厂管理", key: "id", columns: ["id","name","name_short","po_prefix","ports","notes","is_active","created_at"] },
  field_schemas: { label: "字段设计", key: "id", columns: ["id","field_id","table_name","column_name","label","label_en","field_type","storage","section","section_icon","section_order","sort_order","is_visible","is_editable","is_required","is_list_col","show_empty","width","options","default_value","placeholder","description","linked_table","linked_field","linked_bring","created_at","updated_at"] },
};

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }
  var pool = getPool();

  try {
    var action = req.query.action || req.body?.action || "list";

    // ── GET /api/db/admin?action=distinct&table=products&col=brand
    if (action === "distinct") {
      var table = req.query.table;
      var col = req.query.col;
      if (!table || !ALLOWED_TABLES[table] || !ALLOWED_TABLES[table].columns.includes(col)) {
        return res.status(400).json({ error: "Invalid table or column" });
      }
      var r = await pool.query(
        "SELECT DISTINCT " + col + " FROM " + table + " WHERE " + col + " IS NOT NULL AND " + col + " != '' ORDER BY " + col
      );
      return res.status(200).json({ success: true, values: r.rows.map(function(row){ return row[col]; }) });
    }

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
      var defaultSort = ALLOWED_TABLES[table].columns.includes("created_at") ? "created_at" : (ALLOWED_TABLES[table].columns.includes("id") ? "id" : ALLOWED_TABLES[table].key);
      var sortBy = req.query.sort || defaultSort;
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
        if (ALLOWED_TABLES[table].columns.includes(col) && col !== keyCol && !col.includes("created_at") && !col.includes("updated_at")) {
          var v = fields[col];
          if (col === "raw" || col === "audit_issues") {
            // Merge into existing JSONB rather than replace
            var jsonStr = typeof v !== "string" ? JSON.stringify(v) : v;
            params.push(jsonStr);
            sets.push(col + " = COALESCE(" + col + ",'{}') || $" + params.length + "::jsonb");
          } else if (col === "role_types" || col === "company_codes") {
            // text[] columns — accept array or JSON string
            var arr = Array.isArray(v) ? v : (typeof v === "string" ? (function(){try{return JSON.parse(v);}catch(e){return v.split(",").map(function(x){return x.trim();}).filter(Boolean);}})() : []);
            params.push(arr);
            sets.push(col + " = $" + params.length + "::text[]");
          } else if (col === "brands" || col === "addresses" || col === "invoice" || col === "payment_terms" || col === "fee_items" || col === "config" || col === "ports" || col === "rates" || col === "surge" || col === "fees" || col === "free_time") {
            // JSONB columns — accept string or object/array
            var jsonVal = typeof v === "string" ? v : JSON.stringify(v);
            params.push(jsonVal);
            sets.push(col + " = $" + params.length + "::jsonb");
          } else {
            params.push(v);
            sets.push(col + " = $" + params.length);
          }
        }
      }
      if (!sets.length) return res.status(400).json({ error: "No valid fields to update" });
      if(ALLOWED_TABLES[table].columns.includes("updated_at")){
        params.push(new Date().toISOString());
        sets.push("updated_at = $" + params.length);
      }
      params.push(id);
      var sql = "UPDATE " + table + " SET " + sets.join(", ") + " WHERE " + keyCol + " = $" + params.length + " RETURNING *";
      var result = await pool.query(sql, params);
      return res.status(200).json({ success: true, data: result.rows[0] });
    }

    // ── POST /api/db/admin { action:"insert", table:"finance_payments", fields:{...} }
    if (action === "insert" && req.method === "POST") {
      var table = req.body.table;
      var fields = req.body.fields || {};
      if (!table || !ALLOWED_TABLES[table]) return res.status(400).json({ error: "Invalid table" });
      var keyCol = ALLOWED_TABLES[table].key;
      var colNames = [], params = [], valCasts = [];
      for (var col in fields) {
        if (ALLOWED_TABLES[table].columns.includes(col) && !col.includes("created_at")) {
          var v = fields[col];
          var JSONB_COLS = ["raw","audit_issues","rates","surge","fees","free_time","fee_items","config","ports","payment_terms","addresses","invoice","brands"];
          var TEXT_ARR_COLS = ["role_types","company_codes"];
          var isJsonb = JSONB_COLS.includes(col);
          var isTextArr = TEXT_ARR_COLS.includes(col);
          colNames.push(col);
          if (isTextArr) {
            var arr = Array.isArray(v) ? v : (typeof v === "string" ? v.split(",").map(function(x){return x.trim();}).filter(Boolean) : []);
            params.push(arr);
            valCasts.push("::text[]");
          } else if (isJsonb) {
            params.push(typeof v !== "string" ? JSON.stringify(v) : v);
            valCasts.push("::jsonb");
          } else {
            params.push(v);
            valCasts.push("");
          }
        }
      }
      if (!colNames.length) return res.status(400).json({ error: "No valid fields" });
      var placeholders = params.map(function(_, i) { return "$" + (i + 1) + valCasts[i]; });
      var hasUpdAt = ALLOWED_TABLES[table].columns.includes("updated_at");
      var sql = "INSERT INTO " + table + " (" + colNames.join(",") + ",created_at" + (hasUpdAt?",updated_at":"") + ") VALUES(" + placeholders.join(",") + ",NOW()" + (hasUpdAt?",NOW()":"") + ") ON CONFLICT(" + keyCol + ") DO NOTHING RETURNING *";
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

    // ── POST /api/db/admin { action:"sql", query:"..." } (admin raw SQL — all types)
    if (action === "sql" && req.method === "POST") {
      var query = (req.body.query || "").trim();
      if (!query) return res.status(400).json({ error: "Query required" });
      var upper = query.toUpperCase().replace(/\s+/g, " ");
      var blocked = ["DROP TABLE","DROP DATABASE","TRUNCATE ","DROP INDEX","DROP SCHEMA","DROP SEQUENCE"];
      for (var b of blocked) { if (upper.includes(b)) return res.status(400).json({ error: "Blocked: " + b.trim() }); }
      var params = req.body.params || [];
      var result = await pool.query(query, params);
      var isSelect = upper.trimStart().startsWith("SELECT") || upper.trimStart().startsWith("WITH");
      return res.status(200).json({
        success: true,
        data: isSelect ? result.rows : [],
        count: isSelect ? result.rows.length : undefined,
        rowCount: isSelect ? undefined : result.rowCount,
      });
    }

    return res.status(400).json({ error: "Unknown action: " + action });
  } catch (err) {
    console.error("[admin]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
