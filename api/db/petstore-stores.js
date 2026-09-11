// 门店主表读取。给 jdc 后台的门店切换器用。
// ⛔ 刻意不过 requireVisible —— 切换器自己要用的清单如果被模块闸拦住,
//    会出现「切到没开通某模块的店 → 门店列表都拉不到 → 再也切不回来」的死锁。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireWritable } from "../moduleGate.js";

const STORE_FIELDS = [
  "short_code", "address", "phone", "subtitle", "badge", "hours", "is_24h", "lat", "lng",
  "camera_notice", "express_days", "gdc_store_code", "online_shop", "sort_order"
];

function bodyOf(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function text(v, max, name, required = false) {
  if (v === undefined || v === null || v === "") {
    if (required) throw Object.assign(new Error(`${name}必填`), { status: 400 });
    return null;
  }
  const s = String(v).trim();
  if (!s && required) throw Object.assign(new Error(`${name}必填`), { status: 400 });
  if (s.length > max) throw Object.assign(new Error(`${name}不能超过${max}个字符`), { status: 400 });
  return s || null;
}

function codeOf(v) {
  const code = text(v, 32, "code", true);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) {
    throw Object.assign(new Error("code 只允许字母、数字、下划线和横线,长度 1~32"), { status: 400 });
  }
  return code;
}

function operatorFromReq(req) {
  return String(req.user?.username || req.user?.name || req.user?.account || "admin").trim().slice(0, 80) || "admin";
}

function err(res, e) {
  return res.status(e.status || 500).json({ error: String(e.message || "服务器开小差了,请稍后再试").slice(0, 200) });
}

async function createStore(pool, body) {
  const code = codeOf(body.code);
  const name = text(body.name, 80, "name", true);
  const exists = await pool.query(`SELECT 1 FROM petstore_stores WHERE code = $1`, [code]);
  if (exists.rowCount) throw Object.assign(new Error("门店编号已存在"), { status: 409 });

  const cols = ["code", "name", ...STORE_FIELDS, "is_active"];
  const vals = [code, name, ...STORE_FIELDS.map((k) => body[k] ?? null), true];
  await pool.query(`INSERT INTO petstore_stores (${cols.join(", ")}) VALUES (
    $1, $2, $3, COALESCE($4, ''), COALESCE($5, ''), COALESCE($6, ''), COALESCE($7, ''),
    COALESCE($8, ''), COALESCE($9, false), COALESCE($10, 0), COALESCE($11, 0),
    COALESCE($12, ''), COALESCE($13, '3-5'), $14, COALESCE($15, false),
    COALESCE($16, 0), $17
  )`, vals);
  return { code };
}

async function updateStore(pool, body) {
  const code = codeOf(body.code);
  if (body.name !== undefined) text(body.name, 80, "name", true);
  const fields = ["name", ...STORE_FIELDS].filter((k) => Object.prototype.hasOwnProperty.call(body, k));
  if (!fields.length) throw Object.assign(new Error("没有要修改的字段"), { status: 400 });

  const sets = fields.map((k, i) => `${k} = $${i + 2}`);
  const vals = [code, ...fields.map((k) => body[k])];
  const r = await pool.query(`UPDATE petstore_stores SET ${sets.join(", ")} WHERE code = $1`, vals);
  if (!r.rowCount) throw Object.assign(new Error("门店不存在"), { status: 404 });
  return { code };
}

async function deleteStore(pool, code) {
  const count = await pool.query(`SELECT count(*)::int AS n FROM petstore_shop_order WHERE store_code = $1`, [code]);
  const n = Number(count.rows[0]?.n || 0);
  if (n > 0) throw Object.assign(new Error(`该门店还有 ${n} 笔订单,不能停用`), { status: 409 });

  const r = await pool.query(`UPDATE petstore_stores SET is_active = false WHERE code = $1`, [code]);
  if (!r.rowCount) throw Object.assign(new Error("门店不存在"), { status: 404 });
  return { code, message: "已停用,不再出现在门店切换器里" };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    if (req.method === "GET") {
      const { rows } = await pool.query(`SELECT code, short_code, name, address, phone, subtitle, badge, hours,
        is_24h, lat::float8 AS lat, lng::float8 AS lng, camera_notice, express_days, gdc_store_code,
        online_shop, is_active, sort_order,
        (gdc_store_code IS NOT NULL) AS data_ready,
        CASE
          WHEN gdc_store_code IS NULL THEN '未接数据'
          WHEN online_shop = false THEN '仅后台'
          ELSE '正常'
        END AS status_cn
   FROM petstore_stores
  WHERE is_active = $1
  ORDER BY sort_order, code`, [true]);
      return res.status(200).json({ rows, total: rows.length });
    }

    if (req.method === "POST") {
      const body = bodyOf(req);
      const action = String(body.action || "").trim();
      const adminStore = String(body.storeCode || "").trim() || "63350001";
      const gate = await requireWritable(req, res, "core_tenant", adminStore);
      if (!gate) return;

      let out;
      if (action === "create") out = await createStore(pool, body);
      else if (action === "update") out = await updateStore(pool, body);
      else if (action === "delete") out = await deleteStore(pool, codeOf(body.code));
      else throw Object.assign(new Error("action 不支持"), { status: 400 });

      console.log(`[petstore-stores] action=${action} code=${out.code} by=${operatorFromReq(req)}`);
      return res.status(200).json({ ok: true, ...out });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "门店编号已存在" });
    return err(res, e);
  }
}
