// api/db/factory-portal.js
// 工厂进项票短码门户（路由 + 鉴权 + 编排层）：
//   GET  /api/db/factory-portal?action=gen&factory_code=XXX  管理员生成/复用短码
//   GET  /api/db/factory-portal?c=CODE                     工厂打开短码，查看缺料
//   POST /api/db/factory-portal?c=CODE&action=upload        工厂上传进项票，落 pending
//
// 设计边界：
//   - gen 必须校验内部 admin/company JWT，不能公开 mint。
//   - resolve/upload 只凭短码，短码无效或过期统一 401 fail-closed。
//   - 缺料查询按 factory_code 优先，同时用 companies 映射中文名后兜底 orders.factory。
//
// 分层（遵守单文件 ≤500 行铁律）：
//   - factory-portal-utils.js  共享原子工具
//   - factory-invoice-gaps.js  缺料/工厂信息读查询层
//   - factory-invoice-upload.js 文件接收 + 持久化层
//   - factory-invoice-ocr.js    增值税票 OCR

import crypto from "crypto";
import { getPool } from "../db.js";
import { verifyToken } from "../auth.js";
import { cleanString, cleanArray } from "./factory-portal-utils.js";

function normalizeSellerName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）【】\[\]{}《》<>]/g, "")
    .replace(/[·.,，。;；:：'"“”‘’_-]/g, "")
    .replace(/有限责任公司|股份有限公司|有限公司|公司|工厂|厂/g, "");
}

function sellerNameMatches(expected, actual) {
  const a = normalizeSellerName(expected);
  const b = normalizeSellerName(actual);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}
import { getFactoryInfo, fetchGaps, fetchUploaded } from "./factory-invoice-gaps.js";
import { readUploadPayload, validateFile, uploadToOss, insertFinanceInvoice } from "./factory-invoice-upload.js";
import { ocrInvoice } from "./factory-invoice-ocr.js";

export const config = { api: { bodyParser: false } };

const PUBLIC_HOST = process.env.PUBLIC_HOST || "https://api.sanlyn.cn";
const LINK_TTL_DAYS = 60;
const CODE_LEN = 12;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 30;

const rateBuckets = new Map();

function setCors(req, res, methods = "GET, POST, OPTIONS") {
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
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function failClosed(res) {
  return json(res, 401, { error: "链接无效或已过期" });
}

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

  // 支持：
  //   Authorization: Bearer <jwt>
  //   Authorization: sanlyn_jwt <jwt>
  //   Authorization: sanlyn_jwt=<jwt>
  //   Authorization: Bearer sanlyn_jwt=<jwt>
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
  const token = extractSanlynJwt(req);
  const user = verifyToken(token);
  if (!user || !["admin", "company"].includes(user.role)) {
    json(res, 401, { error: "Unauthorized", message: "admin JWT required" });
    return null;
  }
  return user;
}

async function resolveFactoryScope(pool, code) {
  if (!code) return null;
  const r = await pool.query(
    `SELECT code, scope_type, scope_value, expires_at
       FROM invoice_links
      WHERE code = $1
        AND purpose = 'portal'
        AND scope_type = 'factory'
        AND expires_at > NOW()
      LIMIT 1`,
    [code]
  );
  const link = r.rows[0];
  if (!link || !link.scope_value) return null;
  const factory = await getFactoryInfo(pool, link.scope_value);
  if (!factory) return null;
  return { link, factory };
}

async function handleGen(req, res) {
  const user = requireAdminJwt(req, res);
  if (!user) return;

  const factoryCode = cleanString(req.query?.factory_code);
  if (!factoryCode) return json(res, 400, { error: "factory_code required" });

  const pool = getPool();
  const factory = await getFactoryInfo(pool, factoryCode);
  if (!factory) return json(res, 404, { error: "factory not found" });

  const reusable = await pool.query(
    `SELECT code, expires_at
       FROM invoice_links
      WHERE purpose = 'portal'
        AND scope_type = 'factory'
        AND scope_value = $1
        AND expires_at > NOW() + INTERVAL '1 day'
      ORDER BY expires_at DESC
      LIMIT 1`,
    [factoryCode]
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
             (code, purpose, scope_type, scope_value, expires_at, created_by, created_at)
           VALUES
             ($1, 'portal', 'factory', $2, $3, $4, NOW())`,
          [code, factoryCode, expiresAt, user.uid || user.id || user.account || null]
        );
        break;
      } catch (e) {
        if (e.code !== "23505" || i === 4) throw e;
      }
    }
  }

  return json(res, 200, {
    code,
    url: `${PUBLIC_HOST}/fc/${code}`,
    expiresAt,
  });
}

async function handlePortalData(req, res) {
  const code = cleanString(req.query?.c);
  if (!rateLimit(req, code)) return json(res, 429, { error: "请求过于频繁，请稍后再试" });

  const pool = getPool();
  const scope = await resolveFactoryScope(pool, code);
  if (!scope) return failClosed(res);

  const gaps = await fetchGaps(pool, scope.factory.code, scope.factory.name);
  const uploaded = await fetchUploaded(pool, scope.factory.code);

  return json(res, 200, {
    factory: scope.factory,
    gaps,
    uploaded,
  });
}

async function handleUpload(req, res, preScope) {
  const code = cleanString(req.query?.c);
  if (!rateLimit(req, code || "mt")) return json(res, 429, { error: "请求过于频繁，请稍后再试" });

  const pool = getPool();
  const scope = preScope || await resolveFactoryScope(pool, code);
  if (!scope) return failClosed(res);

  const { fields, file } = await readUploadPayload(req);
  const err = validateFile(file);
  if (err) return json(res, 400, { error: err });

  const contractNos = cleanArray(fields.contract_no || fields.contract_nos || fields.contractNos);
  const customsNos = cleanArray(fields.customs_no || fields.customs_nos || fields.customsNos);
  if (!contractNos.length && !customsNos.length) return json(res, 400, { error: "contract_no or customs_no required" });

  const gaps = await fetchGaps(pool, scope.factory.code, scope.factory.name);
  const gap = gaps.find((g) =>
    (g.contract_no && contractNos.includes(g.contract_no)) ||
    (g.customs_no && customsNos.includes(g.customs_no))
  );
  if (gap && !gap.can_invoice) return json(res, 400, { error: "开票信息未维护，暂不能上传" });

  const targetIncl = Number(gap?.total_incl || gap?.amount_incl_tax || 0) || 0;
  const oss = await uploadToOss(scope.factory.code, "OCR_UPLOAD", file);
  const attachments = [{
    url: oss.url,
    key: oss.key,
    name: file.fileName,
    mime: file.mime,
    size: file.size,
    uploaded_at: new Date().toISOString(),
  }];

  let ocr = null;
  let ocrError = null;
  try {
    ocr = await ocrInvoice(file);
  } catch (e) {
    ocrError = e;
  }

  const parsed = ocr?.parsed || {};
  const amountInclTax = parsed.amount_incl_tax;
  const sellerExpected = scope.factory.name;
  const sellerOcr = cleanString(parsed.seller_name);
  const sellerMismatch = !!sellerOcr && !sellerNameMatches(sellerExpected, sellerOcr);
  let reviewStatus = "pending";
  let warning = "";
  let needsManualReview = false;
  if (!ocr || !parsed.invoice_no || amountInclTax === null) {
    reviewStatus = "ocr_failed";
    needsManualReview = true;
    warning = "识别失败，已存档待人工录入";
  } else if (targetIncl > 0 && amountInclTax !== null && amountInclTax > targetIncl + 1) {
    reviewStatus = "over_issued";
    needsManualReview = true;
    warning = "金额超报关额，请核实";
  } else if (targetIncl > 0 && amountInclTax !== null && amountInclTax < targetIncl - 1) {
    reviewStatus = "under_issued";
    needsManualReview = true;
    warning = "金额低于报关额，请核实";
  }

    if (sellerMismatch) {
    if (reviewStatus === "pending") reviewStatus = "seller_mismatch";
    needsManualReview = true;
    warning = warning ? `${warning}；卖方与工厂不一致，请核实` : "卖方与工厂不一致，请核实";
  }
  const ocrParsed = sellerMismatch
    ? { ...parsed, seller_expected: sellerExpected, seller_ocr: sellerOcr }
    : parsed;
  const invoiceNo = parsed.invoice_no || `OCR_PENDING_${Date.now()}`;
  const id = await insertFinanceInvoice(pool, {
    invoiceNo,
    invoiceCode: parsed.invoice_code,
    issueDate: parsed.issue_date,
    sellerName: parsed.seller_name || scope.factory.name,
    sellerTaxId: parsed.seller_tax_id || null,
    buyerName: parsed.buyer_name || null,
    buyerTaxId: parsed.buyer_tax_id || null,
    factoryCode: scope.factory.code,
    amountExTax: parsed.amount_ex_tax,
    totalTax: parsed.total_tax,
    amountInclTax,
    taxRate: Number.isFinite(parsed.tax_rate) ? parsed.tax_rate : null,
    contractNos,
    customsNos,
    reviewStatus,
    attachments,
    lineItems: gap?.invoice_lines || [],
    raw: {
      portal_code: code,
      oss,
      file_name: file.fileName,
      uploaded_from: "factory_portal",
      ocr_model: "MiniMax-M3",
      ocr_raw: ocr?.rawText || null,
      ocr_parsed: ocrParsed,
      ocr_error: ocrError ? ocrError.message : null,
      target_amount_incl_tax: targetIncl || null,
      needs_manual_review: needsManualReview,
      seller_expected: sellerMismatch ? sellerExpected : null,
      seller_ocr: sellerMismatch ? sellerOcr : null,
      seller_mismatch: sellerMismatch,
    },
  });

  return json(res, 200, {
    ok: true,
    id,
    review_status: reviewStatus,
    invoice_no: invoiceNo,
    invoice_code: parsed.invoice_code || null,
    issue_date: parsed.issue_date || null,
    amount_ex_tax: parsed.amount_ex_tax,
    total_tax: parsed.total_tax,
    amount_incl_tax: amountInclTax,
    tax_rate: Number.isFinite(parsed.tax_rate) ? parsed.tax_rate : null,
    needs_manual_review: needsManualReview,
    warning,
    oss_url: oss.url,
  });
}

// === collab magic token 入口：复用 booking-collab 同一张 token 的工厂 scope（不另发短码）===
async function resolveFactoryByMt(pool, mt) {
  if (!mt) return null;
  const hash = crypto.createHash("sha256").update(String(mt)).digest("hex");
  const r = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1 AND recipient_role = 'factory_booking'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [hash]
  );
  if (!r.rows.length) return null;
  let meta = r.rows[0].meta;
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch (_) { meta = {}; } }
  const label = String(meta?.factory_scope?.label || "").trim();
  if (!label) return null; // fail-closed：无 scope 不返回任何数据
  const c = await pool.query(
    `SELECT code, name_cn, factory_name FROM companies
      WHERE code = $1 OR name_cn ILIKE '%'||$1||'%' OR factory_name ILIKE '%'||$1||'%'
      ORDER BY CASE WHEN code=$1 THEN 0 WHEN name_cn=$1 THEN 1 WHEN factory_name=$1 THEN 2 ELSE 9 END, id ASC
      LIMIT 1`,
    [label]
  );
  if (!c.rows.length || !c.rows[0].code) return null;
  const row = c.rows[0];
  return { factory: { code: row.code, name: row.name_cn || row.factory_name || label } };
}

async function handleMtData(req, res, scope) {
  const pool = getPool();
  const gaps = await fetchGaps(pool, scope.factory.code, scope.factory.name);
  const uploaded = await fetchUploaded(pool, scope.factory.code);
  return json(res, 200, { factory: scope.factory, gaps, uploaded });
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const action = cleanString(req.query?.action);

    // collab token 入口（财务板块走这条，复用一票一链的 scope）
    const mt = cleanString(req.query?.mt);
    if (mt) {
      const pool = getPool();
      const mtScope = await resolveFactoryByMt(pool, mt);
      if (!mtScope) return failClosed(res);
      if (req.method === "POST" && action === "upload") return await handleUpload(req, res, mtScope);
      if (req.method === "GET") return await handleMtData(req, res, mtScope);
      return json(res, 405, { error: "Method not allowed" });
    }

    if (req.method === "GET" && action === "gen") return await handleGen(req, res);
    if (req.method === "GET") return await handlePortalData(req, res);
    if (req.method === "POST" && action === "upload") return await handleUpload(req, res);

    return json(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error("[factory-portal]", err);
    return json(res, 500, { error: "Internal server error", detail: err.message });
  }
}
