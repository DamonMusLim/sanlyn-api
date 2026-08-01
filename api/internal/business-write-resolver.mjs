#!/usr/bin/env node
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;
const APPLY_LIMIT = 5;
const ACTIONS = new Set(["link_bl_orders", "link_oli_product", "fill_factory_from_oli_product"]);

function jsonOut(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function poolFor(readonly = false) {
  return new Pool({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT || "5432", 10),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: false,
    max: readonly ? 1 : 2,
  });
}

function sha(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

function qIdent(s) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`bad identifier: ${s}`);
  return `"${s}"`;
}

async function tableCols(client, table) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

async function schema(client) {
  const orders = await tableCols(client, "orders");
  const plans = await tableCols(client, "shipping_plans");
  const oli = await tableCols(client, "order_line_items");
  const products = await tableCols(client, "products");
  const companies = await tableCols(client, "companies");
  const factoryCol = orders.has("factory_company_id") ? "factory_company_id" : orders.has("factory_code") ? "factory_code" : null;
  const orderIdCol = orders.has("id") ? "id" : "_id";
  const planTextCols = [
    "contract_no", "order_contract_nos", "bl_no", "hbl_no", "mbl_no",
    "so_no", "booking_no", "forwarder_booking_no", "raw",
  ].filter((c) => plans.has(c));
  return { orders, plans, oli, products, companies, factoryCol, orderIdCol, planTextCols };
}

function requireCols(s, spec) {
  for (const [table, cols] of Object.entries(spec)) {
    for (const col of cols) {
      if (!s[table].has(col)) throw new Error(`${table}.${col} missing`);
    }
  }
}

function planTextExpr(cols) {
  return cols.map((c) => `COALESCE(sp.${qIdent(c)}::text,'')`).join(" || ' ' || ") || "''";
}

function linkBlSql(s, where = "", limit = "") {
  requireCols(s, { plans: ["id", "order_nos"], orders: ["order_no"] });
  if (!s.orders.has("contract_no")) throw new Error("orders.contract_no missing");
  const textExpr = planTextExpr(s.planTextCols);
  return `
WITH plan_tokens AS (
  SELECT sp.id AS plan_id, upper(trim(m[1])) AS token
  FROM shipping_plans sp
  CROSS JOIN LATERAL regexp_matches(${textExpr}, '([A-Z]{1,4}[0-9][A-Z0-9-]{2,}|[0-9]{2,3}-[A-Z0-9-]{2,})', 'g') AS m
  WHERE (sp.order_nos IS NULL OR cardinality(sp.order_nos)=0)
  ${where ? `AND ${where}` : ""}
),
token_matches AS (
  SELECT pt.plan_id, pt.token, o.order_no
  FROM plan_tokens pt
  JOIN orders o ON upper(o.order_no)=pt.token OR upper(COALESCE(o.contract_no,''))=pt.token
),
ambiguous_plans AS (
  SELECT plan_id
  FROM token_matches
  GROUP BY plan_id, token
  HAVING count(DISTINCT order_no)<>1
),
unique_token_matches AS (
  SELECT plan_id, token, min(order_no) AS order_no
  FROM token_matches
  GROUP BY plan_id, token
  HAVING count(DISTINCT order_no)=1
)
SELECT plan_id AS target_id, NULL::text[] AS old_value,
       array_agg(DISTINCT order_no ORDER BY order_no) AS new_value,
       jsonb_agg(DISTINCT jsonb_build_object('token', token, 'order_no', order_no)) AS source
FROM unique_token_matches
WHERE plan_id NOT IN (SELECT plan_id FROM ambiguous_plans)
GROUP BY plan_id
HAVING count(DISTINCT order_no) >= 1
ORDER BY plan_id
${limit}`;
}

function linkOliSql(s, where = "", limit = "") {
  requireCols(s, { oli: ["id", "sku", "product_id"], products: ["id", "sku"] });
  return `
WITH unique_products AS (
  SELECT sku, min(id) AS product_id
  FROM products
  WHERE NULLIF(trim(sku),'') IS NOT NULL
  GROUP BY sku
  HAVING count(DISTINCT id)=1
)
SELECT oli.id AS target_id, oli.product_id AS old_value, up.product_id AS new_value,
       jsonb_build_object('sku', oli.sku, 'product_id', up.product_id) AS source
FROM order_line_items oli
JOIN unique_products up ON up.sku=oli.sku
WHERE oli.product_id IS NULL AND NULLIF(trim(oli.sku),'') IS NOT NULL
${where ? `AND ${where}` : ""}
ORDER BY oli.id
${limit}`;
}

