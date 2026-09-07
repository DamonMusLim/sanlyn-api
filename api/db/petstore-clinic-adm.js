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
    const gate = await gateOf(pool, storeCode, "medical");
    if (!gate.visible) return res.status(403).json({ error: "module_disabled", module: "medical" });
    const page = Math.max(1, parseInt(req.query?.page || "1", 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(req.query?.pageSize || 20, 10) || 20));
    const kw = clean(req.query?.q, 40);
    const args = [storeCode];
    let where = "t.store_code = $1";
    if (kw) { args.push("%"+kw+"%"); where += ` AND (t.owner_name ILIKE $${args.length} OR p.name ILIKE $${args.length} OR t.medical_no ILIKE $${args.length})`; }
    const total = (await pool.query(`SELECT count(*)::int n FROM clinic_admissions t LEFT JOIN pet_profiles p ON p.id = t.pet_id WHERE ${where}`, args)).rows[0].n;
    args.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT t.id, t.medical_no, t.admitted_at, t.discharged_at, t.deposit,
     t.total_amount, t.paid_amount, t.pay_status, t.status, t.remark,
     t.owner_name, t.care_items, t.store_code, t.created_at, p.name AS pet_name, p.avatar_url, p.breed,
     (t.total_amount - t.paid_amount) AS unpaid,
     CASE WHEN t.status='在院' THEN (CURRENT_DATE - t.admitted_at::date) END AS days_in FROM clinic_admissions t LEFT JOIN pet_profiles p ON p.id = t.pet_id WHERE ${where} ORDER BY (t.status='在院') DESC, t.admitted_at DESC NULLS LAST
        LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    const sum = (await pool.query(
      `SELECT count(*) FILTER (WHERE status='在院')::int in_house,
              COALESCE(SUM(total_amount-paid_amount) FILTER (WHERE status='在院'),0)::numeric(12,2) unpaid
         FROM clinic_admissions WHERE store_code=$1`, [storeCode])).rows[0];
    return res.status(200).json({ rows, total, page, pageSize: size, summary: sum, writable: gate.writable });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
