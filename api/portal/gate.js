/**
 * api/portal/gate.js — Portal 路由组级鉴权网关
 * 文档日期：2026-04-13
 *
 * 职责：为 /api/portal/* 路由（除 /login）提供路由组级 token 验证，
 * 作为 defense-in-depth 第一道防线。通过后将权限上下文注入 req.portalPermissions，
 * 供下游 parsePortalAuth / 路由 handler 直接复用（避免重复 DB 查询）。
 *
 * 挂载方式（server.js）：
 *   import { portalGate } from "./api/portal/gate.js";
 *   app.use("/api/portal", portalGate);   // 在 authMiddleware 之后，路由 mount 之前
 *
 * 校验顺序：
 *   1. OPTIONS → next()
 *   2. req.path === "/login" → next()（登录接口无需 token）
 *   3. 无 Authorization Bearer → 401 NO_TOKEN
 *   4. verifyPortalToken（HMAC-SHA256 + TTL）→ 401 INVALID_TOKEN
 *   5. loadUserPermissions（用户/公司 status 校验）→ 401 NOT_FOUND / 403 SUSPENDED
 *   6. user_type 合法性（仅 logistics / customer）→ 403 FORBIDDEN
 *   7. req.portalPermissions = permissions → next()
 */

import { verifyPortalToken }                 from './middleware.js';
import { loadUserPermissions, PortalAuthError } from './auth-check.js';
import { getPool }                            from '../db.js';

// login 路径不需要 token（在此前签发）
const PORTAL_PUBLIC_PATHS = new Set(["/login"]);
// /orders 允许内部 Admin JWT 直通(协同卡真实数据测试);也兼容 portal token
const PORTAL_INTERNAL_BYPASS_PATHS = new Set(["/orders"]);

// 仅允许 logistics 和 customer 访问 portal；internal 暂不开放
const ALLOWED_USER_TYPES  = new Set(["logistics", "customer", "admin"]);

/**
 * portalGate
 * Express 中间件，挂载于 /api/portal 路由组。
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {Function}                   next
 */
export async function portalGate(req, res, next) {
  // CORS preflight 由全局中间件处理
  if (req.method === "OPTIONS") return next();

  // 登录接口无需 token — 在此处生成 token，所以放行
  if (PORTAL_PUBLIC_PATHS.has(req.path)) return next();

  // /orders 路径:内部 Admin JWT 直通(协同卡真实数据,无需 portal token)
  const reqPathBase = "/" + (req.path || "").split("/").filter(Boolean)[0];
  if (PORTAL_INTERNAL_BYPASS_PATHS.has(reqPathBase)) {
    const ah = (req.headers["authorization"] || "").trim();
    if (ah.startsWith("Bearer ")) {
      try {
        const payload = JSON.parse(Buffer.from(ah.slice(7).split(".")[1], "base64").toString());
        if (payload.role === "admin" || payload.role === "logistics" || payload.role === "finance") {
          req.portalPermissions = { user_type: payload.role, company_codes: payload.company_codes || [] };
          return next();
        }
      } catch { /* fallthrough to portal token */ }
    }
  }

  // ── 1. Token 存在性检查 ──
  const authHeader = (req.headers["authorization"] || "").trim();
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    return res.status(401).json({
      error: "Portal auth token required",
      code:  "NO_TOKEN",
    });
  }

  // ── 2. HMAC 签名 + TTL 验证（Portal secret）──
  const verified = verifyPortalToken(token);
  if (!verified) {
    return res.status(401).json({
      error: "Invalid or expired portal token",
      code:  "INVALID_TOKEN",
    });
  }

  // ── 3. 用户权限加载（含 status / company status 校验）──
  const pool = getPool();
  let permissions;
  try {
    permissions = await loadUserPermissions(verified.userId, pool);
  } catch (err) {
    if (err instanceof PortalAuthError) {
      const status = err.code === "NOT_FOUND" ? 401 : 403;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    console.error("[portalGate] loadUserPermissions error:", err.message);
    return res.status(500).json({
      error: "Internal permission error",
      code:  "INTERNAL",
    });
  }

  // ── 4. user_type 合法性校验 ──
  const userType = permissions.user.user_type;
  if (!ALLOWED_USER_TYPES.has(userType)) {
    return res.status(403).json({
      error: `User type '${userType}' is not permitted in portal`,
      code:  "FORBIDDEN",
    });
  }

  // ── 5. 注入权限上下文，供下游 handler 直接复用 ──
  req.portalPermissions = permissions;
  next();
}
