// api/db/customer-invoice.js
// 客户销项发票门户（B3）：路由 + 鉴权 + 编排。巴匕(销售方)→客户(购买方)。
//   GET  /api/db/customer-invoice?action=gen&order_no=XXX   管理员生成/复用短码 → /ci/CODE
//   GET  /api/db/customer-invoice?c=CODE                    打开短码，读发票草稿(默认报关口径)
//   POST /api/db/customer-invoice?c=CODE&action=save        保存草稿(客户自填/拆分)落 finance_invoices_out
//   POST /api/db/customer-invoice?c=CODE&action=confirm     人工确认已开票(B5)，落状态 issued
//
// 铁律：
//   - 金额默认走报关口径 fob_cny；国外单退税用锁报关口径，国内单可拆分自填。
//   - 正式开票必人工点(confirm)，绝不自动开。
//   - gen 必须内部 admin/company JWT；resolve/save/confirm 只凭短码，无效统一 401 fail-closed。
//
// 分层(≤500 行)：customer-invoice-data.js 负责读查询/组装。

import crypto from "crypto";
import { getPool } from "../db.js";
import { verifyToken } from "../auth.js";
import { buildCustomerInvoice, EDIT_WINDOW_DAYS } from "./customer-invoice-data.js";

const PUBLIC_HOST = process.env.PUBLIC_HOST || "https://api.sanlyn.cn";
const LINK_TTL_DAYS = 60;
const CODE_LEN = 12;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 40;
const rateBuckets = new Map();

function setCors(req, res) {
  const allowed = [
    "https://sanlyn-os.vercel.app",
    "https://ai.sanlynos.com",
    "https://ai.sanlyn.cn",
    "https://dashboard.sanlyn.cn",
    "http://localhost:5173",
    "http://localhost:5188",
    "http://localhost:3000",
  ];
  const origin = req.headers.origin || "";
  if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const json = (res, status, payload) => res.status(status).json(payload);
const failClosed = (res) => json(res, 401, { error: "链接无效或已过期" });
const clean = (v) => String(v ?? "").trim();

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || req.ip || "unknown";
}

function rateLimit(req, code) {
  const key = `${code || "-"}:${clientIp(req)}`;
  const now = Date.now();
  const hit = rateBuckets.get(key);
  if (!hit || now - hit.start > RATE_WINDOW_MS) {
    rateBuckets.set(key, { start: now, count: 1 });
    return true;
  }
  hit.count += 1;
  return hit.count <= RATE_MAX;
}

