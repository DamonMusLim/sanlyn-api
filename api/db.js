import pkg from "pg";
const { Pool } = pkg;
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
export const ALLOWED = ["https://sanlyn-os.vercel.app","https://ai.sanlynos.com","http://localhost:5173","http://localhost:3000"];
export function setCors(req, res, methods = "GET, POST, OPTIONS") {
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