function fillFactorySql(s, where = "", limit = "") {
  if (!s.factoryCol) throw new Error("orders factory association column missing");
  requireCols(s, {
    orders: [s.orderIdCol, s.factoryCol],
    oli: ["order_id", "product_id"],
    products: ["id", "factory_code"],
    companies: s.factoryCol === "factory_company_id" ? ["id", "code"] : ["code"],
  });
  const targetExpr = s.factoryCol === "factory_company_id" ? "min(c.id)::text" : "min(c.code)::text";
  const newCast = s.factoryCol === "factory_company_id" ? "::int" : "::text";
  return `
WITH factory_candidates AS (
  SELECT o.${qIdent(s.orderIdCol)} AS target_id, o.${qIdent(s.factoryCol)} AS old_value,
         ${targetExpr} AS new_value,
         jsonb_agg(DISTINCT jsonb_build_object('product_id', p.id, 'factory_code', p.factory_code)) AS source
  FROM orders o
  JOIN order_line_items oli ON oli.order_id=o.${qIdent(s.orderIdCol)}
  JOIN products p ON p.id=oli.product_id
  JOIN companies c ON c.code=p.factory_code
  WHERE o.${qIdent(s.factoryCol)} IS NULL
  ${where ? `AND ${where}` : ""}
  GROUP BY o.${qIdent(s.orderIdCol)}, o.${qIdent(s.factoryCol)}
  HAVING count(*) > 0
     AND count(DISTINCT c.code)=1
     AND NOT EXISTS (
       SELECT 1 FROM order_line_items bad
       LEFT JOIN products bp ON bp.id=bad.product_id
       LEFT JOIN companies bc ON bc.code=bp.factory_code
       WHERE bad.order_id=o.${qIdent(s.orderIdCol)}
         AND (bad.product_id IS NULL OR bp.factory_code IS NULL OR bc.code IS NULL)
     )
)
SELECT target_id, old_value, new_value${newCast} AS new_value, source
FROM factory_candidates
ORDER BY target_id
${limit}`;
}

function candidateSql(action, s, where = "", limit = "") {
  if (action === "link_bl_orders") return linkBlSql(s, where, limit);
  if (action === "link_oli_product") return linkOliSql(s, where, limit);
  return fillFactorySql(s, where, limit);
}

function blockedSql(action, s) {
  if (action === "link_bl_orders") {
    const textExpr = planTextExpr(s.planTextCols);
    return `
WITH plan_tokens AS (
  SELECT sp.id AS plan_id, upper(trim(m[1])) AS token
  FROM shipping_plans sp
  CROSS JOIN LATERAL regexp_matches(${textExpr}, '([A-Z]{1,4}[0-9][A-Z0-9-]{2,}|[0-9]{2,3}-[A-Z0-9-]{2,})', 'g') AS m
  WHERE (sp.order_nos IS NULL OR cardinality(sp.order_nos)=0)
),
token_matches AS (
  SELECT pt.plan_id, pt.token, o.order_no
  FROM plan_tokens pt
  JOIN orders o ON upper(o.order_no)=pt.token OR upper(COALESCE(o.contract_no,''))=pt.token
)
SELECT 'ambiguous_token' AS reason, count(DISTINCT plan_id)::int AS n
FROM token_matches
GROUP BY reason, plan_id, token
HAVING count(DISTINCT order_no)<>1`;
  }
  if (action === "link_oli_product") {
    return `
WITH ambiguous_skus AS (
  SELECT sku FROM products WHERE NULLIF(trim(sku),'') IS NOT NULL GROUP BY sku HAVING count(DISTINCT id)>1
)
SELECT 'ambiguous_sku' AS reason, count(*)::int AS n
FROM order_line_items oli JOIN ambiguous_skus a ON a.sku=oli.sku
WHERE oli.product_id IS NULL`;
  }
  return `
SELECT 'factory_not_unique_or_incomplete' AS reason, count(*)::int AS n
FROM orders o
WHERE o.${qIdent(s.factoryCol)} IS NULL
  AND EXISTS (SELECT 1 FROM order_line_items oli WHERE oli.order_id=o.${qIdent(s.orderIdCol)})
  AND NOT EXISTS (SELECT 1 FROM (${fillFactorySql(s)}) ok WHERE ok.target_id=o.${qIdent(s.orderIdCol)})`;
}

async function candidates(client, action, s, sampleLimit = 20) {
  const sql = candidateSql(action, s, "", sampleLimit ? `LIMIT ${Number(sampleLimit)}` : "");
  const countSql = `SELECT count(*)::int AS n FROM (${candidateSql(action, s)}) x`;
  const count = await client.query(countSql);
  const sample = await client.query(sql);
  const blocked = await client.query(`SELECT reason, sum(n)::int AS n FROM (${blockedSql(action, s)}) b GROUP BY reason ORDER BY reason`);
  return { count: count.rows[0].n, blocked: blocked.rows, sample: sample.rows, sql_hash: sha(candidateSql(action, s)) };
}

