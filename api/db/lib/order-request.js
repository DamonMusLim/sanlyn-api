import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const UPLOAD_ROOT = "/opt/sanlyn-uploads/order-request";
const BABI_CODE = "BABI";
const BABI_NAME = "厦门巴匕进出口有限公司";
const INTERNAL_ROLES = ["admin"];
const INTERNAL_UIDS = [91];
const FACTORY_ROLES = ["factory", "supplier"];
const CUSTOMER_ROLES = ["customer", "buyer"];
const FILE_EXTS = new Set([".pdf", ".xlsx", ".xls", ".jpg", ".jpeg", ".png"]);

export function isInternalUser(u) {
  return INTERNAL_ROLES.includes(String(u?.role || "").toLowerCase()) || INTERNAL_UIDS.includes(Number(u?.uid));
}

function userCodes(u) {
  return [u?.companyCode, ...(Array.isArray(u?.companyCodes) ? u.companyCodes : [])]
    .filter(Boolean).map((x) => String(x).trim().toUpperCase());
}

export function callerKind(user) {
  const role = String(user?.role || "").toLowerCase();
  if (isInternalUser(user)) return "internal";
  if (FACTORY_ROLES.includes(role)) return "factory";
  if (CUSTOMER_ROLES.includes(role)) return "customer";
  return "unknown";
}

export function orderRequestFormConfig(user) {
  const kind = callerKind(user);
  const common = ["lines", "requested_delivery", "container", "remarks", "files"];
  if (kind === "factory") return {
    channel: "factory", buyer: { fixed: true, companyCode: BABI_CODE, name: BABI_NAME },
    fields: [...common, "source", "factory_ready_date"], priceColumn: "last_factory_price",
  };
  if (kind === "internal") return {
    channel: "internal", buyer: { selectable: true }, fields: [...common, "buyer_company_code", "source"],
    priceColumn: "last_customer_price",
  };
  return {
    channel: "customer", buyer: { scope: userCodes(user) }, fields: [...common, "customer_po"],
    priceColumn: "last_customer_price",
  };
}

export function canAccessRequest(user, row) {
  const kind = callerKind(user);
  if (kind === "internal") return true;
  if (kind === "factory") {
    const own = userCodes(user);
    return row.channel === "factory" && own.includes(String(row.factory_company_code || "").trim().toUpperCase());
  }
  if (kind === "customer") {
    const own = userCodes(user);
    return row.channel !== "factory" && own.includes(String(row.buyer_company_code || "").trim().toUpperCase());
  }
  return false;
}

// 白名单：明确挑出每种身份该看的字段，其余（含将来新增）一律不返回
function publicLine(line, kind) {
  const out = { sku: line.sku, product_id: line.product_id, product_name: line.product_name,
    description: line.description, qty: line.qty, unit: line.unit };
  if (kind === "internal") { out.unit_price = line.unit_price ?? null; out.factory_price = line.factory_price ?? null; }
  else if (kind === "factory") { out.factory_price = line.factory_price ?? null; }   // 工厂只看自己价，⛔ 不看客户价
  else { out.unit_price = line.unit_price ?? null; }                                  // 客户只看自己价，⛔ 不看工厂价
  return out;
}
// extra：客户/工厂只看收货相关，⛔ 不看工厂最早交货等对方字段（内部看全部）
function publicExtra(extra, kind) {
  const e = extra || {};
  if (kind === "internal") return e;
  if (kind === "factory") return { factory_ready_date: e.factory_ready_date || null };
  return { consignee: e.consignee || "", delivery_address: e.delivery_address || "", destination_port: e.destination_port || "" };
}

export function sanitizeForAudience(row, user) {
  const kind = callerKind(user);
  const out = {
    id: row.id, channel: row.channel, status: row.status, source: row.source || "",
    buyer_company_code: row.buyer_company_code, requested_delivery: row.requested_delivery,
    customer_po: row.customer_po, container: row.container, remarks: row.remarks,
    lines: (row.lines || []).map((x) => publicLine(x, kind)),
    files: (row.files || []).map((f) => ({ name: f.name, size: f.size, mime: f.mime })), extra: publicExtra(row.extra, kind), return_reason: row.return_reason || "", created_at: row.created_at,
    updated_at: row.updated_at, formConfig: orderRequestFormConfig(user),
  };
  if (kind === "internal") Object.assign(out, {
    factory_company_code: row.factory_company_code, submitted_by_uid: row.submitted_by_uid,
    submitted_by_username: row.submitted_by_username, review: row.review || {}, order_no: row.order_no,
  });
  if (kind === "factory") {
    delete out.buyer_company_code; delete out.customer_po;
  }
  return out;
}

