// /api/db/collab-link-center.js — 海运协同链接台账（magic_links）。仅内部。
//
// 受众隔离：本文件只管【海运/出口协同】链接（发给工厂/货代/车队/报关行/保险/客户的 magic_links）。
// 供应链/包材那条线的分享短码（share_links：库存比对/袋子清点/款式报价）归 share-center.js，
// 两条线各是各的页面各是各的接口，绝不混在一个界面里（2026-07-23 Damon 指正："你串了，
// 之前我做这个是袋子，你应该是海运订单的分享才对"）。
//
// 库里只存 token 的 sha256，所以台账只给"发给谁 / 能看到什么 / 打开过没有 / 一键作废"，
// 给不出也不该给链接原文——要重发只能重新签发。

import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";
import { writeAudit } from "./audit-helper.js";

function json(res, s, p) { return res.status(s).json(p); }
function clean(v, n = 80) { return String(v == null ? "" : v).trim().slice(0, n); }
function isInternal(req) { const r = clean(req.user?.role, 40).toLowerCase(); return r === "admin" || r === "sanlyn"; }

const ROLE_CN = {
  collab_master: "协同总表", supplier_portal: "供应商门户", factory_booking: "工厂订舱",
  customer_booking: "客户托书", customer_myportal: "客户门户", customer_downstream: "客户追踪",
  customer_activation: "客户激活", fwd_portal: "货代门户", forwarder: "货代",
  broker_booking: "报关行", trucking_booking: "车队", shipper_booking: "发货人",
  bill_collab: "账单协同", order_customer_timeline: "订单时间轴", customer_quote: "客户报价",
};
const VIEW_CN = { internal: "内部", fwd: "货代", trucker: "车队", broker: "报关行", insurer: "保险", factory: "工厂", customer: "客户" };
// 收件人大类，用于分组：给外部谁看的
const AUDIENCE = {
  factory_booking: "工厂", supplier_portal: "工厂/供应商",
  customer_booking: "客户", customer_myportal: "客户", customer_downstream: "客户",
  customer_activation: "客户", customer_quote: "客户", order_customer_timeline: "客户",
  fwd_portal: "货代", forwarder: "货代", shipper_booking: "货代/发货人",
  broker_booking: "报关行", trucking_booking: "车队", bill_collab: "财务",
};
function audienceOf(role, meta) {
  if (role === "collab_master") return VIEW_CN[meta?.view] || "协同总表";
  return AUDIENCE[role] || "其他";
}

// 从 meta 摘出"这条链接能看到什么"，只取范围键，绝不回显 token/密钥类内容
function scopeOf(meta) {
  const m = meta || {};
  const bits = [];
  if (m.view) bits.push("视角=" + (VIEW_CN[m.view] || m.view));
  if (m.bl_no) bits.push("提单=" + m.bl_no);
  if (m.order_no) bits.push("订单=" + m.order_no);
  if (m.contract_no) bits.push("合同=" + m.contract_no);
  if (m.company_code) bits.push("客户=" + m.company_code);
  if (m.factory_code || m.factory_scope) bits.push("工厂=" + (m.factory_code || m.factory_scope));
  if (Array.isArray(m.container_nos) && m.container_nos.length) bits.push("柜=" + m.container_nos.join("/"));
  if (m.shipment_id) bits.push("票号内码=" + m.shipment_id);
  if (Array.isArray(m.segments) && m.segments.length) bits.push("段=" + m.segments.join("/"));
  if (m.field_profile) bits.push("档案=" + m.field_profile);
  if (m.stage) bits.push("阶段=" + (m.stage === "after" ? "装货后" : "装货前"));
  if (m.test) bits.push("测试");
  return bits.length ? bits.join(" · ") : "（未标范围）";
}

async function list(pool) {
  const r = await pool.query(
    `SELECT id, recipient_role, meta, created_at, created_by, expires_at, revoked_at, used_at,
            COALESCE(revoked,false) AS revoked_flag,
            jsonb_array_length(COALESCE(access_log,'[]'::jsonb)) AS hits,
            (COALESCE(access_log,'[]'::jsonb) -> -1 ->> 'accessed_at') AS last_hit_at
       FROM magic_links ORDER BY created_at DESC LIMIT 400`);
  const now = Date.now();
  return r.rows.map(x => {
    let meta = x.meta || {};
    if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch (_) { meta = {}; } }
    const expired = x.expires_at && new Date(x.expires_at).getTime() < now;
    const revoked = Boolean(x.revoked_at) || x.revoked_flag;
    const hits = Number(x.hits || 0);
    return {
      id: x.id,
      role: x.recipient_role,
      role_cn: ROLE_CN[x.recipient_role] || x.recipient_role,
      audience: audienceOf(x.recipient_role, meta),
      scope: scopeOf(meta),
      hits, last_hit_at: x.last_hit_at,
      created_at: x.created_at, created_by: x.created_by || "",
      expires_at: x.expires_at,
      state: revoked ? "revoked" : expired ? "expired" : "active",
      never_opened: !revoked && !expired && hits === 0,
    };
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) extractUser(req);
  if (!req.user) return json(res, 401, { success: false, error: "Unauthorized" });
  if (!isInternal(req)) return json(res, 403, { success: false, error: "internal only" });
  const pool = getPool();
  try {
    if (req.method === "GET") return json(res, 200, { success: true, links: await list(pool) });
    if (req.method === "PATCH" && clean(req.query.action || req.body?.action, 40) === "revoke") {
      const id = Number(req.body?.id || 0);
      if (!id) return json(res, 400, { success: false, error: "id required" });
      const r = await pool.query(
        "UPDATE magic_links SET revoked_at=NOW() WHERE id=$1 AND revoked_at IS NULL RETURNING recipient_role", [id]);
      if (!r.rowCount) return json(res, 404, { success: false, error: "link not found or already revoked" });
      try {
        await writeAudit(pool, req, {
          action: "collab-link-center.revoke", entity_type: "magic_link", entity_id: String(id),
          before: { revoked: false }, after: { revoked: true },
          note: "作废协同链接 " + r.rows[0].recipient_role,
        });
      } catch (_) {}
      return json(res, 200, { success: true });
    }
    return json(res, 405, { success: false, error: "method/action not allowed" });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message });
  }
}
