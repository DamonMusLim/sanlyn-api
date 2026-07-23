// /api/db/share-center.js - 链接中心(M4): 所有对外短码一览/撤销/重新生成. 仅巴匕(admin/sanlyn).
import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";
import { writeAudit } from "./audit-helper.js";

const PAGE_LABELS = {
  "sku-recon": "库存比对", "supplier-catalog": "款式报价", "factory-bags": "包材清点",
  stock: "产品库存", orders: "客户订单", "customer-portal": "客户门户",
};
const ROLE_LABELS = { customer: "客户", factory: "工厂", supplier: "供应商" };
const EDIT_PAGES = new Set(["supplier-catalog"]); // 客户打开只读页; 工厂/供应商打开可填页
function json(res, s, p) { return res.status(s).json(p); }
function clean(v, n = 80) { return String(v == null ? "" : v).trim().slice(0, n); }
function isInternal(req) { const r = clean(req.user?.role, 40).toLowerCase(); return r === "admin" || r === "sanlyn"; }
function genCode() {
  const cs = "abcdefghijkmnpqrstuvwxyz23456789";
  let c = ""; for (let i = 0; i < 8; i++) c += cs[Math.floor(Math.random() * cs.length)];
  return c;
}
function pub(row, host) {
  const now = Date.now();
  const expired = row.expires_at && new Date(row.expires_at).getTime() < now;
  return {
    code: row.code,
    short_url: `https://${host}/v/${row.code}`,
    page: row.page, page_label: PAGE_LABELS[row.page] || row.page,
    company: row.company || row.username || "", role: row.role, role_label: ROLE_LABELS[row.role] || row.role,
    can_edit: row.role !== "customer",
    status: row.revoked ? "revoked" : (expired ? "expired" : "active"),
    hits: Number(row.hits || 0),
    last_hit_at: row.last_hit_at, expires_at: row.expires_at, created_at: row.created_at, created_by: row.created_by || "",
  };
}

