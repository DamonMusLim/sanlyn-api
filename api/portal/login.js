/**
 * api/portal/login.js — Portal 登录接口
 * 文档日期：2026-04-13
 *
 * POST /api/portal/login
 *
 * Body: { username: string, password: string }
 *
 * 成功响应：
 *   {
 *     success: true,
 *     token:   "base64url...",
 *     user:    { id, username, display_name, user_type, company_name, company_type },
 *     modules: string[],   // 该用户可访问的门户模块
 *     roles:   string[],   // 角色列表（供前端菜单渲染）
 *   }
 *
 * 密码校验：bcrypt（兼容明文自动升级，与 /api/db/auth-login 保持一致）
 * Token 生成：调用 middleware.js createPortalToken（HMAC-SHA256，8h TTL）
 * 模块计算：loadUserPermissions + canAccessModule 遍历已知模块
 */

import bcrypt          from 'bcryptjs';
import { getPool, setCors } from '../db.js';
import { createPortalToken } from './middleware.js';
import { loadUserPermissions, canAccessModule } from './auth-check.js';

// Portal 目前暴露的所有可查询模块
const PORTAL_MODULES = [
  'shipping_plans',
  'customs_data',
  'truck_quotes',
  'ocean_freight',
  'port_charges',
  'customs_broker_quotes',
];

// ── 密码校验（bcrypt + 明文自动升级）────────────────────────────
async function verifyPassword(pool, userId, inputPlain, storedValue) {
  if (!storedValue) return false;

  // bcrypt hash 已升级
  if (storedValue.startsWith('$2b$') || storedValue.startsWith('$2a$')) {
    return bcrypt.compare(inputPlain, storedValue);
  }

  // 明文比对（旧数据）→ 自动升级到 bcrypt
  if (inputPlain !== storedValue) return false;
  const hash = await bcrypt.hash(inputPlain, 12);
  await pool.query(
    'UPDATE portal_users SET password_hash = $1 WHERE id = $2',
    [hash, userId]
  );
  return true;
}

// ── Handler ──────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required', code: 'MISSING_PARAMS' });
  }

  const pool = getPool();

  // ── 1. 查询用户（JOIN 公司）──
  let userRow;
  try {
    const result = await pool.query(
      `SELECT
         u.id,
         u.username,
         u.display_name,
         u.password_hash,
         u.status           AS user_status,
         u.user_type,
         u.company_id,
         c.company_code,
         c.company_name,
         c.company_type,
         c.status           AS company_status
       FROM portal_users u
       JOIN portal_companies c ON c.id = u.company_id
       WHERE u.username = $1`,
      [username.trim()]
    );
    if (result.rows.length === 0) {
      // 不透露是否用户名存在
      return res.status(401).json({ error: '用户名或密码错误', code: 'INVALID_CREDENTIALS' });
    }
    userRow = result.rows[0];
  } catch (err) {
    console.error('[portal/login] db query error:', err.message);
    return res.status(500).json({ error: 'Internal error', code: 'DB_ERROR' });
  }

  // ── 2. 状态检查 ──
  if (userRow.user_status !== 'active') {
    return res.status(403).json({
      error: '账户未激活或已停用，请联系管理员',
      code: 'SUSPENDED',
    });
  }
  if (userRow.company_status !== 'active') {
    return res.status(403).json({
      error: '企业账户未激活，请联系管理员',
      code: 'SUSPENDED',
    });
  }

  // ── 3. 密码校验 ──
  let passwordOk;
  try {
    passwordOk = await verifyPassword(pool, userRow.id, password, userRow.password_hash);
  } catch (err) {
    console.error('[portal/login] bcrypt error:', err.message);
    return res.status(500).json({ error: 'Internal error', code: 'AUTH_ERROR' });
  }

  if (!passwordOk) {
    return res.status(401).json({ error: '用户名或密码错误', code: 'INVALID_CREDENTIALS' });
  }

  // ── 4. 生成 Token ──
  const token = createPortalToken(userRow.id);

  // ── 5. 加载权限，计算可访问模块 ──
  let permissions;
  try {
    permissions = await loadUserPermissions(userRow.id, pool);
  } catch (err) {
    console.error('[portal/login] permission load error:', err.message);
    return res.status(500).json({ error: 'Permission load failed', code: 'INTERNAL' });
  }

  const modules = PORTAL_MODULES.filter(m => canAccessModule(permissions, m));

  return res.json({
    success: true,
    token,
    user: {
      id:           userRow.id,
      username:     userRow.username,
      display_name: userRow.display_name || userRow.username,
      user_type:    userRow.user_type,
      company_name: userRow.company_name,
      company_type: userRow.company_type,
    },
    modules,
    roles: permissions.roles,
  });
}
