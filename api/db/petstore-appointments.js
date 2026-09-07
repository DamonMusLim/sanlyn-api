import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
const clean = (v, m = 80) => { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; };
async function gateOf(pool, storeCode, mod) {
  const { rows } = await pool.query(
    `SELECT status::text FROM tenant_module_entitlements WHERE store_code=$1 AND module_code=$2`,
    [storeCode, mod]);
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
    const gate = await gateOf(pool, storeCode, "calendar");
    if (!gate.visible) return res.status(403).json({ error: "module_disabled", module: "calendar" });
    const page = Math.max(1, parseInt(req.query?.page || "1", 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(req.query?.pageSize || 20, 10) || 20));
    const kw = clean(req.query?.q, 40);
    const args = [storeCode];
    let where = "t.store_code = $1";
    if (kw) { args.push("%"+kw+"%"); where += ` AND (t.owner_name ILIKE $${args.length} OR p.name ILIKE $${args.length} OR t.staff_name ILIKE $${args.length})`; }
    const day = clean(req.query?.day, 12);
    if (day === "today") where += " AND t.start_at::date = CURRENT_DATE";
    else if (day === "week") where += " AND t.start_at::date BETWEEN CURRENT_DATE AND CURRENT_DATE+7";
    const bt = clean(req.query?.bizType, 16);
    if (bt) { args.push(bt); where += ` AND t.biz_type = $${args.length}`; }
    const total = (await pool.query(`SELECT count(*)::int n FROM appointments t LEFT JOIN pet_profiles p ON p.id=t.pet_id WHERE ${where}`, args)).rows[0].n;
    args.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT t.id, t.biz_type, t.service_name, t.staff_name, t.start_at, t.end_at,
          t.pay_channel, t.book_source, t.status, t.remark, t.owner_name, t.owner_phone,
          t.store_code, t.created_at, p.name AS pet_name, p.avatar_url, p.breed,
          CASE t.biz_type WHEN 'grooming' THEN '洗护' WHEN 'boarding' THEN '寄养'
               WHEN 'clinic' THEN '诊疗' ELSE '其他' END AS biz_cn,
          CASE t.status WHEN 'booked' THEN '已预约' WHEN 'arrived' THEN '已到店'
               WHEN 'doing' THEN '进行中' WHEN 'done' THEN '已完成'
               WHEN 'no_show' THEN '未到' ELSE '已取消' END AS status_cn FROM appointments t LEFT JOIN pet_profiles p ON p.id=t.pet_id WHERE ${where} ORDER BY t.start_at ASC
        LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    const sum = (await pool.query(
      `SELECT count(*) FILTER (WHERE start_at::date=CURRENT_DATE)::int today,
              count(*) FILTER (WHERE start_at::date=CURRENT_DATE AND status='booked')::int today_pending,
              count(*) FILTER (WHERE status='no_show')::int no_show
         FROM appointments WHERE store_code=$1`, [storeCode])).rows[0];
    return res.status(200).json({ rows, total, page, pageSize: size, summary: sum, writable: gate.writable });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
