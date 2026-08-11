import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 对账页公司下拉: 有海运票或订单的客户
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const r = await getPool().query(`
      SELECT code, name, cnt FROM (
        SELECT o.company_code AS code,
               MAX(COALESCE(c.name_en, c.name_cn, o.company_code)) AS name,
               COUNT(*) AS cnt
          FROM orders o
          LEFT JOIN companies c ON c.code = o.company_code AND c.code NOT LIKE 'DEPRECATED%'
         WHERE o.deleted_at IS NULL AND NULLIF(o.company_code,'') IS NOT NULL
         GROUP BY o.company_code
        UNION ALL
        SELECT sp.company_code, MAX(NULLIF(BTRIM(sp.customer),'')), COUNT(*)
          FROM shipping_plans sp
         WHERE sp.deleted_at IS NULL AND NULLIF(sp.company_code,'') IS NOT NULL
         GROUP BY sp.company_code
      ) x
      GROUP BY code, name, cnt`);
    const seen = {};
    r.rows.forEach(x => { seen[x.code] = seen[x.code] || { code: x.code, name: x.name, cnt: 0 }; seen[x.code].cnt += Number(x.cnt); });
    const list = Object.values(seen).sort((a, b) => b.cnt - a.cnt);
    res.status(200).json({ success: true, data: list });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