async function insertAudit(client, action, table, targetId, oldValue, newValue, source, verifySql, verified, rollback) {
  await client.query(
    `INSERT INTO ai_business_write_audit
       (action,target_table,target_pk,old_payload,new_payload,source_payload,verify_sql_hash,rollback_payload,verified,actor)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10)`,
    [action, table, String(targetId), JSON.stringify(oldValue), JSON.stringify(newValue), JSON.stringify(source),
      sha(verifySql), JSON.stringify(rollback), verified, "business-write-resolver.mjs"]
  );
}

async function applyOne(pool, action, s, row) {
  const client = await pool.connect();
  const roPool = poolFor(true);
  try {
    await client.query("BEGIN");
    let table, lockSql, updateSql, vals, emptySql;
    if (action === "link_bl_orders") {
      table = "shipping_plans";
      lockSql = "SELECT id, order_nos FROM shipping_plans WHERE id=$1 FOR UPDATE";
      updateSql = s.plans.has("updated_at")
        ? "UPDATE shipping_plans SET order_nos=$2::text[], updated_at=NOW() WHERE id=$1 AND (order_nos IS NULL OR cardinality(order_nos)=0) RETURNING order_nos"
        : "UPDATE shipping_plans SET order_nos=$2::text[] WHERE id=$1 AND (order_nos IS NULL OR cardinality(order_nos)=0) RETURNING order_nos";
      vals = [row.target_id, row.new_value];
      emptySql = "SELECT order_nos FROM shipping_plans WHERE id=$1";
    } else if (action === "link_oli_product") {
      table = "order_line_items";
      lockSql = "SELECT id, product_id FROM order_line_items WHERE id=$1 FOR UPDATE";
      updateSql = "UPDATE order_line_items SET product_id=$2 WHERE id=$1 AND product_id IS NULL RETURNING product_id";
      vals = [row.target_id, row.new_value];
      emptySql = "SELECT product_id FROM order_line_items WHERE id=$1";
    } else {
      table = "orders";
      const col = qIdent(s.factoryCol);
      lockSql = `SELECT ${qIdent(s.orderIdCol)} AS id, ${col} AS factory FROM orders WHERE ${qIdent(s.orderIdCol)}=$1 FOR UPDATE`;
      updateSql = `UPDATE orders SET ${col}=$2 WHERE ${qIdent(s.orderIdCol)}=$1 AND ${col} IS NULL RETURNING ${col}`;
      vals = [row.target_id, row.new_value];
      emptySql = `SELECT ${col} FROM orders WHERE ${qIdent(s.orderIdCol)}=$1`;
    }
    const locked = await client.query(lockSql, [row.target_id]);
    if (locked.rowCount !== 1) throw new Error(`target disappeared: ${table} ${row.target_id}`);
    const recheckSql = candidateSql(action, s, `${table === "shipping_plans" ? "sp.id" : table === "order_line_items" ? "oli.id" : `o.${qIdent(s.orderIdCol)}`}=$1`);
    const recheck = await client.query(recheckSql, [row.target_id]);
    if (recheck.rowCount !== 1) throw new Error(`candidate no longer unique: ${action} ${row.target_id}`);
    const upd = await client.query(updateSql, vals);
    if (upd.rowCount !== 1) throw new Error(`still-empty guard blocked update: ${action} ${row.target_id}`);
    const verify = await client.query(emptySql, [row.target_id]);
    await insertAudit(client, action, table, row.target_id, locked.rows[0], upd.rows[0], row.source, emptySql, true, locked.rows[0]);
    await client.query("COMMIT");
    const ro = await roPool.query(emptySql, [row.target_id]);
    return { ok: true, target_id: row.target_id, tx_value: verify.rows[0], readonly_value: ro.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, target_id: row.target_id, error: err.message };
  } finally {
    client.release();
    await roPool.end().catch(() => {});
  }
}

async function main() {
  const input = JSON.parse(await new Promise((resolve) => {
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => resolve(s || "{}"));
  }));
  const action = input.action;
  if (!ACTIONS.has(action)) throw new Error(`bad action: ${action}`);
  const apply = input.apply === true;
  const pool = poolFor(false);
  try {
    const client = await pool.connect();
    try {
      const s = await schema(client);
      const dry = await candidates(client, action, s, Number(input.sample_limit || 20));
      if (!apply) return jsonOut({ ok: true, mode: "dry_run", action, ...dry });
      const n = Math.min(Number(input.limit || APPLY_LIMIT), APPLY_LIMIT);
      const rows = (await client.query(candidateSql(action, s, "", `LIMIT ${n}`))).rows;
      const results = [];
      for (const row of rows) results.push(await applyOne(pool, action, s, row));
      return jsonOut({ ok: results.every((r) => r.ok), mode: "apply", action, limit: n, candidate_count: dry.count, results });
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  jsonOut({ ok: false, error: err.message, stack: err.stack });
  process.exitCode = 1;
});