function normalizeLines(body, kind) {
  const rows = Array.isArray(body.products) ? body.products : (Array.isArray(body.lines) ? body.lines : []);
  const internal = kind === "internal";   // ⛔ 只有内部提交的行价可信；客户/工厂提交的价一律丢弃（防注入工厂价/客户价）
  return rows.slice(0, 200).map((p) => ({
    sku: String(p.sku || p.code || "").trim(), product_id: p.product_id || p.productId || null,
    product_name: p.productName || p.product_name || p.name || "",
    description: p.description || "", qty: p.qty || p.quantity || "", unit: p.unit || "CTN",
    unit_price: internal ? (p.unitPrice ?? p.unit_price ?? null) : null,
    factory_price: internal ? (p.factoryPrice ?? p.factory_price ?? null) : null,
  })).filter((p) => p.sku || p.product_name || p.description);
}

function assertBuyerScope(user, buyer) {
  const kind = callerKind(user);
  if (kind === "internal") return;
  if (kind === "factory") {
    if (String(buyer || "").toUpperCase() !== BABI_CODE) throw Object.assign(new Error("buyer_forbidden"), { status: 403 });
    return;
  }
  const own = userCodes(user);
  if (!buyer || !own.includes(String(buyer).toUpperCase())) throw Object.assign(new Error("buyer_out_of_scope"), { status: 403 });
}

// 调内部接口用的 2 分钟服务令牌（⛔ 别用 generateToken：exp 10 年）
function shortServiceToken(payload, ttlSec = 120) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET 未设置");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ ...payload, iat: now, exp: now + ttlSec });
  return head + "." + crypto.createHmac("sha256", secret).update(head).digest("base64url");
}

