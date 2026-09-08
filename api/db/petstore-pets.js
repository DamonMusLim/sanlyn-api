// P1 宠物档案列表。⚠️ 受模块开关管:pet_profile 未开通时直接 403,⛔不能只靠前端藏菜单。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const PAGE = 20, MAX = 200;
const clean = (v, m = 80) => { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; };

async function moduleOk(pool, storeCode, code) {
  const { rows } = await pool.query(
    `SELECT status::text FROM tenant_module_entitlements
      WHERE store_code=$1 AND module_code=$2`, [storeCode, code]);
  const st = rows[0]?.status || "disabled";
  return { visible: st !== "disabled", writable: st === "enabled", status: st };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (!requireAuth(req, res)) return;

  const storeCode = clean(req.query?.storeCode, 32) || "63350001";
  const pool = getPool();
  try {
    const gate = await moduleOk(pool, storeCode, "pet_profile");
    if (!gate.visible) {
      // 🔴 后端也要拦。菜单藏了但接口能调 = 没开通的功能白送。
      return res.status(403).json({ error: "module_disabled", module: "pet_profile" });
    }
    const page = Math.max(1, parseInt(req.query?.page || "1", 10) || 1);
    const size = Math.min(MAX, Math.max(1, parseInt(req.query?.pageSize || PAGE, 10) || PAGE));
    const kw = clean(req.query?.q, 40);
    const args = [storeCode];
    let where = "store_code = $1 AND is_active";
    if (kw) { args.push("%" + kw + "%"); where += ` AND (name ILIKE $${args.length} OR owner_phone ILIKE $${args.length} OR pet_code ILIKE $${args.length})`; }
    const petWhere = where
      .replace(/\bstore_code\b/g, "p.store_code")
      .replace(/\bis_active\b/g, "p.is_active")
      .replace(/\bname\b/g, "p.name")
      .replace(/\bowner_phone\b/g, "p.owner_phone")
      .replace(/\bpet_code\b/g, "p.pet_code");
    const total = (await pool.query(`SELECT count(*)::int n FROM pet_profiles WHERE ${where}`, args)).rows[0].n;
    args.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT p.id, p.pet_code, p.name, p.avatar_url, p.species, p.breed, p.gender, p.birth_date, p.neutered,
              p.owner_name, p.owner_phone, p.medical_card_no, p.cert_no, p.tags, p.staple_food, p.coat_note, p.temperament,
              p.color, p.height_cm, p.dog_license, p.pet_status,
              p.deworm_interval_months, p.deworm_times_per_interval,
              COALESCE(vaccine.next_due_at, p.next_vaccine_at) AS next_vaccine_at,
              CASE WHEN vaccine.next_due_at IS NULL AND p.next_vaccine_at IS NOT NULL THEN 'manual'
                   WHEN vaccine.next_due_at IS NOT NULL THEN 'computed'
                   ELSE NULL END AS next_vaccine_src,
              rabies.next_due_at AS next_rabies_at,
              deworm_internal.next_due_at AS next_deworm_internal_at,
              deworm_external.next_due_at AS next_deworm_external_at,
              CASE WHEN COALESCE(vaccine.next_due_at, p.next_vaccine_at) IS NULL THEN NULL
                   ELSE (COALESCE(vaccine.next_due_at, p.next_vaccine_at)::date - CURRENT_DATE)
              END AS next_vaccine_days_left,
              CASE WHEN rabies.next_due_at IS NULL THEN NULL ELSE (rabies.next_due_at::date - CURRENT_DATE) END AS next_rabies_days_left,
              CASE WHEN deworm_internal.next_due_at IS NULL THEN NULL ELSE (deworm_internal.next_due_at::date - CURRENT_DATE) END AS next_deworm_internal_days_left,
              CASE WHEN deworm_external.next_due_at IS NULL THEN NULL ELSE (deworm_external.next_due_at::date - CURRENT_DATE) END AS next_deworm_external_days_left,
              CASE
                WHEN COALESCE(vaccine.next_due_at, p.next_vaccine_at) IS NULL THEN '无计划'
                WHEN COALESCE(vaccine.next_due_at, p.next_vaccine_at)::date < CURRENT_DATE THEN '已逾期'
                WHEN COALESCE(vaccine.next_due_at, p.next_vaccine_at)::date <= CURRENT_DATE + 30 THEN '即将到期'
                ELSE '正常'
              END AS next_vaccine_state,
              CASE
                WHEN rabies.next_due_at IS NULL THEN '无计划'
                WHEN rabies.next_due_at::date < CURRENT_DATE THEN '已逾期'
                WHEN rabies.next_due_at::date <= CURRENT_DATE + 30 THEN '即将到期'
                ELSE '正常'
              END AS next_rabies_state,
              CASE
                WHEN deworm_internal.next_due_at IS NULL THEN '无计划'
                WHEN deworm_internal.next_due_at::date < CURRENT_DATE THEN '已逾期'
                WHEN deworm_internal.next_due_at::date <= CURRENT_DATE + 30 THEN '即将到期'
                ELSE '正常'
              END AS next_deworm_internal_state,
              CASE
                WHEN deworm_external.next_due_at IS NULL THEN '无计划'
                WHEN deworm_external.next_due_at::date < CURRENT_DATE THEN '已逾期'
                WHEN deworm_external.next_due_at::date <= CURRENT_DATE + 30 THEN '即将到期'
                ELSE '正常'
              END AS next_deworm_external_state,
              p.remark, p.created_at
         FROM pet_profiles p
         LEFT JOIN LATERAL (
           SELECT v.next_due_at
             FROM pet_vaccinations v
            WHERE v.store_code = p.store_code AND v.pet_id = p.id AND v.kind = '疫苗'
            ORDER BY COALESCE(v.executed_at, v.planned_at, v.next_due_at) DESC NULLS LAST, v.id DESC
            LIMIT 1
         ) vaccine ON true
         LEFT JOIN LATERAL (
           SELECT v.next_due_at
             FROM pet_vaccinations v
            WHERE v.store_code = p.store_code AND v.pet_id = p.id AND v.kind = '狂犬'
            ORDER BY COALESCE(v.executed_at, v.planned_at, v.next_due_at) DESC NULLS LAST, v.id DESC
            LIMIT 1
         ) rabies ON true
         LEFT JOIN LATERAL (
           SELECT v.next_due_at
             FROM pet_vaccinations v
            WHERE v.store_code = p.store_code AND v.pet_id = p.id AND v.kind = '体内驱虫'
            ORDER BY COALESCE(v.executed_at, v.planned_at, v.next_due_at) DESC NULLS LAST, v.id DESC
            LIMIT 1
         ) deworm_internal ON true
         LEFT JOIN LATERAL (
           SELECT v.next_due_at
             FROM pet_vaccinations v
            WHERE v.store_code = p.store_code AND v.pet_id = p.id AND v.kind = '体外驱虫'
            ORDER BY COALESCE(v.executed_at, v.planned_at, v.next_due_at) DESC NULLS LAST, v.id DESC
            LIMIT 1
         ) deworm_external ON true
        WHERE ${petWhere}
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    return res.status(200).json({ rows, total, page, pageSize: size, writable: gate.writable });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
