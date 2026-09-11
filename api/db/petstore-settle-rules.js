import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireVisible, requireWritable } from "../moduleGate.js";

const CREATE_FIELDS = [
  "store_code", "settle_entity_name", "entity_type", "merchant_no", "platform_fee_mode",
  "platform_fee_rate_bp", "platform_fee_fixed_fen", "freight_bearer", "effective_from",
  "effective_to", "note"
];
const UPDATE_FIELDS = CREATE_FIELDS.filter((k) => k !== "store_code");

function bodyOf(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function bad(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function reqText(body, key, name = key) {
  const s = String(body[key] ?? "").trim();
  if (!s) bad(`${name}必填`);
  return s;
}

function idOf(v) {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id <= 0) bad("id 必填");
  return id;
}

function operatorFromReq(req) {
  return String(req.user?.username || req.user?.name || req.user?.account || "admin").trim().slice(0, 80) || "admin";
}

function publicError(res, e) {
  if (e.code === "23505") {
    const c = String(e.constraint || "");
    if (c.includes("effective_from")) {
      return res.status(409).json({ error: "这家店在这个生效日已经有一版规则了" });
    }
    return res.status(409).json({ error: "这家店已经有一条至今有效的规则,请先给旧的填上结束日期" });
  }
  if (e.code === "23514") return res.status(400).json({ error: "字段值不符合配置表约束" });
  if (e.code === "23503") return res.status(409).json({ error: "这条规则已经被订单引用,不能删除" });

  const msg = String(e.message || "");
  if (msg.includes("结算规则生效区间与已有版本重叠")) {
    return res.status(409).json({ error: msg.slice(0, 200) });
  }
  return res.status(e.status || 500).json({
    error: e.status ? msg.slice(0, 200) : "服务器开小差了,请稍后再试"
  });
}

async function listRules(req, res, pool) {
  const storeCode = String(req.query?.storeCode || "").trim();
  const gate = await requireVisible(req, res, "core_tenant", storeCode || undefined);
  if (!gate) return;

  const params = [];
  const where = storeCode ? "WHERE store_code = $1" : "";
  if (storeCode) params.push(storeCode);

  const { rows } = await pool.query(`
    SELECT id, store_code, settle_entity_name, entity_type, merchant_no,
           platform_fee_mode, platform_fee_rate_bp, platform_fee_fixed_fen,
           freight_bearer, effective_from, effective_to, note, created_at, updated_at,
           CASE entity_type
             WHEN 'own' THEN '自营'
             WHEN 'branch' THEN '分公司'
             WHEN 'independent' THEN '独立主体'
           END AS entity_type_cn,
           CASE platform_fee_mode
             WHEN 'none' THEN '不抽'
             WHEN 'rate' THEN '按 ' || to_char(platform_fee_rate_bp::numeric / 100, 'FM990.00') || '%'
             WHEN 'fixed' THEN '每单 ' || to_char(platform_fee_fixed_fen::numeric / 100, 'FM999999990.00') || ' 元'
           END AS fee_cn,
           effective_from::text || ' ~ ' || coalesce(effective_to::text, '至今') AS period_cn
      FROM petstore_store_settle_rule
      ${where}
     ORDER BY store_code, effective_from DESC`, params);
  return res.status(200).json({ rows, total: rows.length });
}

async function createRule(pool, body) {
  reqText(body, "store_code");
  reqText(body, "settle_entity_name");
  reqText(body, "entity_type");
  reqText(body, "effective_from");

  const vals = CREATE_FIELDS.map((k) => body[k] ?? null);
  const ph = vals.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `INSERT INTO petstore_store_settle_rule (${CREATE_FIELDS.join(", ")})
     VALUES (${ph}) RETURNING id, store_code`,
    vals
  );
  return rows[0];
}

async function updateRule(pool, body) {
  const id = idOf(body.id);
  if (Object.prototype.hasOwnProperty.call(body, "store_code")) bad("store_code 不可修改,请删除后重建");

  const fields = UPDATE_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
  if (!fields.length) bad("没有要修改的字段");

  const vals = fields.map((k) => body[k]);
  const sets = fields.map((k, i) => `${k} = $${i + 2}`);
  const { rows } = await pool.query(
    `UPDATE petstore_store_settle_rule SET ${sets.join(", ")} WHERE id = $1 RETURNING id, store_code`,
    [id, ...vals]
  );
  if (!rows.length) bad("规则不存在", 404);
  return rows[0];
}

async function deleteRule(pool, id) {
  const count = await pool.query(`SELECT count(*)::int AS n FROM petstore_order_settlement WHERE rule_id = $1`, [id]);
  const n = Number(count.rows[0]?.n || 0);
  if (n > 0) {
    bad(`这条规则已经被 ${n} 笔订单的分账记录引用,不能删。要停用请把 effective_to 改成昨天。`, 409);
  }

  const { rows } = await pool.query(
    `DELETE FROM petstore_store_settle_rule WHERE id = $1 RETURNING id, store_code`,
    [id]
  );
  if (!rows.length) bad("规则不存在", 404);
  return rows[0];
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  try {
    if (req.method === "GET") return await listRules(req, res, pool);

    if (req.method === "POST") {
      const body = bodyOf(req);
      const action = String(body.action || "").trim();
      let storeCode = String(body.store_code || "").trim();

      if (action === "update" || action === "delete") {
        const id = idOf(body.id);
        const r = await pool.query(`SELECT store_code FROM petstore_store_settle_rule WHERE id = $1`, [id]);
        if (!r.rowCount) bad("规则不存在", 404);
        storeCode = r.rows[0].store_code;
      }
      if (!storeCode) bad("store_code 必填");

      const gate = await requireWritable(req, res, "core_tenant", storeCode);
      if (!gate) return;

      let out;
      if (action === "create") out = await createRule(pool, body);
      else if (action === "update") out = await updateRule(pool, body);
      else if (action === "delete") out = await deleteRule(pool, idOf(body.id));
      else bad("action 不支持");

      console.log(`[settle-rules] action=${action} id=${out.id} by=${operatorFromReq(req)}`);
      return res.status(200).json({ ok: true, ...out });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return publicError(res, e);
  }
}
