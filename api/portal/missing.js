/**
 * api/portal/missing.js — Portal M3 问题项读接口
 * 文档日期：2026-04-13
 *
 * GET /api/portal/missing
 *
 * 权限：任意 logistics 角色（可见海运或报关模块）或任意 customer 角色
 * 过滤：portal_shipment_division_map 决定可见 shipment_no 集合
 * 数据源：document_missing_items（M3 自动识别的问题列表）
 *
 * Query params（与 /api/db/m3-missing 保持一致，便于 Phase 3 UI 对接）：
 *   status      string   默认 'open'，可传 'resolved'/'all'
 *   severity    string   可选：critical / warning / info
 *   issue_type  string   可选：missing / conflict / low_confidence / invalid_format
 *   shipment_no string   可选，在可见集合内进一步精确过滤
 *   limit       integer  默认 200，最大 500
 *
 * 排序：severity (critical → warning → info), created_at DESC
 */

import { getPool, setCors } from '../db.js';
import { canAccessModule, buildFilterWithOffset } from './auth-check.js';
import { parsePortalAuth } from './middleware.js';

// logistics 用户访问 missing 需持有 ocean 或 customs 中至少一个模块的权限
// customer 用户只要有任意 customer 角色即可
const VALID_STATUSES    = new Set(['open', 'resolved', 'all']);
const VALID_SEVERITIES  = new Set(['critical', 'warning', 'info']);
const VALID_ISSUE_TYPES = new Set(['missing', 'conflict', 'low_confidence', 'invalid_format']);

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const pool = getPool();

  // ── 1. 验证 Token + 加载权限 ──
  const permissions = await parsePortalAuth(req, res, pool);
  if (!permissions) return;

  // ── 2. 模块访问检查（missing 对应 shipping_plans 或 customs_data 模块）──
  // 物流用户：有 ocean 或 customs 任一即可
  // 客户用户：有任意 customer 角色即可（canAccessModule 已处理）
  const canSeeShipping = canAccessModule(permissions, 'shipping_plans');
  const canSeeCustoms  = canAccessModule(permissions, 'customs_data');
  if (!canSeeShipping && !canSeeCustoms) {
    return res.status(403).json({
      error: `User ${permissions.user.username} cannot access missing items: no module access`,
      code: 'FORBIDDEN',
    });
  }

  // ── 3. 计算可见 shipment_no 集合 ──
  const filter = await buildFilterWithOffset(permissions, pool, 0);

  if (filter.clause === 'FALSE') {
    return res.json({ success: true, data: [], count: 0 });
  }

  // ── 4. 解析 query params ──
  const {
    status:     rawStatus,
    severity:   rawSeverity,
    issue_type: rawIssueType,
    shipment_no: qShipment,
    limit:       rawLimit,
  } = req.query;

  const lim = Math.min(Number(rawLimit) || 200, 500);

  const params = [...filter.params]; // $1 = shipment_no[]
  const conds  = [filter.clause];
  let offset   = filter.nextOffset;

  // status 过滤（默认 open；'all' 时不加条件）
  const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : 'open';
  if (status !== 'all') {
    offset++;
    params.push(status);
    conds.push(`status = $${offset}`);
  }

  // severity 过滤
  if (rawSeverity && VALID_SEVERITIES.has(rawSeverity)) {
    offset++;
    params.push(rawSeverity);
    conds.push(`severity = $${offset}`);
  }

  // issue_type 过滤
  if (rawIssueType && VALID_ISSUE_TYPES.has(rawIssueType)) {
    offset++;
    params.push(rawIssueType);
    conds.push(`issue_type = $${offset}`);
  }

  // 可选：精确过滤单个 SP（必须在可见集合内）
  if (qShipment && qShipment.trim()) {
    offset++;
    params.push(qShipment.trim());
    conds.push(`shipment_no = $${offset}`);
  }

  // ── 5. 查询（返回 Portal 可见字段）──
  const sql = `
    SELECT
      id,
      shipment_no,
      issue_type,
      severity,
      field_name,
      description,
      doc_type,
      status,
      created_at,
      resolved_at
    FROM document_missing_items
    WHERE ${conds.join(' AND ')}
    ORDER BY
      CASE severity
        WHEN 'critical' THEN 0
        WHEN 'warning'  THEN 1
        ELSE 2
      END,
      created_at DESC
    LIMIT ${lim}
  `;

  try {
    const result = await pool.query(sql, params);
    return res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('[portal/missing] query error:', err.message);
    return res.status(500).json({ error: 'Query failed', code: 'DB_ERROR' });
  }
}
