// P1 疫苗驱虫。⚠️ 属 pet_profile 模块(疫苗依附宠物档案,不单独开通)。
//   🔴 这个页面的价值在【提醒】不在【记录】—— 所以默认按「该打了没」排序,不按创建时间。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const clean = (v, m = 80) => { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; };

async function moduleOk(pool, storeCode) {
  const { rows } = await pool.query(
    `SELECT status::text FROM tenant_module_entitlements
      WHERE store_code=$1 AND module_code='pet_profile'`, [storeCode]);
  const st = rows[0]?.status || "disabled";
  return { visible: st !== "disabled", writable: st === "enabled" };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (!requireAuth(req, res)) return;

  const storeCode = clean(req.query?.storeCode, 32) || "63350001";
  const pool = getPool();
  try {
    const gate = await moduleOk(pool, storeCode);
    if (!gate.visible) return res.status(403).json({ error: "module_disabled", module: "pet_profile" });

    const page = Math.max(1, parseInt(req.query?.page || "1", 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(req.query?.pageSize || 20, 10) || 20));
    const kw = clean(req.query?.q, 40);
    const due = clean(req.query?.due, 16);   // overdue / soon / done

    const args = [storeCode];
    let where = "v.store_code = $1";
    if (kw) { args.push("%" + kw + "%"); where += ` AND (p.name ILIKE $${args.length} OR p.owner_phone ILIKE $${args.length})`; }
    // 🔴 三种状态的判据写死在这里,⛔别让前端各算各的 —— 那样列表和汇总会对不上
    if (due === "overdue") where += " AND v.next_due_at IS NOT NULL AND v.next_due_at < CURRENT_DATE AND v.remind_on";
    else if (due === "soon") where += " AND v.next_due_at BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 AND v.remind_on";
    else if (due === "done") where += " AND v.executed_at IS NOT NULL";

    const total = (await pool.query(
      `SELECT count(*)::int n FROM pet_vaccinations v JOIN pet_profiles p ON p.id=v.pet_id WHERE ${where}`, args)).rows[0].n;

    args.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT v.id, v.kind, v.drug_name, v.source, v.planned_at, v.executed_at,
              v.next_due_at, v.vet_name, v.remind_on, v.remark,
              p.id AS pet_id, p.name AS pet_name, p.avatar_url, p.species, p.breed,
              p.owner_name, p.owner_phone, p.birth_date,
              CASE
                WHEN v.next_due_at IS NULL THEN NULL
                ELSE (v.next_due_at - CURRENT_DATE)
              END AS days_left,
              CASE
                WHEN v.next_due_at IS NULL THEN '无计划'
                WHEN v.next_due_at < CURRENT_DATE THEN '已逾期'
                WHEN v.next_due_at <= CURRENT_DATE + 30 THEN '即将到期'
                ELSE '正常'
              END AS due_state
         FROM pet_vaccinations v JOIN pet_profiles p ON p.id = v.pet_id
        WHERE ${where}
        -- 逾期最前,其次快到的;⛔不按创建时间 —— 这页是给人「今天该联系谁」用的
        ORDER BY (v.next_due_at IS NULL), v.next_due_at ASC, v.id DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`, args);

    const sum = (await pool.query(
      `SELECT
         count(*) FILTER (WHERE next_due_at < CURRENT_DATE AND remind_on)::int overdue,
         count(*) FILTER (WHERE next_due_at BETWEEN CURRENT_DATE AND CURRENT_DATE+30 AND remind_on)::int soon
       FROM pet_vaccinations WHERE store_code=$1`, [storeCode])).rows[0];

    return res.status(200).json({ rows, total, page, pageSize: size, summary: sum, writable: gate.writable });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
