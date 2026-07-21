// /api/db/petstore-pricing-log.mjs — 金枋宠物店 AI 改价日志（只读·每商品每天压缩成一条）
// 数据每日同步自 mini discount_log.jsonl -> tencent PG petstore_pricing_log；
// 本路由读压缩视图 petstore_pricing_daily（product+day 一条 + 清洗打折原因 + 各渠道结果）。
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
    const { q, reason, limit = 1000, offset = 0 } = req.query;
    const params = [];
    const conds = [];
    if (reason) { params.push(reason); conds.push(`reason = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      conds.push(`(product_name ILIKE $${i} OR product_code ILIKE $${i} OR reason ILIKE $${i})`);
    }
    let sql = "SELECT product_code, log_date, ts, product_name, store_name, old_price, new_price, "
            + "rate, reason, days_left, channel_results, ok_cnt, fail_cnt, skip_cnt, chan_cnt "
            + "FROM petstore_pricing_daily";
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    params.push(Math.min(parseInt(limit) || 1000, 5000));
    sql += ` ORDER BY ts DESC LIMIT $${params.length}`;
    params.push(parseInt(offset) || 0);
    sql += ` OFFSET $${params.length}`;

    const rows = await pool.query(sql, params);

    const countParams = params.slice(0, params.length - 2);
    let countSql = "SELECT COUNT(*) AS total FROM petstore_pricing_daily";
    if (conds.length) countSql += " WHERE " + conds.join(" AND ");
    const countRes = await pool.query(countSql, countParams);

    return res.status(200).json({
      success: true,
      data: rows.rows,
      count: parseInt(countRes.rows[0].total),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
