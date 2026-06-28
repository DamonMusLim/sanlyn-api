/**
 * api/portal/middleware.js — Portal Token 验证 + 权限加载
 * 文档日期：2026-04-13
 *
 * Token 格式（Phase 2 极简版）：
 *   base64url( portal_user_id : unix_timestamp_sec : hmac_sha256 )
 *   HMAC 计算：HMAC-SHA256(portal_user_id:unix_timestamp_sec, PORTAL_JWT_SECRET)
 *   TTL：8 小时
 *
 * 零外部依赖，使用 Node.js 内置 crypto 模块。
 * Phase 3 升级为标准 JWT（jsonwebtoken）并接入登录接口。
 *
 * 使用方式（路由 handler 内）：
 *   const permissions = await parsePortalAuth(req, res, pool);
 *   if (!permissions) return; // 已响应 401/403
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { loadUserPermissions, PortalAuthError } from './auth-check.js';

// 独立于内部 JWT secret，必须在生产环境通过 env 覆盖
const PORTAL_SECRET = process.env.PORTAL_JWT_SECRET;
if (!PORTAL_SECRET) {
  // Fail loudly at module load time — never fall back to a known dev string in production.
  // In dev, set PORTAL_JWT_SECRET=any-local-dev-string in your .env file.
  throw new Error("PORTAL_JWT_SECRET environment variable is required but not set");
}

// Token 有效期：8 小时（秒）
const TOKEN_TTL = 8 * 3600;

// ──────────────────────────────────────────────────────────────
// Token 生成（测试 / Phase 3 登录接口使用）
// ──────────────────────────────────────────────────────────────

/**
 * createPortalToken
 * 为指定 portal_user_id 生成 Phase 2 Token。
 *
 * @param {string} userId - portal_users.id (UUID)
 * @returns {string} base64url 编码的 token
 */
export function createPortalToken(userId) {
  const ts  = Math.floor(Date.now() / 1000);
  const data = `${userId}:${ts}`;
  const mac  = createHmac('sha256', PORTAL_SECRET).update(data).digest('hex');
  return Buffer.from(`${data}:${mac}`).toString('base64url');
}

// ──────────────────────────────────────────────────────────────
// Token 验证（内部）
// ──────────────────────────────────────────────────────────────

/**
 * verifyPortalToken
 * 解码并验证 token，返回 portal_user_id 或 null。
 * 导出供 portalGate 中间件复用（避免重复实现）。
 *
 * @param {string} token
 * @returns {{ userId: string }|null}
 */
export function verifyPortalToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');

    // 格式：<uuid>:<ts>:<mac>
    // UUID 含 4 个 '-'，ts 和 mac 各含 1 个 ':' 分隔符
    // 从右起找最后两个 ':' 分隔
    const lastColon   = decoded.lastIndexOf(':');
    if (lastColon < 0) return null;
    const secondColon = decoded.lastIndexOf(':', lastColon - 1);
    if (secondColon < 0) return null;

    const userId   = decoded.slice(0, secondColon);
    const tsStr    = decoded.slice(secondColon + 1, lastColon);
    const givenMac = decoded.slice(lastColon + 1);

    if (!userId || !tsStr || !givenMac) return null;

    // 时效校验
    const ts  = parseInt(tsStr, 10);
    const now = Math.floor(Date.now() / 1000);
    if (isNaN(ts) || now - ts > TOKEN_TTL) return null;

    // HMAC 校验（timing-safe）
    const expectedMac = createHmac('sha256', PORTAL_SECRET)
      .update(`${userId}:${tsStr}`)
      .digest('hex');

    const givenBuf    = Buffer.from(givenMac,    'hex');
    const expectedBuf = Buffer.from(expectedMac, 'hex');
    if (givenBuf.length !== expectedBuf.length) return null;
    if (!timingSafeEqual(givenBuf, expectedBuf)) return null;

    return { userId };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// 主入口：parsePortalAuth
// ──────────────────────────────────────────────────────────────

/**
 * parsePortalAuth
 * 在每个 portal 路由 handler 开头调用。
 * 验证 Token → 加载权限 → 返回 PermissionsContext。
 * 失败时已发送 HTTP 响应，调用方只需 `if (!perms) return;`。
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('pg').Pool}          pool
 * @returns {Promise<import('./auth-check.js').PermissionsContext|null>}
 */
export async function parsePortalAuth(req, res, pool) {
  // 短路：portalGate 已完成验证并加载权限上下文，直接复用，避免重复 DB 查询
  if (req.portalPermissions) return req.portalPermissions;

  // ── 1. 提取 Token ──
  const authHeader = (req.headers['authorization'] || '').trim();
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    res.status(401).json({ error: 'Portal auth token required', code: 'NO_TOKEN' });
    return null;
  }

  // ── 2. 验证 Token ──
  const verified = verifyPortalToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Invalid or expired portal token', code: 'INVALID_TOKEN' });
    return null;
  }

  // ── 3. 加载用户权限上下文 ──
  try {
    const permissions = await loadUserPermissions(verified.userId, pool);
    return permissions;
  } catch (err) {
    if (err instanceof PortalAuthError) {
      const status = err.code === 'NOT_FOUND' ? 401 : 403;
      res.status(status).json({ error: err.message, code: err.code });
    } else {
      console.error('[portal/middleware] permission load error:', err);
      res.status(500).json({ error: 'Internal permission error', code: 'INTERNAL' });
    }
    return null;
  }
}
