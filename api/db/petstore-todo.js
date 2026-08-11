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
  const sql = `
    SELECT todo_type, shelf, product_name, spec, warn_status,
           production_date, expire_date, stock, out_price, month_sale,
           product_code, barcode, category, supplier,
           snapshot_date::text AS snapshot_date, done_at, done_by
      FROM petstore_daily_todo
     WHERE ${where.join(" AND ")}
     ORDER BY CASE todo_type WHEN '已过期' THEN 0 WHEN '无货位' THEN 1
                             WHEN '快过期' THEN 2 ELSE 3 END,
              CASE WHEN COALESCE(shelf,'') ~ '^[0-9]+-[0-9]+' THEN split_part(shelf,'-',1)::int ELSE 9999 END,
              CASE WHEN COALESCE(shelf,'') ~ '^[0-9]+-[0-9]+' THEN split_part(split_part(shelf,'-',2),',',1)::int ELSE 0 END,
              product_name`;
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
