// /api/db/petstore-health.mjs — 金枋宠物店 数据体检（只读）
// 读视图 petstore_health：亏本卖/快过期/无有效售价/渠道差价大/无生产日期。
// 数据源 petstore_skus + petstore_sku_supp（每日同步自 mini）+ petstore_pricing_log。
// 只读：仅 GET。
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "只读表，仅支持 GET" });
  }

  const pool = getPool();
  try {
    const { q, problem, limit = 1000, offset = 0 } = req.query;
    const params = [];
    const conds = [];
    if (problem) { params.push(problem); conds.push(`main_problem = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      conds.push(`(product_name ILIKE $${i} OR product_code ILIKE $${i} OR category ILIKE $${i})`);
    }
    let sql = "SELECT product_code, product_name, category, shelf_list, cost_price, out_price, "
            + "ext_price, ext_channel, stock_num, month_sale, expire_date_batch, days_to_expire, "
            + "loss_amount, main_problem, problems, severity, is_loss, no_price, is_expiring, no_date, price_gap "
            + "FROM petstore_health";
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    params.push(Math.min(parseInt(limit) || 1000, 5000));
    sql += ` ORDER BY severity DESC, loss_amount DESC NULLS LAST, product_code LIMIT $${params.length}`;
    params.push(parseInt(offset) || 0);
    sql += ` OFFSET $${params.length}`;

    const rows = await pool.query(sql, params);

    const countParams = params.slice(0, params.length - 2);
    let countSql = "SELECT COUNT(*) AS total, "
      + "count(*) FILTER (WHERE is_loss) AS loss, "
      + "count(*) FILTER (WHERE is_expiring) AS expiring, "
      + "count(*) FILTER (WHERE price_gap) AS gap, "
      + "count(*) FILTER (WHERE no_price) AS noprice, "
      + "count(*) FILTER (WHERE no_date) AS nodate FROM petstore_health";
    if (conds.length) countSql += " WHERE " + conds.join(" AND ");
    const c = await pool.query(countSql, countParams);

    return res.status(200).json({
      success: true,
      data: rows.rows,
      count: parseInt(c.rows[0].total),
      stats: c.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
