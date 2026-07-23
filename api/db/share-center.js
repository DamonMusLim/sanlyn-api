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
      const r = await pool.query(
        `SELECT sl.code, sl.page, sl.path, sl.revoked, sl.hits, sl.last_hit_at, sl.expires_at, sl.created_at, sl.created_by,
                a.company, a.username, a.role
           FROM share_links sl JOIN accounts a ON a.id = sl.account_id
          ORDER BY sl.created_at DESC LIMIT 500`);
      return json(res, 200, { success: true, links: r.rows.map(x => pub(x, host)) });
    }
    const action = clean(req.query.action || req.body?.action, 40);
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
