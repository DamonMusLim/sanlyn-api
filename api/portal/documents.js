/**
 * api/portal/documents.js — Portal 单证/报关状态读接口
 * 文档日期：2026-04-13
 *
 * GET /api/portal/documents
 *
 * 权限：logistics_customs 或任意 customer 角色
 * 过滤：portal_shipment_division_map 决定可见 shipment_no 集合
 * 数据源：customs_data（含 bl_final / customs_dec / booking_note 等单证完整度字段）
 *
 * Query params：
 *   shipment_no  string   可选，在可见集合内进一步精确过滤
 *   limit        integer  默认 100，最大 500
 */

import { getPool, setCors } from '../db.js';
import { assertModuleAccess, buildFilterWithOffset } from './auth-check.js';
import { parsePortalAuth } from './middleware.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const pool = getPool();

  // ── 1. 验证 Token + 加载权限 ──
  const permissions = await parsePortalAuth(req, res, pool);
  if (!permissions) return;

  // ── 2. 模块访问检查 ──
  try {
    assertModuleAccess(permissions, 'customs_data');
  } catch (err) {
    return res.status(403).json({ error: err.message, code: 'FORBIDDEN' });
  }

  // ── 3. 计算可见 shipment_no 集合 ──
  const filter = await buildFilterWithOffset(permissions, pool, 0);

  if (filter.clause === 'FALSE') {
    return res.json({ success: true, data: [], count: 0 });
  }

  // ── 4. 解析附加 query params ──
  const { shipment_no: qShipment, limit: rawLimit } = req.query;
  const lim = Math.min(Number(rawLimit) || 100, 500);

  const params = [...filter.params]; // $1 = shipment_no[]
  const conds  = [filter.clause];

  let offset = filter.nextOffset;

  // 可选：在可见集合内进一步过滤单个 SP
  if (qShipment && qShipment.trim()) {
    offset++;
    params.push(qShipment.trim());
    conds.push(`shipment_no = $${offset}`);
  }

  offset++;
  params.push(lim);

  // ── 5. 查询（只返回单证完整度相关字段，不暴露内部处理字段）──
  const sql = `
    SELECT
      shipment_no,
      contract_no,
      bl_final,
      bl_draft,
      customs_dec,
      customs_dec_official,
      booking_note,
      release_note,
      origin_cert,
      updated_at
    FROM customs_data
    WHERE ${conds.join(' AND ')}
    ORDER BY updated_at DESC NULLS LAST
    LIMIT $${offset}
  `;

  try {
    const result = await pool.query(sql, params);
    return res.json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) {
    console.error('[portal/documents] query error:', err.message);
    return res.status(500).json({ error: 'Query failed', code: 'DB_ERROR' });
  }
}