function randomCode(len = CODE_LEN) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function extractSanlynJwt(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  if (!auth) return null;
  const raw = String(auth).trim();
  const m = raw.match(/sanlyn_jwt\s*=?\s*([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (raw.startsWith("Bearer ")) {
    const token = raw.slice(7).trim();
    const m2 = token.match(/sanlyn_jwt\s*=?\s*([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
    return m2 ? m2[1] : token;
  }
  return raw;
}

function requireAdminJwt(req, res) {
  const user = verifyToken(extractSanlynJwt(req));
  if (!user || !["admin", "company"].includes(user.role)) {
    json(res, 401, { error: "Unauthorized", message: "admin JWT required" });
    return null;
  }
  return user;
}

// 短码 → 订单号。scope_type='customer_invoice'。
async function resolveLink(pool, code) {
  if (!code) return null;
  const r = await pool.query(
    `SELECT code, order_no, expires_at
       FROM invoice_links
      WHERE code = $1 AND purpose = 'customer_invoice' AND expires_at > NOW()
      LIMIT 1`,
    [code]
  );
  return r.rows[0] || null;
}

async function handleGen(req, res) {
  const user = requireAdminJwt(req, res);
  if (!user) return;
  const orderNo = clean(req.query?.order_no);
  if (!orderNo) return json(res, 400, { error: "order_no required" });

  const pool = getPool();
  const view = await buildCustomerInvoice(pool, orderNo);
  if (!view) return json(res, 404, { error: "order not found" });

  const scopeValue = view.buyer?.id ? String(view.buyer.id) : (view.buyer?.name || null);

  const reusable = await pool.query(
    `SELECT code, expires_at FROM invoice_links
      WHERE purpose = 'customer_invoice' AND order_no = $1
        AND expires_at > NOW() + INTERVAL '1 day'
      ORDER BY expires_at DESC LIMIT 1`,
    [view.order_no]
  );

  let code;
  let expiresAt;
  if (reusable.rows[0]) {
    code = reusable.rows[0].code;
    expiresAt = reusable.rows[0].expires_at;
  } else {
    expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i++) {
      code = randomCode();
      try {
        await pool.query(
          `INSERT INTO invoice_links
             (code, purpose, scope_type, scope_value, order_no, expires_at, created_by, created_at)
           VALUES ($1, 'customer_invoice', 'customer_invoice', $2, $3, $4, $5, NOW())`,
          [code, scopeValue, view.order_no, expiresAt, user.uid || user.id || user.account || null]
        );
        break;
      } catch (e) {
        if (e.code !== "23505" || i === 4) throw e;
      }
    }
  }

  return json(res, 200, { code, url: `${PUBLIC_HOST}/ci/${code}`, expiresAt });
}

async function handleData(req, res) {
  const code = clean(req.query?.c);
  if (!rateLimit(req, code)) return json(res, 429, { error: "请求过于频繁，请稍后再试" });
  const pool = getPool();
  const link = await resolveLink(pool, code);
  if (!link || !link.order_no) return failClosed(res);
  const view = await buildCustomerInvoice(pool, link.order_no);
  if (!view) return failClosed(res);
  return json(res, 200, view);
}

// 从提交行计算价税合计（含税额权威，反推不含税/税额）。
function computeLines(rawLines) {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  let inclSum = 0;
  let exSum = 0;
  const norm = lines.map((l) => {
    const rate = Math.max(Number(l.tax_rate) || 0, 0);
    const incl = Math.round((Number(l.amount_incl) || 0) * 100) / 100;
    const ex = rate > 0 ? Math.round((incl / (1 + rate)) * 100) / 100 : incl;
    const tax = Math.round((incl - ex) * 100) / 100;
    inclSum += incl;
    exSum += ex;
    return {
      name: clean(l.name),
      spec: clean(l.spec),
      unit: clean(l.unit),
      qty: l.qty === "" || l.qty == null ? null : Number(l.qty),
      tax_rate: rate,
      tax_exempt: rate === 0,
      amount_incl: incl,
      amount_ex: ex,
      tax_amount: tax,
    };
  });
  inclSum = Math.round(inclSum * 100) / 100;
  exSum = Math.round(exSum * 100) / 100;
  return { lines: norm, amount_incl: inclSum, amount_ex: exSum, total_tax: Math.round((inclSum - exSum) * 100) / 100 };
}

async function upsertInvoice(pool, view, body, status) {
  const { lines, amount_incl, amount_ex, total_tax } = computeLines(body.lines);
  if (!lines.length) throw Object.assign(new Error("至少填一行发票明细"), { httpStatus: 400 });
  if (!(amount_incl > 0)) throw Object.assign(new Error("金额必须大于0"), { httpStatus: 400 });

  const topRate = lines.length ? lines[0].tax_rate : 0;
  const invoiceFormat = "official"; // 一套模板：电子发票(普通发票)，境内外共用
  // 真实发票号/开票日期在实际开出后由操作员回填；草稿阶段用占位号占住 NOT NULL 约束。
  const providedInvoiceNo = clean(body.invoice_no) || null;

  // 备注区（成交方式/汇率/合同协议号/贸易国/提运单号），操作员可覆盖默认值。
  const rf = body.remark_fields && typeof body.remark_fields === "object" ? body.remark_fields : {};
  const remarkFields = {
    trade_terms: clean(rf.trade_terms) || null,
    exchange_rate: rf.exchange_rate === "" || rf.exchange_rate == null ? null : Number(rf.exchange_rate),
    usd_ref: rf.usd_ref === "" || rf.usd_ref == null ? null : Number(rf.usd_ref),
    contract_no: clean(rf.contract_no) || view.contract_no || null,
    trade_country: clean(rf.trade_country) || null,
    bl_no: clean(rf.bl_no) || null,
  };
  const remarkParts = [];
  if (remarkFields.trade_terms) remarkParts.push(`成交方式：${remarkFields.trade_terms}`);
  if (remarkFields.usd_ref && remarkFields.exchange_rate) {
    remarkParts.push(`USD${remarkFields.usd_ref}  汇率${remarkFields.exchange_rate}`);
  }
  if (remarkFields.contract_no) remarkParts.push(`合同协议号：${remarkFields.contract_no}`);
  if (remarkFields.trade_country) remarkParts.push(`贸易国：${remarkFields.trade_country}`);
  if (remarkFields.bl_no) remarkParts.push(`提运单号：${remarkFields.bl_no}`);
  const remark = remarkParts.join("\n") || null;

  const raw = {
    order_no: view.order_no,
    contract_no: view.contract_no,
    customs_no: view.customs_no,
    is_domestic: view.is_domestic,
    amount_source: view.amount_source,
    customs_amount: view.customs_amount,
    line_items: lines,
    remark_fields: remarkFields,
    issuer: clean(body.issuer) || null,
    seller_company_code: view.seller?.code || null,
    buyer_customer_id: view.buyer?.id || null,
    updated_from: "customer_invoice_portal",
  };
  const contractNos = view.contract_no ? [view.contract_no] : [];
  const customsNos = view.customs_no ? [view.customs_no] : [];

  const existing = view.saved?.id
    ? { rows: [{ id: view.saved.id }] }
    : await pool.query(
        `SELECT id FROM finance_invoices_out
          WHERE source = 'customer_invoice' AND raw->>'order_no' = $1
          ORDER BY id DESC LIMIT 1`,
        [view.order_no]
      );

  // 确认(issued)时打开编辑期计时器；重新保存草稿不动这个时间戳。
  const reviewedAtSql = status === "issued" ? "NOW()" : "reviewed_at";

  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await pool.query(
      `UPDATE finance_invoices_out
          SET amount_ex_tax=$1, total_tax=$2, amount_incl_tax=$3, tax_rate=$4,
              currency=$5, remark=$6, raw=$7, review_status=$8, invoice_format=$9,
              buyer_name=$10, seller_name=$11, seller_company_code=$12, customer_id=$13,
              contract_nos=$14, customs_nos=$15,
              invoice_no=COALESCE($16, invoice_no), reviewed_at=${reviewedAtSql}, updated_at=NOW()
        WHERE id=$17`,
      [amount_ex, total_tax, amount_incl, topRate, view.currency, remark, JSON.stringify(raw),
       status, invoiceFormat, view.buyer?.name || null, view.seller?.name || null,
       view.seller?.code || null, view.buyer?.id || null, contractNos, customsNos,
       providedInvoiceNo, id]
    );
    return { id, updated: true };
  }

  const invoiceNo = providedInvoiceNo || `CI-DRAFT-${view.order_no}-${Date.now()}`;
  const issueDate = clean(body.issue_date) || null; // 缺省用 CURRENT_DATE（草稿占位，开出后回填真实日期）
  const ins = await pool.query(
    `INSERT INTO finance_invoices_out
       (invoice_no, issue_date, invoice_type, seller_name, seller_tax_id, seller_company_code,
        buyer_name, buyer_tax_id, customer_id,
        amount_ex_tax, total_tax, amount_incl_tax, tax_rate, currency,
        contract_nos, customs_nos, remark, source, raw, review_status, invoice_format, reviewed_at, created_at, updated_at)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), '普通发票', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, 'customer_invoice', $17, $18, $19, ${status === "issued" ? "NOW()" : "NULL"}, NOW(), NOW())
     RETURNING id`,
    [invoiceNo, issueDate, view.seller?.name || null, view.seller?.tax_id || null, view.seller?.code || null,
     view.buyer?.name || null, view.buyer?.tax_id || null, view.buyer?.id || null,
     amount_ex, total_tax, amount_incl, topRate, view.currency,
     contractNos, customsNos, remark, JSON.stringify(raw), status, invoiceFormat]
  );
  return { id: ins.rows[0].id, updated: false };
}

async function handleSaveOrConfirm(req, res, status) {
  const code = clean(req.query?.c);
  if (!rateLimit(req, code)) return json(res, 429, { error: "请求过于频繁，请稍后再试" });
  const pool = getPool();
  const link = await resolveLink(pool, code);
  if (!link || !link.order_no) return failClosed(res);
  const view = await buildCustomerInvoice(pool, link.order_no);
  if (!view) return failClosed(res);
  if (!view.can_invoice) return json(res, 400, { error: "买卖方开票信息未维护，暂不能开票" });
  if (view.saved?.locked) {
    return json(res, 403, {
      error: `发票已确认开票超过 ${EDIT_WINDOW_DAYS} 天，编辑期已过，已锁定只读。如需修改请联系财务作废重开。`,
    });
  }

  try {
    const r = await upsertInvoice(pool, view, req.body || {}, status);
    return json(res, 200, { ok: true, id: r.id, review_status: status });
  } catch (e) {
    return json(res, e.httpStatus || 500, { error: e.message || "保存失败" });
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const action = clean(req.query?.action);
    if (req.method === "GET" && action === "gen") return await handleGen(req, res);
    if (req.method === "GET") return await handleData(req, res);
    if (req.method === "POST" && action === "save") return await handleSaveOrConfirm(req, res, "draft");
    if (req.method === "POST" && action === "confirm") return await handleSaveOrConfirm(req, res, "issued");
    return json(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error("[customer-invoice]", err);
    return json(res, 500, { error: "Internal server error", detail: err.message });
  }
}