// ── 协同链接台账(magic_links) ──────────────────────────────────────────
// 原始 token 只在收件人手里(库里只有 sha256)，所以台账只给"发给谁/什么范围/点没点过/一键作废"，
// 不给也不可能给回链接原文——要重发只能重新签发。
const ROLE_CN = {
  collab_master: "协同总表", supplier_portal: "供应商门户", factory_booking: "工厂订舱",
  customer_booking: "客户托书", customer_myportal: "客户门户", customer_downstream: "客户追踪",
  customer_activation: "客户激活", fwd_portal: "货代门户", forwarder: "货代",
  broker_booking: "报关行", trucking_booking: "车队", shipper_booking: "发货人",
  bill_collab: "账单协同", order_customer_timeline: "订单时间轴",
};
const VIEW_CN = { internal: "内部", fwd: "货代", trucker: "车队", broker: "报关行", insurer: "保险", factory: "工厂", customer: "客户" };
// meta 里挑出"这条链接能看到什么"，只摘范围键，绝不回显 token/密钥类内容
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
  if (m.test) bits.push("测试");
  return bits.length ? bits.join(" · ") : "（未标范围）";
}
async function listCollab(pool) {
  const r = await pool.query(
    `SELECT id, recipient_role, meta, created_at, created_by, expires_at, revoked_at, used_at,
            COALESCE(revoked,false) AS revoked_flag,
            jsonb_array_length(COALESCE(access_log,'[]'::jsonb)) AS hits,
            (COALESCE(access_log,'[]'::jsonb) -> -1 ->> 'accessed_at') AS last_hit_at
       FROM magic_links ORDER BY created_at DESC LIMIT 400`);
  const now = Date.now();
  return r.rows.map(x => {
    const meta = typeof x.meta === "string" ? (() => { try { return JSON.parse(x.meta); } catch (_) { return {}; } })() : (x.meta || {});
    const expired = x.expires_at && new Date(x.expires_at).getTime() < now;
    const revoked = Boolean(x.revoked_at) || x.revoked_flag;
    return {
      id: x.id,
      role: x.recipient_role,
      role_cn: ROLE_CN[x.recipient_role] || x.recipient_role,
      scope: scopeOf(meta),
      hits: Number(x.hits || 0),
      last_hit_at: x.last_hit_at,
      created_at: x.created_at,
      created_by: x.created_by || "",
      expires_at: x.expires_at,
      state: revoked ? "revoked" : expired ? "expired" : "active",
      never_opened: !revoked && !expired && Number(x.hits || 0) === 0,
    };
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) extractUser(req);
  if (!req.user) return json(res, 401, { success: false, error: "Unauthorized" });
  if (!isInternal(req)) return json(res, 403, { success: false, error: "internal only" });
  const pool = getPool();
  const host = req.headers.host || "ai.sanlyn.cn";
  try {
    if (req.method === "GET") {
      // source=collab → 协同链接台账(magic_links)；缺省=分享短码(share_links)。同一个页面两个数据源。
      if (clean(req.query.source, 20) === "collab") {
        return json(res, 200, { success: true, links: await listCollab(pool) });
      }
      const r = await pool.query(
        `SELECT sl.code, sl.page, sl.path, sl.revoked, sl.hits, sl.last_hit_at, sl.expires_at, sl.created_at, sl.created_by,
                a.company, a.username, a.role
           FROM share_links sl JOIN accounts a ON a.id = sl.account_id
          ORDER BY sl.created_at DESC LIMIT 500`);
      return json(res, 200, { success: true, links: r.rows.map(x => pub(x, host)) });
    }
    const action = clean(req.query.action || req.body?.action, 40);
    // 协同链接按 id 作废(magic_links 无 code 列，原始 token 只有收件人手里有)
    if (req.method === "PATCH" && action === "revoke-collab") {
      const id = Number(req.body?.id || 0);
      if (!id) return json(res, 400, { success: false, error: "id required" });
      const r = await pool.query(
        "UPDATE magic_links SET revoked_at=NOW() WHERE id=$1 AND revoked_at IS NULL RETURNING recipient_role", [id]);
      if (!r.rowCount) return json(res, 404, { success: false, error: "link not found or already revoked" });
      try { await writeAudit(pool, req, { action: "share-center.revoke-collab", entity_type: "magic_link", entity_id: String(id), before: { revoked: false }, after: { revoked: true }, note: "作废协同链接 " + r.rows[0].recipient_role }); } catch (_) {}
      return json(res, 200, { success: true });
    }
    const code = clean(req.body?.code, 40);
    if (!code) return json(res, 400, { success: false, error: "code required" });
    if (req.method === "PATCH" && action === "revoke") {
      const r = await pool.query("UPDATE share_links SET revoked=true WHERE code=$1 RETURNING id", [code]);
      if (!r.rowCount) return json(res, 404, { success: false, error: "code not found" });
      try { await writeAudit(pool, req, { action: "share-center.revoke", entity_type: "share_link", entity_id: code, before: { revoked: false }, after: { revoked: true }, note: "撤销分享链接" }); } catch (_) {}
      return json(res, 200, { success: true });
    }
    if (req.method === "POST" && action === "regen") {
      const old = await pool.query("SELECT account_id, page, path FROM share_links WHERE code=$1", [code]);
      if (!old.rowCount) return json(res, 404, { success: false, error: "code not found" });
      await pool.query("UPDATE share_links SET revoked=true WHERE code=$1", [code]);
      const o = old.rows[0];
      let nc = "";
      for (let i = 0; i < 6; i++) {
        const c = genCode();
        try {
          await pool.query("INSERT INTO share_links(code, account_id, page, path, created_by, expires_at) VALUES($1,$2,$3,$4,$5,$6)",
            [c, o.account_id, o.page, o.path, clean(req.user?.username, 80) || "admin", new Date(Date.now() + 7 * 864e5).toISOString()]);
          nc = c; break;
        } catch (_) {}
      }
      if (!nc) return json(res, 500, { success: false, error: "code gen failed" });
      try { await writeAudit(pool, req, { action: "share-center.regen", entity_type: "share_link", entity_id: nc, before: { old_code: code }, after: { code: nc }, note: "重新生成分享链接" }); } catch (_) {}
      return json(res, 200, { success: true, code: nc, short_url: `https://${host}/v/${nc}` });
    }
    return json(res, 405, { success: false, error: "method/action not allowed" });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message });
  }
}
