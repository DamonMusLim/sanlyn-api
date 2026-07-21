// /api/db/petstore-pricing-log.mjs — 金枋宠物店 AI 改价日志（只读镜像）
// 数据每日同步自 mini discount_log.jsonl -> tencent PG petstore_pricing_log。
// 只读：仅 GET。改价走 brain-pricing 链路，admin 不可写。
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "只读表，仅支持 GET" });
  }

  const pool = getPool();
  try {
    const { channel, result, q, limit = 1000, offset = 0 } = req.query;
    const params = [];
    const conds = [];
    if (channel) { params.push(channel); conds.push(`channel = $${params.length}`); }
    if (result)  { params.push(result);  conds.push(`result = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      conds.push(`(product_name ILIKE $${i} OR product_code ILIKE $${i} OR reason ILIKE $${i})`);
    }
    let sql = "SELECT id, ts, log_date, store_code, store_name, channel, product_code, product_name, "
            + "old_price, new_price, rate, reason, result, days_left, tier, synced_at "
            + "FROM petstore_pricing_log";
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    params.push(Math.min(parseInt(limit) || 1000, 5000));
    sql += ` ORDER BY ts DESC LIMIT $${params.length}`;
    params.push(parseInt(offset) || 0);
    sql += ` OFFSET $${params.length}`;

    const result_rows = await pool.query(sql, params);

    // total count (respecting filters, not limit)
    const countParams = params.slice(0, params.length - 2);
    let countSql = "SELECT COUNT(*) AS total FROM petstore_pricing_log";
    if (conds.length) countSql += " WHERE " + conds.join(" AND ");
    const countRes = await pool.query(countSql, countParams);

    return res.status(200).json({
      success: true,
      data: result_rows.rows,
      count: parseInt(countRes.rows[0].total),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
