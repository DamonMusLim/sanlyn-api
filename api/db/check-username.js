// /api/db/check-username.js — 注册页查重专用公开端点
//
// GET /api/db/check-username?username=xxx@yyy.com
//   返回：{ exists: true|false }
//
// 为什么要单独做：
//   - 注册时用户还没登录，没法用 apiFetch 带 JWT
//   - 但不能把整个 /api/db/accounts 放公开（上次就是这样被撸的）
//   - 所以做个"只能回 exists: bool"的窄口，不返回任何其他信息
//
// 限流：注册页每 IP 10 次/分钟（防刷用户名枚举）
//
// 注：这个端点要加进 auth.js 的 PUBLIC_PATHS。
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const username = (req.query?.username || "").trim().toLowerCase();
  if (!username) return res.status(400).json({ error: "username required" });
  if (username.length > 100) return res.status(400).json({ error: "username too long" });

  try {
    const pool = getPool();
    // 仅 COUNT(*)，不返回任何其他字段。1 行 or 0 行。
    const r = await pool.query(
      "SELECT 1 FROM accounts WHERE LOWER(username) = $1 LIMIT 1",
      [username]
    );
    return res.status(200).json({ exists: r.rowCount > 0 });
  } catch (err) {
    console.error("[check-username]", err);
    // 对外用 generic 错误，不要泄露 DB 状态
    return res.status(500).json({ error: "Internal error" });
  }
}
