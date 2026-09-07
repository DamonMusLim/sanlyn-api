// 洗护报告。联 appointments(grooming) + pet_profiles;联不到就留空,⛔不从备注猜。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireVisible } from "../moduleGate.js";
const clean = (v, m = 80) => { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; };

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (!requireAuth(req, res)) return;
  const storeCode = clean(req.query?.storeCode, 32) || "63350001";
  if (!(await requireVisible(req, res, "booking", storeCode))) return;
  const pageSize = Math.min(Math.max(parseInt(req.query?.pageSize, 10) || 20, 1), 200);
  const page = Math.max(parseInt(req.query?.pageNumber, 10) || 1, 1);
  try {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT count(*) OVER() AS __total, g.id, a.start_at AS service_at, p.name AS pet_name, p.breed,
        a.owner_name, a.service_name, a.staff_name, g.service_items, g.coat_condition,
        g.skin_issue, g.next_advice, g.operator, g.created_at
   FROM grooming_reports g
   LEFT JOIN appointments a ON a.id = g.appointment_id
   LEFT JOIN pet_profiles p ON p.id = a.pet_id
  WHERE g.store_code = $1 ORDER BY g.created_at DESC LIMIT $2 OFFSET $3`, [storeCode, pageSize, (page - 1) * pageSize]);
    const total = rows.length ? Number(rows[0].__total || rows.length) : 0;
    return res.status(200).json({ rows: rows.map(({ __total, ...r }) => r), total, pageNumber: page, pageSize });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
