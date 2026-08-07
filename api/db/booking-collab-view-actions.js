// booking-collab-view-actions.js — 写操作 handler（拆自 booking-collab-view.js 2026-07-13）
import { mirrorPlanBlToOrders } from "../lib/bl-order-mirror.js"; // 2026-07-13: bl_no 镜像同步到 orders
import { NON_EMPTY, arr, resolvePlan, columnExists } from "./booking-collab-view-lib.js";
import { validateReleaseTypeBody } from "./lib/release-type.js";

// party company_id 列 → 对应中文名列（写 id 时顺带回填名字，便于前端 linked() 判定）
const PARTY_COLUMNS = {
  forwarder_company_id: "forwarder_cn",
  customer_company_id: null,
  factory_company_id: null,
  trucking_company_id: "trucking_company_cn",
  customs_broker_id: "customs_broker_cn",
};
// 每个 company_id 列应指向的 companies.type（写入前校验，防把货代写进工厂位）
const PARTY_TYPE = {
  forwarder_company_id: "forwarder",
  customer_company_id: "customer",
  factory_company_id: "factory",
  trucking_company_id: "trucking",
  customs_broker_id: "customs_broker",
};
// 无专属列的党派 → 落 raw JSON（洋宝宝/巴匕，待迁移补列）
const RAW_PARTY = ["intermediary_company_id", "exporter_company_id"];
const SCALAR_COLS = ["trucking_arrange", "customs_arrange", "freight_term", "release_type"];

// POST /supply-chain — 保存某一方公司（手动选/一键关联/采纳建议都走这里）
export async function handleSupplyChain(req, res, pool) {
  const body = req.body || {};
  const rel = validateReleaseTypeBody(body);
  if (!rel.ok) return res.status(400).json({ ok: false, error: rel.error });
  const plan = await resolvePlan(pool, body.plan_id);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });

  const sets = [], vals = [];
  for (const [col, cnCol] of Object.entries(PARTY_COLUMNS)) {
    if (!(col in body)) continue;
    let id = null, nm = null;
    if (NON_EMPTY(body[col])) {
      const n = Number(body[col]);
      if (!Number.isSafeInteger(n) || n <= 0) return res.status(400).json({ ok: false, error: `invalid_company:${col}` });
      const chk = await pool.query(
        `SELECT id, type, COALESCE(name_cn, name_en) AS nm FROM companies WHERE id = $1 AND (active IS NOT FALSE) LIMIT 1`, [n]);
      if (!chk.rows.length) return res.status(400).json({ ok: false, error: `invalid_company:${col}` });
      if (PARTY_TYPE[col] && chk.rows[0].type !== PARTY_TYPE[col]) return res.status(400).json({ ok: false, error: `wrong_type:${col}` });
      id = n; nm = chk.rows[0].nm;
    }
    vals.push(id); sets.push(`${col} = $${vals.length}`);
    if (id != null && cnCol && nm) { vals.push(nm); sets.push(`${cnCol} = $${vals.length}`); }
  }
  for (const col of SCALAR_COLS) {
    if (col in body) { vals.push(NON_EMPTY(body[col]) ? body[col] : null); sets.push(`${col} = $${vals.length}`); }
  }
  const rawPatch = {};
  for (const col of RAW_PARTY) if (col in body) rawPatch[col] = NON_EMPTY(body[col]) ? body[col] : null;
  if (Object.keys(rawPatch).length) {
    vals.push(JSON.stringify(rawPatch));
    sets.push(`raw = COALESCE(raw, '{}'::jsonb) || $${vals.length}::jsonb`);
  }
  if (!sets.length) return res.status(400).json({ ok: false, error: "没有可更新字段" });
  vals.push(plan.id);
  await pool.query(`UPDATE shipping_plans SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  return res.json({ ok: true });
}

// POST /assign-orders — 加/撤订单到本票(事务+乐观锁+add只认无归属单,防抢)
export async function handleAssignOrders(req, res, pool) {
  const body = req.body || {};
  const plan = await resolvePlan(pool, body.plan_id);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });
  const add = arr(body.add).map(Number).filter(Number.isSafeInteger);
  const remove = arr(body.remove).map(Number).filter(Number.isSafeInteger);
  const hasVersion = await columnExists(pool, "shipping_plans", "version");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (hasVersion) {
      const v = await client.query(`SELECT version FROM shipping_plans WHERE id = $1 FOR UPDATE`, [plan.id]);
      if (body.version != null && v.rows.length && String(v.rows[0].version) !== String(body.version)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, error: "version_conflict" });
      }
    }
    let added = 0, removed = 0;
    if (add.length) {
      const r = await client.query(`UPDATE orders SET shipping_plan_id = $1 WHERE id = ANY($2::int[]) AND shipping_plan_id IS NULL`, [plan.id, add]);
      added = r.rowCount;
    }
    if (remove.length) {
      const r = await client.query(`UPDATE orders SET shipping_plan_id = NULL WHERE id = ANY($1::int[]) AND shipping_plan_id = $2`, [remove, plan.id]);
      removed = r.rowCount;
    }
    if (hasVersion) await client.query(`UPDATE shipping_plans SET version = COALESCE(version, 0) + 1 WHERE id = $1`, [plan.id]);
    await client.query("COMMIT");
    await mirrorPlanBlToOrders(pool, plan.id, "assign-orders");
    return res.json({ ok: true, added, removed });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// POST /confirm-shipment — 确认已出运
export async function handleConfirmShipment(req, res, pool) {
  const body = req.body || {};
  const plan = await resolvePlan(pool, body.plan_id);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });
  const sets = ["shipped_confirmed_at = NOW()"], vals = [];
  if (NON_EMPTY(body.shipment_date)) { vals.push(body.shipment_date); sets.push(`shipment_date = $${vals.length}`); }
  vals.push(plan.id);
  await pool.query(`UPDATE shipping_plans SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  return res.json({ ok: true });
}

