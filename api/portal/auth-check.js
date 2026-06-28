/**
 * portal_auth_check.js — Portal 权限判定模块 Phase 1
 * 文档日期：2026-04-13
 *
 * 职责：
 *   - 从 DB 加载用户完整权限上下文（roles / scopes / divisions）
 *   - 判定模块访问权限（can / assert）
 *   - 计算可见 shipment_no 集合（物流/客户两路径统一出口）
 *   - 构造注入主链查询的 WHERE 过滤条件
 *
 * 本模块不含：HTTP 处理、JWT 签发、密码校验（Phase 2 范围）
 *
 * 使用方式（Phase 2 路由层）：
 *   import { loadUserPermissions, canAccessModule, buildShippingFilter } from './portal/auth-check.js';
 *   const perms = await loadUserPermissions(userId, pool);
 *   if (!canAccessModule(perms, 'shipping_plans')) return res.status(403).json({ error: 'forbidden' });
 *   const filter = await buildShippingFilter(perms, pool);
 */

// ──────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────

/**
 * 模块 → 所需角色映射
 * 物流用户：持有对应角色才可访问该模块
 */
const MODULE_ROLES = {
  shipping_plans:           ['logistics_ocean'],
  customs_data:             ['logistics_customs'],
  truck_quotes:             ['logistics_truck'],
  ocean_freight:            ['logistics_finance'],
  port_charges:             ['logistics_finance'],
  customs_broker_quotes:    ['logistics_finance'],
};

/**
 * 客户用户默认可访问的模块
 * （还受 company_id 和 division 限制数据行，不限制模块类型）
 */
const CUSTOMER_MODULES = new Set([
  'shipping_plans',
  'customs_data',
  'ocean_freight',
  'port_charges',
]);

// ──────────────────────────────────────────────────────────────
// 自定义错误
// ──────────────────────────────────────────────────────────────

export class PortalAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name  = 'PortalAuthError';
    this.code  = code || 'FORBIDDEN';  // 'FORBIDDEN' | 'NOT_FOUND' | 'SUSPENDED'
  }
}

// ──────────────────────────────────────────────────────────────
// DB 查询层
// ──────────────────────────────────────────────────────────────

/**
 * loadUserPermissions
 * 从 DB 加载用户完整权限上下文。
 *
 * @param {string} userId - portal_users.id (UUID)
 * @param {object} pool   - pg Pool 实例
 * @returns {Promise<PermissionsContext>}
 *
 * PermissionsContext = {
 *   user:      { id, username, display_name, user_type, status, company_id }
 *   company:   { id, company_code, company_name, company_type, status }
 *   roles:     string[]          // 有效角色 role_code 列表（revoked_at IS NULL）
 *   scopes:    ScopeEntry[]      // [ { scope_type, scope_value } ]
 *   divisions: string[]          // division_code 列表
 * }
 */
