// 金枋店 · 每日店员待办（数据由 Studio 每日 push 进 petstore_daily_todo）
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function clean(v) { return String(v ?? "").trim(); }

export async function loadPetstoreTodo(pool, q = {}) {
  const date = clean(q.date);
  const type = clean(q.type);
  const shelf = clean(q.shelf);
  const args = [];
  const where = [];
  if (date) { args.push(date); where.push(`snapshot_date = $${args.length}::date`); }
  else { where.push(`snapshot_date = (SELECT max(snapshot_date) FROM petstore_daily_todo)`); }
  if (type) { args.push(type); where.push(`todo_type = $${args.length}`); }
  if (shelf) { args.push(shelf + "%"); where.push(`COALESCE(shelf,'') LIKE $${args.length}`); }
  // 分渠道价:商品接口不返回,取改价日志里每个渠道最近一次的价
  // (Damon 0812:「美团,饿了么价格补上,这样搜就比较容易了」)
  const sql = `
    WITH ch AS (
      SELECT DISTINCT ON (product_code, channel) product_code, channel, new_price
        FROM petstore_pricing_log
       WHERE channel IN ('美团','饿了么','京东到家') AND new_price > 0.01
       ORDER BY product_code, channel, ts DESC
    ), chp AS (
      SELECT product_code,
             max(new_price) FILTER (WHERE channel='美团')     AS mt_price,
             max(new_price) FILTER (WHERE channel='饿了么')   AS eb_price,
             max(new_price) FILTER (WHERE channel='京东到家') AS jd_price
        FROM ch GROUP BY product_code
    )
    SELECT t.todo_type, t.shelf, t.product_name, t.spec, t.warn_status,
           t.production_date, t.expire_date, t.stock, t.out_price, t.month_sale,
           c.mt_price, c.eb_price, c.jd_price,
           t.product_code, t.barcode, t.category, t.supplier,
           t.snapshot_date::text AS snapshot_date, t.done_at, t.done_by
      FROM petstore_daily_todo t
      LEFT JOIN chp c ON c.product_code = t.product_code
     WHERE ${where.join(" AND ").replace(/\b(snapshot_date|todo_type|shelf)\b/g, "t.$1")}
     ORDER BY CASE t.todo_type WHEN '已过期' THEN 0 WHEN '无货位' THEN 1
                             WHEN '快过期' THEN 2 ELSE 3 END,
              CASE WHEN COALESCE(t.shelf,'') ~ '^[0-9]+-[0-9]+' THEN split_part(t.shelf,'-',1)::int ELSE 9999 END,
              CASE WHEN COALESCE(t.shelf,'') ~ '^[0-9]+-[0-9]+' THEN split_part(split_part(t.shelf,'-',2),',',1)::int ELSE 0 END,
              t.product_name`;
  const r = await pool.query(sql, args);
  return r.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    const rows = await loadPetstoreTodo(pool, req.query);
    const s = await pool.query(
      `SELECT todo_type, count(*)::int AS n FROM petstore_daily_todo
        WHERE snapshot_date = COALESCE($1::date,(SELECT max(snapshot_date) FROM petstore_daily_todo))
        GROUP BY 1`, [clean(req.query.date) || null]);
    res.status(200).json({ success: true, data: rows, count: rows.length, summary: s.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
