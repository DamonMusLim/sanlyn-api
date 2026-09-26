// api/db/auth-admin-check.js — nginx auth_request 用的「只许管理员」探针（0926 Damon：补货池只允许管理员）
// GET → 200 = 放行；401 = 没登录/令牌无效；403 = 登录了但不是管理员。
// 放行：role=admin，或账号 id 在 INTERNAL_UIDS（91 = damon 本人，角色是 petstore；Damon 0926 定）。
// ⛔ 身份只认已验签 JWT 里的 role/uid，不读 query/body/header 里的任何自报字段。
import { requireAuth } from "../auth.js";

const INTERNAL_UIDS = [91];

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
  if (!requireAuth(req, res)) return;   // 401
  const role = String(req.user?.role || "").toLowerCase();
  if (role === "admin" || INTERNAL_UIDS.includes(Number(req.user?.uid))) return res.status(200).json({ ok: true });
  return res.status(403).json({ error: "Forbidden", message: "仅限管理员" });
}
