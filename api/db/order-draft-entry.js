import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { allocateOrderIdentifiers, orderIdentifierStats } from "./order-id-policy.js";

const INTERNAL_ROLES = new Set(["admin", "logistics", "sales", "operator", "superadmin", "ceo"]);
const COMPLETION_FIELDS = [
  ["factory_code", "工厂代码"],
  ["trade_terms", "销售侧成交方式"],
  ["purchase_trade_terms", "采购侧成交方式"],
  ["products", "产品明细"],
  ["destination_port", "目的港"],
  ["consignee", "收货人"],
];

function clean(v) { return String(v ?? "").trim(); }
function actor(req) {
  const u = req.user || {};
  return u.username || u.name || u.email || u.uid || u.sub || "unknown";
}
function userCodes(req) {
  const u = req.user || {};
  const arr = Array.isArray(u.companyCodes) ? u.companyCodes : (u.companyCode ? [u.companyCode] : []);
  return arr.map(clean).filter(Boolean);
}
function isInternal(req) { return req.user && INTERNAL_ROLES.has(req.user.role); }
function missingOf(body) {
  return COMPLETION_FIELDS
    .filter(([k]) => k === "products" ? !(Array.isArray(body.products) && body.products.length) : !clean(body[k]))
    .map(([field, label]) => ({ field, label }));
}
function fillRate(body) {
  const done = COMPLETION_FIELDS.length - missingOf(body).length;
  return Math.round(done / COMPLETION_FIELDS.length * 100);
}

async function existingColumns(pool) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='orders'`
  );
  return new Set(r.rows.map(x => x.column_name));
}

async function loadBuyer(pool, companyCode) {
  if (!companyCode) return null;
  const r = await pool.query(
    `SELECT company_code, name_cn, name_en, country, currency, destination_port, consignee
       FROM customers
      WHERE company_code=$1
      LIMIT 1`,
    [companyCode]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

async function fieldStats(pool) {
  const cols = await existingColumns(pool);
  const expr = (field, sql) => cols.has(field) ? sql : "0::int AS " + field;
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total,
            ${expr("factory_code", "COUNT(*) FILTER (WHERE NULLIF(BTRIM(factory_code),'') IS NOT NULL)::int AS factory_code")},
            ${expr("trade_terms", "COUNT(*) FILTER (WHERE NULLIF(BTRIM(trade_terms),'') IS NOT NULL)::int AS trade_terms")},
            ${expr("purchase_trade_terms", "COUNT(*) FILTER (WHERE NULLIF(BTRIM(purchase_trade_terms),'') IS NOT NULL)::int AS purchase_trade_terms")},
            ${expr("products", "COUNT(*) FILTER (WHERE products IS NOT NULL AND products::text NOT IN ('[]','{}','null',''))::int AS products")},
            ${expr("destination_port", "COUNT(*) FILTER (WHERE NULLIF(BTRIM(destination_port),'') IS NOT NULL)::int AS destination_port")},
            ${expr("consignee", "COUNT(*) FILTER (WHERE NULLIF(BTRIM(consignee),'') IS NOT NULL)::int AS consignee")}
       FROM orders`
  ).catch(() => ({ rows: [{ total: 0 }] }));
  const row = r.rows[0] || { total: 0 };
  const total = Number(row.total || 0);
  return COMPLETION_FIELDS.map(([field, label]) => {
    const filled = Number(row[field] || 0);
    return {
      field,
      label,
      total,
      filled,
      fill_rate: total && filled ? Math.round(filled / total * 100) : null,
      connected: cols.has(field) && total > 0 && filled > 0,
      missing: cols.has(field) ? (total ? `orders.${field} filled samples` : "orders sample rows") : `orders.${field}`,
    };
  });
}

async function entryStats(pool) {
  const cols = await existingColumns(pool);
  const fields = await fieldStats(pool);
  const identifiers = await orderIdentifierStats(pool, cols);
  return { fields, identifiers };
}

async function listBuyers(pool, req) {
  const codes = userCodes(req);
  const scoped = !isInternal(req);
  if (scoped && !codes.length) return [];
  const params = [];
  let where = "WHERE is_active IS DISTINCT FROM false";
  if (scoped) {
    params.push(codes);
    where += " AND company_code = ANY($1::text[])";
  }
  const r = await pool.query(
    `SELECT company_code, name_cn, name_en
       FROM customers
       ${where}
      ORDER BY COALESCE(name_en, name_cn, company_code)
      LIMIT 120`,
    params
  ).catch(() => ({ rows: [] }));
  return r.rows;
}

