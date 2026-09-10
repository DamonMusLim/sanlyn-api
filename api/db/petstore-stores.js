// 门店主表读取。给 jdc 后台的门店切换器用。
// ⛔ 刻意不过 requireVisible —— 切换器自己要用的清单如果被模块闸拦住,
//    会出现「切到没开通某模块的店 → 门店列表都拉不到 → 再也切不回来」的死锁。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT code, short_code, name, address, phone, subtitle, badge, hours,
        is_24h, lat::float8 AS lat, lng::float8 AS lng, camera_notice, express_days, gdc_store_code,
        online_shop, is_active, sort_order,
        (gdc_store_code IS NOT NULL) AS data_ready,
        CASE
          WHEN gdc_store_code IS NULL THEN '未接数据'
          WHEN online_shop = false THEN '仅后台'
          ELSE '正常'
        END AS status_cn
   FROM petstore_stores
  WHERE is_active = $1
  ORDER BY sort_order, code`, [true]);
    return res.status(200).json({ rows, total: rows.length });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
