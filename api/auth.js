// ══════════════════════════════════════════════════════════
// auth.js — API Key 鉴权中间件
// 验证 Authorization: Bearer sk_xxx
// 通过后在 req 上挂载 tenant_id 和 apiKeyInfo
// ══════════════════════════════════════════════════════════
import { getPool } from "./db.js";

// 不需要鉴权的路径（登录、健康检查）
const PUBLIC_PATHS = [
  "/",
  "/health",
  "/api/db/accounts",   // 登录接口
];

// 是否跳过鉴权
function isPublicPath(path, method) {
  // OPTIONS 预检请求永远放行
  if (method === "OPTIONS") return true;

  // 精确匹配公开路径
  if (PUBLIC_PATHS.includes(path)) return true;

  return false;
}

// API Key 缓存（避免每次请求都查数据库）
// key -> { tenant_id, permissions, key_name, cached_at }
const keyCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

async function lookupApiKey(apiKey) {
  // 先查缓存
  const cached = keyCache.get(apiKey);
  if (cached && Date.now() - cached.cached_at < CACHE_TTL) {
    return cached;
  }

  // 查数据库
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, tenant_id, key_name, permissions, is_active, expires_at
     FROM api_keys
     WHERE api_key = $1 AND is_active = true
     LIMIT 1`,
    [apiKey]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];

  // 检查是否过期
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return null;
  }

  const info = {
    id: row.id,
    tenant_id: row.tenant_id,
    key_name: row.key_name,
    permissions: row.permissions,
    cached_at: Date.now(),
  };

  // 写入缓存
  keyCache.set(apiKey, info);

  // 异步更新 last_used_at（不阻塞请求）
  pool.query(
    "UPDATE api_keys SET last_used_at = NOW() WHERE id = $1",
    [row.id]
  ).catch(() => {});

  return info;
}

/**
 * Express 中间件：验证 API Key
 * 用法：app.use(authMiddleware);
 */
export async function authMiddleware(req, res, next) {
  // 公开路径直接放行
  if (isPublicPath(req.path, req.method)) {
    return next();
  }

  // 读取 Authorization header
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Missing or invalid Authorization header",
      hint: "Use: Authorization: Bearer sk_xxx",
    });
  }

  const apiKey = authHeader.slice(7); // 去掉 "Bearer " 前缀

  if (!apiKey || apiKey.length < 10) {
    return res.status(401).json({
      success: false,
      error: "Invalid API key format",
    });
  }

  try {
    const keyInfo = await lookupApiKey(apiKey);

    if (!keyInfo) {
      return res.status(403).json({
        success: false,
        error: "Invalid or expired API key",
      });
    }

    // 挂载到 req 上，后续路由可以使用
    req.tenantId = keyInfo.tenant_id;
    req.apiKeyName = keyInfo.key_name;
    req.apiPermissions = keyInfo.permissions;

    next();
  } catch (err) {
    console.error("[auth] Error validating API key:", err.message);
    return res.status(500).json({
      success: false,
      error: "Auth service error",
    });
  }
}

/**
 * 权限检查中间件工厂
 * 用法：app.use("/api/db/orders", requirePermission("read"));
 */
export function requirePermission(permission) {
  return (req, res, next) => {
    // 如果没有经过 auth（公开路径），直接放行
    if (!req.apiPermissions) return next();

    const perms = Array.isArray(req.apiPermissions)
      ? req.apiPermissions
      : [];

    if (perms.includes("admin") || perms.includes(permission)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: `Insufficient permissions. Required: ${permission}`,
    });
  };
}

export default authMiddleware;
