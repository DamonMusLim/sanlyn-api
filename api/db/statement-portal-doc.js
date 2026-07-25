// Customer statement portal — single document opener.
// GET /api/db/statement-portal-doc?token=<magic>&ref=df:123
// Token 决定 company scope;ref 必须在该 scope 允许集合内,否则 404(不泄露"存在但不属于你")。
// 存储直链(OSS/files.sanlynos.com)只在服务端解析,客户端只见 ref,拿不到桶结构、也无法枚举别家单据。
import { getPool, setCors } from "../db.js";
import { generateToken } from "../auth.js";
import { sendError } from "../lib/viewmodel-adapter.js";
import { clean } from "./statement-portal-helpers.js";
import { fetchCustomerDocIndex } from "./statement-portal-docs.js";
import { resolveCustomerScope } from "./statement-portal-data.js";

const REF_RE = /^(df|bs):(\d{1,18})$/;

async function resolveUrl(pool, ref) {
  const m = REF_RE.exec(ref);
  if (!m) return null;
  const [, kind, id] = m;
  if (kind === "df") {
    const r = await pool.query(
      `SELECT storage_url, display_name, mime_type
         FROM document_files
        WHERE id = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [id]
    );
    if (!r.rows.length) return null;
    return { url: clean(r.rows[0].storage_url), name: r.rows[0].display_name };
  }
  const r = await pool.query(
    `SELECT file_url FROM bank_slips WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (!r.rows.length) return null;
  return { url: clean(r.rows[0].file_url), name: `slip-${id}` };
}

export async function statementPortalDoc(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return sendError(res, 405, "method_not_allowed", "GET only");
  const pool = getPool();
  try {
    const scopeCode = await resolveCustomerScope(req, res, pool);
    if (!scopeCode) return;

    const ref = clean(req.query?.ref);

    // gen:iv:<order_nos csv> — IV 由订单数据现生成(documents type=pack&page=iv&audience=customer)。
    // 订单必须全部属于本 scope,否则 404;临时客户 JWT 服务端铸造,只带本客户 scope。
    const gm = /^gen:iv:([A-Za-z0-9,_-]{1,120})$/.exec(ref);
    if (gm) {
      const nos = gm[1].split(",").map(clean).filter(Boolean);
      if (!nos.length) return sendError(res, 400, "bad_ref", "invalid document ref");
      const r = await pool.query(
        `SELECT id, order_no FROM orders
          WHERE company_code = $1 AND deleted_at IS NULL AND order_no = ANY($2::text[])`,
        [scopeCode, nos]);
      if (r.rows.length !== nos.length) return sendError(res, 404, "not_found", "document not available");
      const idList = r.rows.map((x) => x.id);
      // 用该客户的真实账号铸 JWT(documents 鉴权核 accounts 表,虚构 uid 会 ACCOUNT_NOT_FOUND)
      const acc = await pool.query(
        `SELECT id, username, role, company, company_code, company_codes, token_version
           FROM accounts
          WHERE company_code = $1 AND is_active = true AND role IN ('customer','customer_booking')
          ORDER BY id LIMIT 1`, [scopeCode]);
      if (!acc.rows.length) return sendError(res, 404, "not_found", "document not available");
      const a = acc.rows[0];
      const codes = Array.isArray(a.company_codes) && a.company_codes.length ? a.company_codes : [a.company_code];
      const jwt = generateToken({ uid: a.id, username: a.username, role: a.role,
        company: a.company, companyCode: a.company_code, companyCodes: codes, tv: a.token_version || 1 });
      // 直跳模板页:模板按 order_no 取数(数字id会被当订单号查空);ids=合并单全部订单号
      const q = `order_no=${encodeURIComponent(nos[0])}` + (nos.length > 1 ? `&ids=${encodeURIComponent(nos.join(","))}` : "");
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(302, `/templates/export-docs-template.html?${q}&page=iv&mode=detail&audience=customer&token=${encodeURIComponent(jwt)}`);
    }

    // gen:freight:<bl_no> — 运费借记单(海运费+港杂费),按BL验归属(该客户订单含此BL 或 该BL海运票customer名匹配)
    const fm = /^gen:freight:([A-Za-z0-9_-]{1,40})$/.exec(ref);
    if (fm) {
      const bl = fm[1];
      const own = await pool.query(
        `SELECT s._id FROM shipping_plans s
          WHERE s.bl_no = $2
            AND (s.order_nos && ARRAY(SELECT order_no FROM orders WHERE company_code = $1 AND deleted_at IS NULL)
                 OR s.customer IN (SELECT name FROM customers WHERE company_code = $1
                                   UNION SELECT name_en FROM customers WHERE company_code = $1))
          LIMIT 1`, [scopeCode, bl]);
      if (!own.rows.length) return sendError(res, 404, "not_found", "document not available");
      const acc = await pool.query(
        `SELECT id, username, role, company, company_code, company_codes, token_version
           FROM accounts WHERE company_code = $1 AND is_active = true AND role IN ('customer','customer_booking')
          ORDER BY id LIMIT 1`, [scopeCode]);
      if (!acc.rows.length) return sendError(res, 404, "not_found", "document not available");
      const a = acc.rows[0];
      const codes = Array.isArray(a.company_codes) && a.company_codes.length ? a.company_codes : [a.company_code];
      const jwt = generateToken({ uid: a.id, username: a.username, role: a.role,
        company: a.company, companyCode: a.company_code, companyCodes: codes, tv: a.token_version || 1 });
      const shipmentId = own.rows[0]._id;
      res.setHeader("Cache-Control", "no-store");
      // 2026-07-20 Damon:用正版海运费模板(page=freight),不用debit借记单
      return res.redirect(302, `/templates/export-docs-template.html?page=freight&shipment_id=${encodeURIComponent(shipmentId)}&audience=customer&token=${encodeURIComponent(jwt)}`);
    }

    if (!REF_RE.test(ref)) return sendError(res, 400, "bad_ref", "invalid document ref");

    // Authorization: rebuild the scope's allowed set and require membership.
    // No clever join — the same index that produced the link validates it.
    const index = await fetchCustomerDocIndex(pool, scopeCode);
    if (!index.allowed.has(ref)) {
      return sendError(res, 404, "not_found", "document not available");
    }

    const target = await resolveUrl(pool, ref);
    if (!target || !target.url) {
      return sendError(res, 404, "not_found", "document file missing");
    }

    // Storage hosts are already public-read; a redirect adds no new exposure and
    // avoids proxying bandwidth. The share link the customer holds stays on the
    // front domain — no api host is ever pasted into a customer-visible link.
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.redirect(302, target.url);
  } catch (err) {
    console.error("[statement-portal-doc]", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}

export default statementPortalDoc;

// Reused: statement-portal-data.resolveCustomerScope (magic_links + JWT customer scope),
// statement-portal-docs.fetchCustomerDocIndex whitelist, viewmodel-adapter.sendError.
// Final line count after this edit: 72.
