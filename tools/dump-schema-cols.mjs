// 输出 5 张核心表的 table.column 清单（schema-drift-check 用）
import { getPool } from "/opt/sanlyn-api-test/api/db.js";
const TABLES = ["orders","products","order_line_items","shipping_plans","container_bookings"];
const r = await getPool().query(
  `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
   WHERE table_schema='public' AND table_name = ANY($1) ORDER BY 1`, [TABLES]);
r.rows.forEach(x => console.log(x.c));
process.exit(0);
