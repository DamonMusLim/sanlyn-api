/**
 * api/portal/shipping.js — Portal 海运计划读接口
 * 文档日期：2026-04-13
 *
 * GET /api/portal/shipping
 *
 * 权限：logistics_ocean 或任意 customer 角色
 * 过滤：portal_shipment_division_map 决定可见 shipment_no 集合
 *
 * Query params：
 *   limit     integer  默认 100，最大 500
 *   etd_from  date     ETD 起始（YYYY-MM-DD，可选）
 *   etd_to    date     ETD 截止（YYYY-MM-DD，可选）
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
  if (!permissions) return; // 已响应 401/403

  // ── 2. 模块访问检查 ──
  try {
    assertModuleAccess(permissions, 'shipping_plans');
  } catch (err) {
    return res.status(403).json({ error: err.message, code: 'FORBIDDEN' });
  }

  // ── 3. 计算可见 shipment_no 集合（注入为 $1 参数）──
  const filter = await buildFilterWithOffset(permissions, pool, 0);

  // 空集：直接返回，不走 DB
  if (filter.clause === 'FALSE') {
    return res.json({ success: true, data: [], count: 0 });
  }

  // ── 4. 解析附加 query params（从 $2 开始编号）──
  const { limit: rawLimit, etd_from, etd_to } = req.query;
  const lim = Math.min(Number(rawLimit) || 100, 500);

  const params = [...filter.params]; // $1 = shipment_no[]
  const conds  = [filter.clause];    // WHERE shipment_no = ANY($1::text[])

  let offset = filter.nextOffset; // 当前最高参数序号

  if (etd_from) {
    offset++;
    params.push(etd_from);
    conds.push(`etd >= $${offset}::date`);
  }
  if (etd_to) {
    offset++;
    params.push(etd_to);
    conds.push(`etd <= $${offset}::date`);
  }

  offset++;
  params.push(lim);

  // ── 5. 查询（不返回 raw JSONB、created_by 等内部字段）──
  const sql = `
    SELECT
      shipment_no, bl_no, vessel, voyage,
      etd, eta, pol, pod,
      customer, order_contract_nos, flow_status,
      created_at, updated_at
    FROM shipping_plans
    WHERE ${conds.join(' AND ')}
    ORDER BY etd DESC NULLS LAST
    LIMIT $${offset}
  `;

  try {
    const result = await pool.query(sql, params);
    return res.json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) {
    console.error('[portal/shipping] query error:', err.message);
    return res.status(500).json({ error: 'Query failed', code: 'DB_ERROR' });
  }
}
