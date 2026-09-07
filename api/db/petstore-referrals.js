// 转诊管理。病历号串起诊疗全链。
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
  const pageSize = Math.min(Math.max(parseInt(req.query?.pageSize, 10) || 20, 1), 200);
  const page = Math.max(parseInt(req.query?.pageNumber, 10) || 1, 1);
  try {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT count(*) OVER() AS __total, id, medical_no, owner_name,
        CASE direction WHEN 'out' THEN '转出' ELSE '转入' END AS direction_cn,
        partner_name, reason, status, referred_at, operator, note
   FROM clinic_referrals WHERE store_code = $1
  ORDER BY referred_at DESC NULLS LAST, id DESC LIMIT $2 OFFSET $3`, [storeCode, pageSize, (page - 1) * pageSize]);
    const total = rows.length ? Number(rows[0].__total || rows.length) : 0;
    return res.status(200).json({ rows: rows.map(({ __total, ...r }) => r), total, pageNumber: page, pageSize });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