export async function loadUserPermissions(userId, pool) {
  // 1. 用户基本信息 + 所属公司（单次 JOIN）
  const userRes = await pool.query(
    `SELECT
       u.id, u.username, u.display_name, u.user_type, u.status, u.company_id,
       c.company_code, c.company_name, c.company_type, c.status AS company_status
     FROM portal_users u
     JOIN portal_companies c ON c.id = u.company_id
     WHERE u.id = $1`,
    [userId]
  );

  if (userRes.rows.length === 0) {
    throw new PortalAuthError(`Portal user not found: ${userId}`, 'NOT_FOUND');
  }

  const row = userRes.rows[0];

  if (row.status !== 'active') {
    throw new PortalAuthError(
      `Portal user account is ${row.status}: ${row.username}`,
      'SUSPENDED'
    );
  }
  if (row.company_status !== 'active') {
    throw new PortalAuthError(
      `Portal company is ${row.company_status}: ${row.company_code}`,
      'SUSPENDED'
    );
  }

  const user = {
    id:           row.id,
    username:     row.username,
    display_name: row.display_name,
    user_type:    row.user_type,
    status:       row.status,
    company_id:   row.company_id,
  };
  const company = {
    id:           row.company_id,
    company_code: row.company_code,
    company_name: row.company_name,
    company_type: row.company_type,
    status:       row.company_status,
  };

  // 2. 有效角色（并行查询）
  const [rolesRes, scopesRes, divsRes] = await Promise.all([
    pool.query(
      `SELECT role_code
       FROM portal_user_roles
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    ),
    pool.query(
      `SELECT scope_type, scope_value
       FROM portal_user_scopes
       WHERE user_id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT division_code
       FROM portal_user_divisions
       WHERE user_id = $1`,
      [userId]
    ),
  ]);

  return {
    user,
    company,
    roles:     rolesRes.rows.map(r => r.role_code),
    scopes:    scopesRes.rows.map(r => ({ scope_type: r.scope_type, scope_value: r.scope_value })),
    divisions: divsRes.rows.map(r => r.division_code),
  };
}

// ──────────────────────────────────────────────────────────────
// 纯函数：权限判定
// ──────────────────────────────────────────────────────────────

/**
 * canAccessModule
 * 判断用户是否可访问指定模块（不含数据行过滤）。
 *
 * @param {PermissionsContext} permissions
 * @param {string} module - 'shipping_plans' | 'customs_data' | 'truck_quotes' | ...
 * @returns {boolean}
 */
export function canAccessModule(permissions, module) {
  const { user_type } = permissions.user;
  const roles = new Set(permissions.roles);

  if (user_type === 'logistics') {
    const required = MODULE_ROLES[module];
    if (!required) return false;  // 未知模块，默认拒绝
    return required.some(r => roles.has(r));
  }

  if (user_type === 'customer') {
    // customer 角色（view / division / admin）均可访问 CUSTOMER_MODULES
    const hasCustomerRole = roles.has('customer_view')
      || roles.has('customer_division')
      || roles.has('customer_admin');
    return hasCustomerRole && CUSTOMER_MODULES.has(module);
  }

  // internal：Phase 1 保留模型，不实现逻辑，一律拒绝
  return false;
}

/**
 * assertModuleAccess
 * 权限不足时 throw PortalAuthError（供路由层直接使用）。
 *
 * @param {PermissionsContext} permissions
 * @param {string} module
 * @throws {PortalAuthError}
 */
export function assertModuleAccess(permissions, module) {
  if (!canAccessModule(permissions, module)) {
    throw new PortalAuthError(
      `User ${permissions.user.username} cannot access module: ${module}`,
      'FORBIDDEN'
    );
  }
}

// ──────────────────────────────────────────────────────────────
// DB 查询层：可见 shipment_no 集合
// ──────────────────────────────────────────────────────────────

/**
 * getVisibleShipmentNos
 * 计算当前用户可见的 shipment_no 集合。
 * 统一通过 portal_shipment_division_map 获取，不修改主链表。
 *
 * 物流用户（logistics）：
 *   partner_company scope → 可见这些公司的所有 shipment_no
 *
 * 客户管理员（customer_admin）：
 *   company_code → 可见该公司全部 shipment_no（不限 division）
 *
 * 客户 Division 用户（customer_division）：
 *   company_code + division_code → 仅可见对应 division 的 shipment_no
 *
 * 安全默认：
 *   - logistics 无 partner_company scope → 返回空 Set
 *   - customer_division 无 division → 返回空 Set
 *
 * @param {PermissionsContext} permissions
 * @param {object} pool
 * @returns {Promise<Set<string>>}
 */
export async function getVisibleShipmentNos(permissions, pool) {
  const { user_type } = permissions.user;
  const { company_code } = permissions.company;
  const roles = new Set(permissions.roles);

  // ── 物流用户路径 ──
  if (user_type === 'logistics') {
    const partnerCodes = permissions.scopes
      .filter(s => s.scope_type === 'partner_company')
      .map(s => s.scope_value);

    // 安全默认：无 partner_company scope → 空集
    if (partnerCodes.length === 0) return new Set();

    const res = await pool.query(
      `SELECT DISTINCT shipment_no
       FROM portal_shipment_division_map
       WHERE company_code = ANY($1::text[])`,
      [partnerCodes]
    );

    let shipmentNos = res.rows.map(r => r.shipment_no);

    // 叠加 shipment_prefix scope 过滤（AND 语义）
    const prefixes = permissions.scopes
      .filter(s => s.scope_type === 'shipment_prefix')
      .map(s => s.scope_value);
    if (prefixes.length > 0) {
      shipmentNos = shipmentNos.filter(sn =>
        prefixes.some(p => sn.startsWith(p))
      );
    }

    return new Set(shipmentNos);
  }

  // ── 客户管理员路径 ──
  if (user_type === 'customer' && roles.has('customer_admin')) {
    const res = await pool.query(
      `SELECT DISTINCT shipment_no
       FROM portal_shipment_division_map
       WHERE company_code = $1`,
      [company_code]
    );
    return new Set(res.rows.map(r => r.shipment_no));
  }

  // ── 客户 Division 用户路径 ──
  if (user_type === 'customer' && roles.has('customer_division')) {
    const divisions = permissions.divisions;

    // 安全默认：无 division 配置 → 空集
    if (divisions.length === 0) return new Set();

    // division_code 格式：'ZHONGCHONG.brand' → 取后缀 label 部分
    const divisionLabels = divisions.map(d => {
      const dot = d.indexOf('.');
      return dot >= 0 ? d.slice(dot + 1) : d;
    });

    const res = await pool.query(
      `SELECT DISTINCT shipment_no
       FROM portal_shipment_division_map
       WHERE company_code = $1
         AND division_label = ANY($2::text[])`,
      [company_code, divisionLabels]
    );
    return new Set(res.rows.map(r => r.shipment_no));
  }

  // ── 基础客户只读（customer_view，无 division 限制）──
  if (user_type === 'customer' && roles.has('customer_view')) {
    const res = await pool.query(
      `SELECT DISTINCT shipment_no
       FROM portal_shipment_division_map
       WHERE company_code = $1`,
      [company_code]
    );
    return new Set(res.rows.map(r => r.shipment_no));
  }

  // internal 及其他：Phase 1 一律返回空集
  return new Set();
}

// ──────────────────────────────────────────────────────────────
// SQL Filter Builder
// ──────────────────────────────────────────────────────────────

/**
 * buildShippingFilter
 * 构造注入主链查询的 WHERE 子句片段和参数数组。
 *
 * 调用方示例：
 *   const filter = await buildShippingFilter(perms, pool);
 *   const sql = `SELECT * FROM shipping_plans WHERE ${filter.clause} ORDER BY etd DESC`;
 *   const rows = await pool.query(sql, filter.params);
 *
 * @param {PermissionsContext} permissions
 * @param {object} pool
 * @returns {Promise<{ clause: string, params: any[] }>}
 *   clause: 'shipment_no = ANY($1::text[])' 或 'FALSE'（空集）
 *   params: [string[]] 或 []
 */
export async function buildShippingFilter(permissions, pool) {
  const visibleNos = await getVisibleShipmentNos(permissions, pool);

  if (visibleNos.size === 0) {
    // 无权限或无可见数据：返回恒假条件，调用方无需特殊处理
    return { clause: 'FALSE', params: [] };
  }

  return {
    clause: 'shipment_no = ANY($1::text[])',
    params: [[...visibleNos]],
  };
}

/**
 * buildFilterWithOffset
 * 与 buildShippingFilter 相同，但支持参数下标偏移。
 * 适用于调用方查询已有若干 $N 参数时。
 *
 * @param {PermissionsContext} permissions
 * @param {object} pool
 * @param {number} paramOffset - 起始参数序号（如已有 $1, $2 则传 2，新参数从 $3 开始）
 * @returns {Promise<{ clause: string, params: any[], nextOffset: number }>}
 */
export async function buildFilterWithOffset(permissions, pool, paramOffset = 0) {
  const visibleNos = await getVisibleShipmentNos(permissions, pool);

  if (visibleNos.size === 0) {
    return { clause: 'FALSE', params: [], nextOffset: paramOffset };
  }

  const idx = paramOffset + 1;
  return {
    clause:     `shipment_no = ANY($${idx}::text[])`,
    params:     [[...visibleNos]],
    nextOffset: idx,
  };
}

// ──────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────

/**
 * hasRole
 * 判断权限上下文是否持有指定角色。
 *
 * @param {PermissionsContext} permissions
 * @param {string|string[]} roleOrRoles
 * @returns {boolean}
 */
export function hasRole(permissions, roleOrRoles) {
  const roles = new Set(permissions.roles);
  if (Array.isArray(roleOrRoles)) {
    return roleOrRoles.some(r => roles.has(r));
  }
  return roles.has(roleOrRoles);
}

/**
 * isLogistics / isCustomer
 * 快捷类型判断。
 */
export function isLogistics(permissions) {
  return permissions.user.user_type === 'logistics';
}
export function isCustomer(permissions) {
  return permissions.user.user_type === 'customer';
}
