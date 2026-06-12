/**
 * api/internal/auth-check.js — 内部服务 token 探测(不查DB,只验token)
 * GET/POST /api/internal/auth-check  → { ok, sub, role, aud }
 * 用途:执行器验证它签的服务 token 能不能过(不瞎猜 secret)。2026-06-06
 */
import { setCors } from "../db.js";
import { verifyToken } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const p = verifyToken(auth);
  if (!p) return res.status(401).json({ ok: false, error: "token 验不过(secret/格式不匹配)" });
  return res.status(200).json({ ok: true, sub: p.sub || null, role: p.role || null, aud: p.aud || null });
}
