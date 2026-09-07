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
    const gate = await gateOf(pool, storeCode, "boarding");
    if (!gate.visible) return res.status(403).json({ error: "module_disabled", module: "boarding" });
    const page = Math.max(1, parseInt(req.query?.page || "1", 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(req.query?.pageSize || 20, 10) || 20));
    const kw = clean(req.query?.q, 40);
    const args = [storeCode];
    let where = "t.store_code = $1";
    if (kw) { args.push("%"+kw+"%"); where += ` AND (t.owner_name ILIKE $${args.length} OR t.owner_phone ILIKE $${args.length} OR p.name ILIKE $${args.length})`; }
    const st = clean(req.query?.status, 16);
    if (st) { args.push(st); where += ` AND t.status = $${args.length}`; }
    const total = (await pool.query(`SELECT count(*)::int n FROM boarding_orders t LEFT JOIN boarding_rooms r ON r.id=t.room_id LEFT JOIN pet_profiles p ON p.id=t.pet_id WHERE ${where}`, args)).rows[0].n;
    args.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT t.id, t.order_no, t.check_in, t.check_out, t.planned_out, t.day_rule, t.days,
          t.price_per_day, t.deposit, t.total_amount, t.paid_amount, t.status, t.belongings, t.remark,
          t.owner_name, t.owner_phone,
          r.room_no, r.room_type, p.name AS pet_name, p.avatar_url, p.breed,
          CASE t.status WHEN 'booked' THEN '待入住' WHEN 'in_house' THEN '在住'
               WHEN 'checked_out' THEN '已退房' ELSE '已取消' END AS status_cn,
          CASE WHEN t.status='in_house' AND t.planned_out IS NOT NULL
               THEN (t.planned_out::date - CURRENT_DATE) END AS days_left FROM boarding_orders t LEFT JOIN boarding_rooms r ON r.id=t.room_id LEFT JOIN pet_profiles p ON p.id=t.pet_id WHERE ${where} ORDER BY (t.status='in_house') DESC, t.check_in DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    const sum = (await pool.query(
      `SELECT count(*) FILTER (WHERE status='in_house')::int in_house,
              count(*) FILTER (WHERE status='booked')::int booked,
              COALESCE(SUM(deposit) FILTER (WHERE status='in_house'),0)::numeric(12,2) deposit_held
         FROM boarding_orders WHERE store_code=$1`, [storeCode])).rows[0];
    return res.status(200).json({ rows, total, page, pageSize: size, summary: sum, writable: gate.writable });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