// POST /add-factory — 关联现有工厂公司（或新建）
export async function handleAddFactory(req, res, pool) {
  const body = req.body || {};
  const plan = await resolvePlan(pool, body.plan_id);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });
  let companyId = null, label = "", dup_warning = "";
  if (NON_EMPTY(body.company_id)) {
    const n = Number(body.company_id);
    if (!Number.isSafeInteger(n) || n <= 0) return res.status(400).json({ ok: false, error: "invalid_company_id" });
    const chk = await pool.query(
      `SELECT id, COALESCE(name_cn, name_en) AS nm FROM companies WHERE id = $1 AND type = 'factory' AND (active IS NOT FALSE) LIMIT 1`, [n]);
    if (!chk.rows.length) return res.status(404).json({ ok: false, error: "找不到该工厂公司" });
    companyId = n; label = chk.rows[0].nm;
  } else if (NON_EMPTY(body.name)) {
    const nm = String(body.name).trim();
    const ex = await pool.query(
      `SELECT id, COALESCE(name_cn, name_en) AS n FROM companies
        WHERE lower(trim(name_cn)) = lower($1) OR lower(trim(name_en)) = lower($1) LIMIT 1`, [nm]);
    if (ex.rows.length) { companyId = ex.rows[0].id; label = ex.rows[0].n; dup_warning = `已存在同名公司，已关联：${label}`; }
    else {
      try {
        const ins = await pool.query(`INSERT INTO companies (name_cn, type, active) VALUES ($1, 'factory', true) RETURNING id, name_cn`, [nm]);
        companyId = ins.rows[0].id; label = ins.rows[0].name_cn;
      } catch (e) { console.error("[add-factory]", e.message); return res.status(400).json({ ok: false, error: "新建工厂失败" }); }
    }
  } else return res.status(400).json({ ok: false, error: "company_id 或 name 必填" });
  const up = await pool.query(
    `UPDATE shipping_plans SET factory_company_id = COALESCE(factory_company_id, $1) WHERE id = $2 RETURNING factory_company_id`, [companyId, plan.id]);
  const current = up.rows.length ? up.rows[0].factory_company_id : companyId;
  const already_linked = String(current) !== String(companyId);
  return res.json({ ok: true, factory: { id: companyId, label }, dup_warning, already_linked, current_factory_id: current });
}
