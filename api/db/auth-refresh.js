// /api/db/auth-refresh.js — JWT 无感续期
// POST /api/db/auth-refresh  (Authorization: Bearer <token> 或 ?token=<token>)
// 返回新 token (7天有效期从当前时间起算)
import { verifyToken, generateToken } from "../auth.js";
import { setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  var auth = req.headers.authorization || "";
  var token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query?.token || "");
  var payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "invalid_token", message: "Token 已过期或无效，请重新登录" });

  // 用同一份用户信息签发新 token
  var { iat, exp, ...userFields } = payload;
  var newToken = generateToken(userFields);
  return res.json({ token: newToken, user: userFields });
}
