// Studio 每日 push 待办行 → petstore_daily_todo（幂等 upsert，同日重跑覆盖）
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const FIELDS = ["todo_type","shelf","product_name","spec","warn_status","production_date",
                "expire_date","stock","out_price","month_sale","product_code","barcode",
                "category","supplier"];

const DDL = `
CREATE TABLE IF NOT EXISTS petstore_daily_todo (
  id BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  todo_type TEXT NOT NULL,
  shelf TEXT, product_name TEXT, spec TEXT, warn_status TEXT,
  production_date TEXT, expire_date TEXT,
  stock NUMERIC, out_price NUMERIC, month_sale NUMERIC,
  product_code TEXT NOT NULL, barcode TEXT, category TEXT, supplier TEXT,
  done_at TIMESTAMPTZ, done_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_petstore_daily_todo
  ON petstore_daily_todo(snapshot_date, product_code, todo_type);
CREATE INDEX IF NOT EXISTS ix_petstore_daily_todo_date
  ON petstore_daily_todo(snapshot_date DESC);`;

// 幂等建表:只 CREATE IF NOT EXISTS,不改不删任何已有对象
async function ensureTable(pool) { await pool.query(DDL); }

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST required" });
  if (!requireAuth(req, res)) return;
  const body = req.body || {};
  const date = String(body.snapshot_date || "").trim();
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: "snapshot_date 必须 YYYY-MM-DD" });
  if (!rows.length) return res.status(400).json({ success: false, error: "rows 为空" });
  const pool = getPool();
  await ensureTable(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM petstore_daily_todo WHERE snapshot_date=$1::date AND done_at IS NULL", [date]);
    let n = 0;
    for (const r of rows) {
      if (!r || !r.product_code || !r.todo_type) continue;
      const vals = [date, ...FIELDS.map(f => (r[f] === undefined || r[f] === "" ? null : r[f]))];
      const ph = vals.map((_, i) => `$${i + 1}`).join(",");
      await client.query(
        `INSERT INTO petstore_daily_todo (snapshot_date, ${FIELDS.join(",")}) VALUES (${ph})
         ON CONFLICT (snapshot_date, product_code, todo_type) DO UPDATE SET
           shelf=EXCLUDED.shelf, product_name=EXCLUDED.product_name, spec=EXCLUDED.spec,
           warn_status=EXCLUDED.warn_status, production_date=EXCLUDED.production_date,
           expire_date=EXCLUDED.expire_date, stock=EXCLUDED.stock, out_price=EXCLUDED.out_price,
           month_sale=EXCLUDED.month_sale, barcode=EXCLUDED.barcode, category=EXCLUDED.category,
           supplier=EXCLUDED.supplier`, vals);
      n++;
    }
    await client.query("COMMIT");
    res.status(200).json({ success: true, inserted: n, snapshot_date: date });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
}