async function createDraft(req, body) {
  const pool = getPool();
  const companyCode = clean(body.companyCode || body.buyer_company_code).toUpperCase();
  if (!companyCode) {
    const err = new Error("买方公司代码必填");
    err.status = 400;
    throw err;
  }
  if (!isInternal(req)) {
    const allowed = userCodes(req).map(x => x.toUpperCase());
    if (!allowed.includes(companyCode)) {
      const err = new Error("buyer_company_code outside account scope");
      err.status = 403;
      throw err;
    }
  }

  const buyer = await loadBuyer(pool, companyCode);
  if (!buyer) {
    const err = new Error("买方公司代码未建档");
    err.status = 404;
    throw err;
  }
  const cols = await existingColumns(pool);
  const raw = {
    draft_entry: true,
    draft_created_at: new Date().toISOString(),
    draft_created_by: actor(req),
    draft_missing_fields: missingOf(body),
    draft_fill_rate: fillRate(body),
    buyer_input: companyCode,
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('orders_draft_entry'))");
    const ids = await allocateOrderIdentifiers(client);
    const nr = await client.query("SELECT COALESCE(MAX(id),0)+1 AS id FROM orders");
    const id = Number(nr.rows[0].id);
    const data = {
      id,
      _id: "order_" + ids.internal_snowflake_id,
      order_no: ids.public_order_no,
      public_order_no: ids.public_order_no,
      internal_snowflake_id: ids.internal_snowflake_id,
      contract_no: null,
      company_code: companyCode,
      company_name_cn: buyer?.name_cn || "",
      company_name_en: buyer?.name_en || "",
      customer: buyer?.name_en || buyer?.name_cn || companyCode,
      country: buyer?.country || "",
      currency: buyer?.currency || null,
      destination_port: clean(body.destination_port) || buyer?.destination_port || "",
      consignee: clean(body.consignee) || buyer?.consignee || "",
      customer_po: clean(body.customer_po) || null,
      factory_code: clean(body.factory_code).toUpperCase() || null,
      factory: clean(body.factory) || "",
      trade_terms: clean(body.trade_terms).toUpperCase() || null,
      purchase_trade_terms: clean(body.purchase_trade_terms).toUpperCase() || null,
      status: "draft",
      production_status: null,
      products: JSON.stringify(Array.isArray(body.products) ? body.products : []),
      remarks: clean(body.remarks) || "",
      source: "draft_entry",
      created_by: actor(req),
      raw: JSON.stringify(raw),
    };
    const names = Object.keys(data).filter(k => cols.has(k));
    const placeholders = names.map((k, i) => {
      const p = "$" + (i + 1);
      return k === "raw" || k === "products" ? p + "::jsonb" : p;
    });
    const values = names.map(k => data[k]);
    const r = await client.query(
      `INSERT INTO orders (${names.join(",")}) VALUES (${placeholders.join(",")})
       RETURNING id, order_no, contract_no, status, raw`,
      values
    );
    await client.query("COMMIT");
    return { ...r.rows[0], public_order_no: ids.public_order_no, internal_snowflake_id: ids.internal_snowflake_id };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function patchDraft(req, body) {
  if (!isInternal(req)) {
    const err = new Error("Forbidden: internal only");
    err.status = 403;
    throw err;
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error("id required");
    err.status = 400;
    throw err;
  }
  const patch = {
    draft_patch: body.fields || {},
    draft_missing_fields: missingOf(body.fields || {}),
    draft_fill_rate: fillRate(body.fields || {}),
    draft_updated_at: new Date().toISOString(),
    draft_updated_by: actor(req),
  };
  const pool = getPool();
  const cols = await existingColumns(pool);
  const fields = body.fields && typeof body.fields === "object" ? body.fields : {};
  const allowed = {
    customer_po: clean(fields.customer_po) || null,
    destination_port: clean(fields.destination_port) || null,
    factory_code: clean(fields.factory_code).toUpperCase() || null,
    trade_terms: clean(fields.trade_terms).toUpperCase() || null,
    purchase_trade_terms: clean(fields.purchase_trade_terms).toUpperCase() || null,
    consignee: clean(fields.consignee) || null,
    remarks: clean(fields.remarks) || null,
    products: JSON.stringify(Array.isArray(fields.products) ? fields.products : []),
  };
  const values = [JSON.stringify(patch)];
  const sets = ["raw = COALESCE(raw,'{}'::jsonb) || $1::jsonb"];
  for (const [name, value] of Object.entries(allowed)) {
    if (!cols.has(name)) continue;
    values.push(value);
    const cast = name === "products" ? "::jsonb" : "";
    sets.push(`${name} = $${values.length}${cast}`);
  }
  if (cols.has("updated_at")) sets.push("updated_at = now()");
  values.push(id);
  const r = await pool.query(
    `UPDATE orders
        SET ${sets.join(", ")}
      WHERE id=$${values.length} AND status='draft'
      RETURNING id, order_no, status, raw`,
    values
  );
  if (!r.rows.length) {
    const err = new Error("draft order not found");
    err.status = 404;
    throw err;
  }
  return r.rows[0];
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET") {
      const pool = getPool();
      const stats = await entryStats(pool);
      return res.status(200).json({
        success: true,
        buyers: await listBuyers(pool, req),
        field_stats: stats.fields,
        identifier_stats: stats.identifiers,
      });
    }
    if (req.method === "POST") return res.status(200).json({ success: true, order: await createDraft(req, req.body || {}) });
    if (req.method === "PATCH") return res.status(200).json({ success: true, order: await patchDraft(req, req.body || {}) });
    return res.status(405).json({ success: false, error: "GET/POST/PATCH required" });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, error: e.message });
  }
}
