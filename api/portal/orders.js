/**
 * api/portal/orders.js — 协同卡订单数据接口
 * GET /api/portal/orders/:contractNo
 *
 * 功能:按 contract_no 返回订单数据,按登录角色裁剪敏感字段(服务端 scoping)。
 * 认证:Portal Token(parsePortalAuth)或 Admin JWT(Authorization: Bearer)。
 * 裁剪原则:客户看不到工厂/成本/运价/提单;工厂看不到客户价/BL/ETA;只有内部角色看全量。
 * 铁律:字段从DB取,不猜不补;缺数据返null不返假值。
 * 2026-06-06
 */

import { getPool, setCors } from '../db.js';
import { parsePortalAuth } from './middleware.js';
import { requireAuth } from '../auth.js';

// 客户角色不该看的字段
const HIDDEN_FOR_CUSTOMER = new Set([
  'factory', 'factory_name', 'factory_cost', 'unit_cost', 'total_cost',
  'profit', 'profit_rate', 'ocean_freight', 'freight_quote', 'freight_cost',
  'bl_no', 'bl_date', 'bl_url', 'vessel', 'voyage', 'etd', 'eta',
  'container_no', 'container_booking_no',
]);

// 工厂角色不该看的字段
const HIDDEN_FOR_FACTORY = new Set([
  'customer', 'company_code', 'customer_po', 'sale_price', 'total_amount',
  'bl_no', 'bl_date', 'bl_url', 'vessel', 'voyage', 'etd', 'eta',
  'profit', 'profit_rate', 'ocean_freight',
]);

function scopeOrder(order, role) {
  if (!order) return null;
  if (role === 'admin' || role === 'internal_sanlyn' || role === 'finance') return order;
  const hidden = role === 'factory' ? HIDDEN_FOR_FACTORY : HIDDEN_FOR_CUSTOMER;
  const out = {};
  for (const [k, v] of Object.entries(order)) {
    out[k] = hidden.has(k) ? null : v;
  }
  // raw JSONB 里也过滤
  if (out.raw && typeof out.raw === 'object') {
    const cleanRaw = { ...out.raw };
    for (const k of hidden) { if (k in cleanRaw) delete cleanRaw[k]; }
    out.raw = cleanRaw;
  }
  return out;
}

export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // 取 contract_no(支持 /api/portal/orders/FS2026... 和 ?contract_no=FS2026...)
  const urlParts = req.url?.split('?')[0]?.split('/') || [];
  const contractNo = urlParts[urlParts.length - 1] || req.query?.contract_no || req.query?.contractNo;
  if (!contractNo || contractNo === 'orders') {
    return res.status(400).json({ ok: false, error: 'contract_no 必填' });
  }

  const pool = getPool();
  let role = 'customer';
  let companyCodes = [];

  // 1) 先试 Portal Token
  try {
    const perms = await parsePortalAuth(req, res, pool);
    if (!perms) return; // 已 401
    role = perms.user_type || 'customer';
    companyCodes = perms.company_codes || [];
  } catch {
    // 2) 降级:试内部 JWT(Admin 登录的那种)
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token) {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        role = payload.role || 'customer';
        const cc = payload.company_codes || payload.companyCodes;
        companyCodes = Array.isArray(cc) ? cc : (payload.company_code ? [payload.company_code] : []);
      }
    } catch { /* 匿名,fallthrough to 401 */ }
    if (!role || (role === 'customer' && companyCodes.length === 0)) {
      return res.status(401).json({ ok: false, error: '需要登录' });
    }
  }

  try {
    // 查订单(orders表)
    const oRes = await pool.query(
      `SELECT o.* FROM orders o WHERE o.contract_no = $1 LIMIT 1`,
      [contractNo]
    );
    if (oRes.rows.length) {
      // order_line_items 单独查(order_id 和 _id 类型可能不同,用::text兼容)
      try {
        const oid = oRes.rows[0]._id || oRes.rows[0].id;
        const liRes = await pool.query(
          `SELECT * FROM order_line_items WHERE order_id = $1 ORDER BY id`,
          [oid]
        );
        oRes.rows[0].line_items = liRes.rows;
      } catch { oRes.rows[0].line_items = []; }
    }
    if (!oRes.rows.length) return res.status(404).json({ ok: false, error: '订单不存在' });
    const order = oRes.rows[0];

    // 服务端 scoping:非内部角色须校验 company_code
    const internalRoles = ['admin', 'internal_sanlyn', 'finance', 'logistics'];
    if (!internalRoles.includes(role)) {
      const orderCode = order.company_code || order.raw?.company_code;
      if (companyCodes.length > 0 && orderCode && !companyCodes.includes(orderCode)) {
        return res.status(403).json({ ok: false, error: '无权查看此订单' });
      }
      if (companyCodes.length === 0) {
        return res.status(403).json({ ok: false, error: '账号未绑定公司,请联系 Sanlyn' });
      }
    }

    // 查海运计划(只选确定存在的列)
    let sp = {};
    try {
      const spRes = await pool.query(
        `SELECT bl_no, vessel, voyage, etd, eta, container_type, current_status
         FROM shipping_plans WHERE contract_no = $1 LIMIT 1`,
        [contractNo]
      );
      sp = spRes.rows[0] || {};
    } catch { /* shipping_plans 查不到时不影响订单返回 */ }

    // 合并 + 裁剪
    const merged = {
      ...order,
      flow_status: sp.current_status || order.status,
      bl_no: sp.bl_no || null,
      vessel: sp.vessel || null,
      voyage: sp.voyage || null,
      etd: sp.etd || null,
      eta: sp.eta || null,
      container_type: sp.container_type || null,
    };

    const scoped = scopeOrder(merged, role);
    return res.status(200).json({ ok: true, data: scoped, role, contractNo });
  } catch (err) {
    console.error('[portal/orders]', err.message);
    return res.status(500).json({ ok: false, error: '服务器错误' });
  }
}