// GET ?id=&file=<index>：下载原件，归属校验与详情相同
export async function handleOrderRequestFile(req, res, pool) {
  const rows = await listRows(pool, req.user, req.query?.id);
  const row = rows[0];
  if (!row || !canAccessRequest(req.user, row)) return res.status(404).json({ ok: false, error: "not_found" });
  const f = (row.files || [])[Number(req.query?.file)];
  if (!f || !f.url) return res.status(404).json({ ok: false, error: "not_found" });
  const full = path.join(UPLOAD_ROOT, row.id, path.basename(String(f.url)));
  if (!full.startsWith(path.join(UPLOAD_ROOT, row.id) + path.sep)) return res.status(404).json({ ok: false, error: "not_found" });
  try {
    const buf = await fs.readFile(full);
    res.setHeader("Content-Type", f.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.name || "file")}`);
    return res.end(buf);
  } catch { return res.status(404).json({ ok: false, error: "not_found" }); }
}

function requestId() {
  return "or_" + crypto.randomBytes(16).toString("hex");
}

async function saveFiles(id, files) {
  if (!files?.length) return [];
  if (files.length > 5) throw Object.assign(new Error("too_many_files"), { status: 400 });
  const dir = path.join(UPLOAD_ROOT, id);
  await fs.mkdir(dir, { recursive: true });
  const saved = [];
  for (const f of files) {
    const ext = path.extname(f.originalFilename || f.name || "").toLowerCase();
    if (!FILE_EXTS.has(ext)) throw Object.assign(new Error("file_type_not_allowed"), { status: 400 });
    if (Number(f.size || 0) > 10 * 1024 * 1024) throw Object.assign(new Error("file_too_large"), { status: 400 });
    const base = path.basename(f.originalFilename || f.name || ("file" + ext)).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 120);
    const name = Date.now() + "-" + crypto.randomBytes(4).toString("hex") + "-" + base;
    await fs.copyFile(f.filepath || f.path, path.join(dir, name));
    saved.push({ name: base, size: f.size || 0, mime: f.mimetype || f.type || "", url: `/uploads/order-request/${id}/${name}` });
  }
  return saved;
}

async function upsertTask(pool, row) {
  // 测试公司（TEST-*，越权测试专用）不给艾莎建任务，免得刷屏
  if ([row.buyer_company_code, row.factory_company_code].some((c) => /^TEST-/i.test(String(c || "")))) return;
  const title = `订单申请待审核 ${row.buyer_company_code || ""}`.slice(0, 100);
  await pool.query(
    `INSERT INTO tasks (id,title,task_type,level,status,domain,priority,assigned_staff_no,
      company_code,source,dedupe_key,due_at,reason,next_action,raw,created_at,updated_at)
     VALUES ($1,$2,'订单申请审核','L3','open','外贸','p1','WM-01',$3,'order-request',$4,
      NOW()+interval '1 day',$5,$6,$7::jsonb,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET status='open', title=EXCLUDED.title, updated_at=NOW()`,
    [`order-request-${row.id}`, title, row.buyer_company_code || "", `order-request:${row.id}`,
     "客户/内部/工厂提交了订单申请，需审核后建正式订单", "打开订单申请审核并确认/退回",
     JSON.stringify({ request_id: row.id, channel: row.channel })]);
}

export async function handleOrderRequestCreate(req, res, pool, parsedFiles = []) {
  const user = req.user;
  const kind = callerKind(user);
  if (!["customer", "internal", "factory"].includes(kind)) return res.status(403).json({ ok: false, error: "role_not_allowed" });
  const b = req.body || {};
  const id = requestId();
  const buyer = kind === "factory" ? BABI_CODE : String(b.companyCode || b.buyer_company_code || "").trim().toUpperCase();
  assertBuyerScope(user, buyer);
  const factory = kind === "factory" ? userCodes(user)[0] : (b.factoryCompanyCode || b.factory_company_code || "");
  const lines = normalizeLines(b, kind);
  if (!lines.length) return res.status(400).json({ ok: false, error: "lines_required" });
  const files = await saveFiles(id, parsedFiles);
  const row = (await pool.query(
    `INSERT INTO order_request (id,channel,buyer_company_code,factory_company_code,submitted_by_uid,
      submitted_by_username,source,status,lines,requested_delivery,customer_po,container,remarks,files,extra,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'submitted',$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14::jsonb,NOW(),NOW()) RETURNING *`,
    [id, kind, buyer, factory || null, user?.uid || user?.id || null, user?.username || user?.name || "",
     b.source || "portal", JSON.stringify(lines), b.requiredArrivalDate || b.requested_delivery || null,
     b.customerPO || b.customer_po || null, b.container || b.containerType || "", b.remarks || "", JSON.stringify(files),
     // 客户门户下单页带的收货信息 + 工厂最早可交货日；工厂那一路 ⛔ 不收任何买方/收货人信息
     JSON.stringify(kind === "factory" ? { factory_ready_date: b.factory_ready_date || null }
       : { consignee: b.consignee || "", delivery_address: b.deliveryAddress || "", destination_port: b.destinationPort || "" })])).rows[0];
  await upsertTask(pool, row);
  return res.status(200).json({ ok: true, request: sanitizeForAudience(row, user) });
}

async function listRows(pool, user, id) {
  const kind = callerKind(user);
  if (!["customer", "internal", "factory"].includes(kind)) throw Object.assign(new Error("role_not_allowed"), { status: 403 });
  const params = [];
  let where = id ? "WHERE id=$1" : "WHERE true";
  if (id) params.push(id);
  if (kind === "customer") { params.push(userCodes(user)); where += ` AND channel <> 'factory' AND upper(btrim(buyer_company_code)) = ANY($${params.length}::text[])`; }
  if (kind === "factory") { params.push(userCodes(user)); where += ` AND channel='factory' AND upper(btrim(factory_company_code)) = ANY($${params.length}::text[])`; }
  const r = await pool.query(`SELECT * FROM order_request ${where} ORDER BY created_at DESC LIMIT 100`, params);
  return r.rows;
}

async function priceRefs(pool, user, buyerCode, factoryCode, lines) {
  const skus = lines.map((x) => x.sku).filter(Boolean);
  if (!skus.length) return [];
  const factoryMode = callerKind(user) === "factory";
  const sql = factoryMode
    ? `SELECT DISTINCT ON (li.sku) li.sku, li.factory_price AS price
         FROM order_line_items li JOIN orders o ON o.id=li.order_id JOIN companies fc ON fc.id=o.factory_company_id
        WHERE li.sku=ANY($1::text[]) AND upper(fc.code)=upper($2)
        ORDER BY li.sku,o.created_at DESC`
    : `SELECT DISTINCT ON (li.sku) li.sku, li.unit_price AS price
         FROM order_line_items li JOIN orders o ON o.id=li.order_id
        WHERE li.sku=ANY($1::text[]) AND o.company_code=$2 ORDER BY li.sku,o.created_at DESC`;
  const params = factoryMode ? [skus, factoryCode] : [skus, buyerCode];
  // ⛔ 不回 order_no：工厂不许看我方单号；客户单号带客户编号（40-LL-9）也不外露
  return (await pool.query(sql, params).catch(() => ({ rows: [] }))).rows.map((r) => ({
    sku: r.sku, label: r.price == null ? "To be quoted / 待报价" : String(r.price),
  }));
}

// GET /order-request/form?buyer=：开新申请时的表单 = 字段配置 + 可选产品（下过的）+ 上票价
//   客户：buyer 必须 ∈ 本人 companyCodes；工厂：只按本厂（orders.factory_company_id），⛔ 不回任何买方/终端客户信息；内部：可选任意客户
export async function handleOrderRequestForm(req, res, pool) {
  const user = req.user, kind = callerKind(user);
  if (!["customer", "internal", "factory"].includes(kind)) return res.status(403).json({ ok: false, error: "role_not_allowed" });
  const formConfig = orderRequestFormConfig(user);
  if (kind === "factory") {
    const r = await pool.query(
      `SELECT DISTINCT ON (li.sku) li.sku, COALESCE(NULLIF(li.product_name,''), p.product_name) AS name, p.bg_bx AS pack, li.factory_price AS last_price
         FROM order_line_items li JOIN orders o ON o.id = li.order_id JOIN companies fc ON fc.id = o.factory_company_id
         LEFT JOIN products p ON p.id = li.product_id
        WHERE upper(fc.code) = ANY($1::text[]) AND NULLIF(li.sku,'') IS NOT NULL AND o.created_at > NOW() - interval '3 years'
        ORDER BY li.sku, o.created_at DESC LIMIT 300`, [userCodes(user)]);
    return res.json({ ok: true, formConfig, products: r.rows });
  }
  const codes = userCodes(user);
  const buyer = String(req.query?.buyer || (kind === "customer" ? codes[0] : "") || "").trim().toUpperCase();
  if (kind === "customer" && !codes.includes(buyer)) return res.status(403).json({ ok: false, error: "buyer_out_of_scope" });
  const out = { ok: true, formConfig, buyer };
  if (kind === "internal") out.buyers = (await pool.query(
    `SELECT code, COALESCE(NULLIF(name_en,''), name_cn, code) AS name FROM companies
      WHERE type = 'customer' AND COALESCE(active, true) ORDER BY code LIMIT 500`)).rows;
  if (kind === "customer") out.buyers = (await pool.query(
    `SELECT code, COALESCE(NULLIF(name_en,''), name_cn, code) AS name FROM companies WHERE upper(code) = ANY($1::text[])`, [codes])).rows;
  out.products = buyer ? (await pool.query(
    `SELECT DISTINCT ON (li.sku) li.sku, COALESCE(NULLIF(li.product_name,''), p.product_name) AS name, p.bg_bx AS pack, li.unit_price AS last_price
       FROM order_line_items li JOIN orders o ON o.id = li.order_id LEFT JOIN products p ON p.id = li.product_id
      WHERE o.company_code = $1 AND NULLIF(li.sku,'') IS NOT NULL AND o.created_at > NOW() - interval '3 years'
      ORDER BY li.sku, o.created_at DESC LIMIT 300`, [buyer])).rows : [];
  return res.json(out);
}

export async function handleOrderRequestList(req, res, pool) {
  const rows = await listRows(pool, req.user, null);
  return res.json({ ok: true, requests: rows.map((r) => sanitizeForAudience(r, req.user)) });
}

export async function handleOrderRequestGet(req, res, pool) {
  const rows = await listRows(pool, req.user, req.query?.id);
  const row = rows[0];
  if (!row || !canAccessRequest(req.user, row)) return res.status(404).json({ ok: false, error: "not_found" });
  const data = sanitizeForAudience(row, req.user);
  data.priceRefs = await priceRefs(pool, req.user, row.buyer_company_code, row.factory_company_code, row.lines || []);
  return res.json({ ok: true, request: data });
}

async function loadInternal(pool, user, id) {
  if (!isInternalUser(user)) throw Object.assign(new Error("internal_only"), { status: 403 });
  const row = (await pool.query(`SELECT * FROM order_request WHERE id=$1`, [id])).rows[0];
  if (!row) throw Object.assign(new Error("not_found"), { status: 404 });
  return row;
}

export async function handleOrderRequestReview(req, res, pool) {
  const id = req.body?.id;
  const row = await loadInternal(pool, req.user, id);
  const review = req.body?.review || {};
  const updated = (await pool.query(
    `UPDATE order_request SET status='reviewing', review=$2::jsonb, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [row.id, JSON.stringify(review)])).rows[0];
  return res.json({ ok: true, request: sanitizeForAudience(updated, req.user) });
}

