// 回访管理 · 0903。表 clinic_followups 早建好没人读 —— 补上读口。
// 🔴 逾期判定放这里算,不放前端:前端算会跟随浏览器时区,店员在不同机器看到不同的"逾期"。
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
  if (!(await requireVisible(req, res, "medical", storeCode))) return;

  const q = clean(req.query?.q, 40);
  const status = clean(req.query?.status, 20);
  const pageSize = Math.min(Math.max(parseInt(req.query?.pageSize, 10) || 20, 1), 200);
  const page = Math.max(parseInt(req.query?.pageNumber, 10) || 1, 1);

  const where = ["f.store_code=$1"], args = [storeCode];
  if (q) { args.push(`%${q}%`); where.push(`(f.medical_no ILIKE $${args.length} OR f.owner_name ILIKE $${args.length} OR p.name ILIKE $${args.length})`); }
  if (status) { args.push(status); where.push(`f.status=$${args.length}`); }
  const W = where.join(" AND ");

  const pool = getPool();
  try {
    const total = Number((await pool.query(
      `SELECT count(*) n FROM clinic_followups f LEFT JOIN pet_profiles p ON p.id=f.pet_id WHERE ${W}`, args)).rows[0].n);
    args.push(pageSize, (page - 1) * pageSize);
    const r = await pool.query(
      `SELECT f.medical_no, f.owner_name, p.name AS pet_name, p.avatar_url, p.breed,
              f.planned_at, f.done_at, f.status, f.operator, f.note,
              -- 逾期天数:只对「待回访」算;已回访/无需回访给 NULL,⛔别给 0(0 会被当成"今天到期")
              CASE WHEN f.status='待回访' AND f.planned_at IS NOT NULL
                   THEN (CURRENT_DATE - f.planned_at) END AS overdue_days
         FROM clinic_followups f LEFT JOIN pet_profiles p ON p.id=f.pet_id
        WHERE ${W}
        ORDER BY (f.status='待回访') DESC, f.planned_at NULLS LAST
        LIMIT $${args.length - 1} OFFSET $${args.length}`, args);

    const rows = r.rows.map((x) => {
      const d = x.overdue_days;
      return { ...x,
        due_state: x.status !== "待回访" ? x.status
                 : d == null ? "未排期" : d > 0 ? `逾期${d}天` : d === 0 ? "今天到期" : `还有${-d}天` };
    });
    return res.status(200).json({ rows, total, pageNumber: page, pageSize });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
