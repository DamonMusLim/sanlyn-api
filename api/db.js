import pkg from "pg";
const { Pool, types } = pkg;
// 🩸 0813 UTC 位移坑:postgres 的 DATE(oid 1082) 默认被 node-postgres 解析成「服务器本地零点的 Date」,
//    JSON 化后变成 UTC ISO 串 —— CST(+8) 下 2026-02-14 会变成 "2026-02-13T16:00:00.000Z",
//    前端 String(x).slice(0,10) 拿到的是 02-13,**整列日期少一天**(etd/eta/delivery_date/交期全中招)。
//    DATE 本来就没有时区,原样返回 'YYYY-MM-DD' 字符串才是对的。
types.setTypeParser(1082, v => v);
let pool;
export function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PG_HOST,
      port: parseInt(process.env.PG_PORT || "5432"),
      database: process.env.PG_DATABASE,
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      ssl: false,
      max: 3,
    });
  }
  return pool;
}
export const ALLOWED = ["https://damon.sanlyn.cn","https://admin.sanlyn.cn","https://sanlyn-os.vercel.app","https://ai.sanlynos.com","https://ai.sanlyn.cn","https://ac.sanlyn.cn","http://localhost:5173","http://localhost:5183","http://localhost:3000"];
export function setCors(req, res, methods = "GET, POST, OPTIONS") {
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