export async function handleOrderRequestReturn(req, res, pool) {
  const id = req.body?.id;
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ ok: false, error: "reason_required" });
  const row = await loadInternal(pool, req.user, id);
  if (row.status === "confirmed") return res.status(409).json({ ok: false, error: "status_confirmed" });
  const updated = (await pool.query(
    `UPDATE order_request SET status='returned', return_reason=$2, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [row.id, reason])).rows[0];
  return res.json({ ok: true, request: sanitizeForAudience(updated, req.user) });
}

function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = () => {};
  r.end = () => r;
  return r;
}

export async function handleOrderRequestConfirm(req, res, pool) {
  if (!isInternalUser(req.user)) return res.status(403).json({ ok: false, error: "internal_only" });   // ⛔ 建单只限内部（原 loadInternal 的闸，别在抢占前丢了）
  const claim = await pool.query(
    `UPDATE order_request SET status='confirming', updated_at=NOW()
      WHERE id=$1 AND status IN ('submitted','reviewing') RETURNING *`, [req.body?.id]);
  if (!claim.rows.length) {
    const cur = (await pool.query(`SELECT status FROM order_request WHERE id=$1`, [req.body?.id])).rows[0];
    return res.status(cur ? 409 : 404).json({ ok: false, error: cur ? "status_" + cur.status : "not_found" });
  }
  const row = claim.rows[0];
  const review = req.body?.review || row.review || {};
  const products = (Array.isArray(review.products) && review.products.length) ? review.products : (row.lines || []);
  if (!products.length || products.some((p) => p.factoryPrice == null && p.factory_price == null)) {
    return res.status(409).json({ ok: false, error: "factory_price_required" });
  }
  const body = { ...review, companyCode: row.buyer_company_code, products,
    customerPO: row.customer_po, requiredArrival: row.requested_delivery,
    containerType: row.container, remarks: row.remarks, source: "order-request",
    createdBy: req.user?.username || "order-request" };
  const [{ default: orderCreateHandler }, { handleSendLink }] = await Promise.all([
    import("../order-create-v2.js"),
    import("./po-collab-handlers.js"),
  ]);
  const svcToken = shortServiceToken({ uid: 90, username: "svc-agent", role: "admin", company_code: null });
  const ocReq = { ...req, method: "POST", url: "/api/db/order-create-v2", query: {}, body,
    headers: { ...(req.headers || {}), authorization: "Bearer " + svcToken } };
  const ocRes = fakeRes();
  await orderCreateHandler(ocReq, ocRes);
  if (ocRes.statusCode >= 400 || !ocRes.body?.success) {
    await pool.query(`UPDATE order_request SET status='reviewing', updated_at=NOW() WHERE id=$1`, [row.id]).catch(() => {});
    return res.status(409).json({ ok: false, error: "order_create_failed", detail: ocRes.body?.error || "" });
  }
  const orderNo = ocRes.body.order_no || ocRes.body.order?.order_no;
  const updated = (await pool.query(
    `UPDATE order_request SET status='confirmed', order_no=$2, review=$3::jsonb, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [row.id, orderNo, JSON.stringify(review)])).rows[0];
  const linkReq = { ...req, method: "POST", body: { order_no: orderNo, qc_required: false },
    headers: { ...(req.headers || {}), authorization: "Bearer " + svcToken } };
  await handleSendLink(linkReq, fakeRes(), pool).catch((e) => console.warn("[order-request] po collab draft failed:", e.message));
  return res.json({ ok: true, order_no: orderNo, request: sanitizeForAudience(updated, req.user) });
}
