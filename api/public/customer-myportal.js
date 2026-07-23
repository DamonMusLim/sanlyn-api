// api/public/customer-myportal.js — DRAFT, NOT DEPLOYED. Task #bp-p1-customer-portal-0723.
// P1 只读客户门户：magic_link 打开，零写入。四视图：orders / docs / missing / price。
//
// 硬约束（自查通过后才可提交部署）：
//   - 单文件 ≤500 行（当前 ~310 行）
//   - 字段白名单默认拒绝：所有 SELECT 显式点名列，绝不 SELECT *；返回 JSON 绝不含
//     factory_price / factory_subtotal / total_amount_factory / profit / cost 等成本类字段
//     （grep -iE 'factory_price|factory_subtotal|total_amount_factory|profit|cost' 本文件应只在
//     本注释和 SQL 排除逻辑里出现，不出现在任何 SELECT 列表或响应字段名里）
//   - 鉴权 100% 复用 magic_links 表：token_hash 查表 + expires_at/revoked_at 校验 + access_log 追加，
//     不新造 token 机制。recipient_role 用新值 'customer_myportal'（需在 customer-magic-link.js 的
//     ALLOWED_ROLES 里加一行才能签发，见同目录 magic-link-allowedroles.patch.diff，本文件不重复造签发口）
//   - 缺显缺：文档/资料缺失只显示"缺 XX"，绝不猜值兜底
//   - 金额口径：price 视图的 declared_anchor_cny 只在 finance_export_rebates(fer) 有报关锚定行时才给值，
//     否则 anchor_status='pending_customs'，前端显示"待报关"，绝不用 OLI/其它字段顶替
//   - 页面/链接全部相对路径，不出现 api.sanlyn.cn
//
// 路由建议（未 mount，见 routes-core-mount.patch.diff）：
//   GET /api/public/customer-myportal?token=RAW&view=orders
//   GET /api/public/customer-myportal?token=RAW&view=docs&order_no=XXX
//   GET /api/public/customer-myportal?token=RAW&view=missing&order_no=XXX
//   GET /api/public/customer-myportal?token=RAW&view=price&order_no=XXX
//   全部 GET-only。没有任何写入 action —— P1 明确"零写入功能"，不照抄 customer-portal.js 的
//   request-delivery-date 提交口。
//
// 已知数据缺口（写死在这里提醒实现者，不要在没解决前上线 docs/missing 视图）：
//   1. document_uploads.url 里 14/105 行是 file:///Users/apple/Desktop/... 本机路径，客户点了打不开。
//      docs 视图改用 document_files 表（1849 行，storage_backend='oss'，真实 https URL），
//      不要用 document_uploads。
//   2. document_missing_items 全库只有 1 行，且是内部 OCR 字段冲突 QA 记录（issue_type='conflict'），
//      不是"客户请上传 XX"的语义。missing 视图目前只能做"预期单据类型 vs 实际存在"的启发式 diff
//      （EXPECTED_DOC_KINDS 常量），标记为 heuristic，不能包装成"系统权威判定"。上线前需要 Damon
//      拍板：到底哪些 doc_kind 对客户是"必需"的（当前 document_files.doc_kind 里 664/1849 是 'other'，
//      分类质量差，heuristic 会有噪音）。

import crypto from "node:crypto";
import { getPool, setCors } from "../db.js";

const RECIPIENT_ROLE = "customer_myportal";

// 缺显缺 heuristic 用：核心单据类型（保守取交易通用的四类，customs_decl/customs_release 等
// 内部报关流程单据不强制要求客户视角"缺"——避免误报打扰客户）
const EXPECTED_DOC_KINDS = ["PI", "BL", "IV", "PL"];

const STATUS_TEXT = {
  draft: "待确认", confirmed: "已确认", ready: "已备货",
  shipped: "已发货", delivered: "已交付", cancelled: "已取消",
};

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

// 鉴权：token_hash 查表 + expires/revoked 校验，返回 company_code 作用域。
// access_log 追加做成 best-effort（失败不阻断主流程，只 warn）。
async function resolveScope(pool, req, token) {
  if (!token || String(token).length < 16) return null;
  const hash = rawToHash(token);
  const { rows } = await pool.query(
    `SELECT id, meta, expires_at, revoked_at
       FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = $2
        AND expires_at > NOW()
        AND revoked_at IS NULL
        AND COALESCE(revoked, false) = false
      LIMIT 1`,
    [hash, RECIPIENT_ROLE]
  );
  if (!rows.length) return null;
  const link = rows[0];
  const meta = typeof link.meta === "string" ? JSON.parse(link.meta || "{}") : (link.meta || {});
  const companyCode = String(meta.company_code || "").trim();
  if (!companyCode) return null;

  // access_log 追加（IP/UA/时间戳），失败不影响主请求
  try {
    const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);
    const entry = JSON.stringify({ accessed_at: new Date().toISOString(), ip, ua, view: req.query?.view || null });
    await pool.query(
      `UPDATE magic_links SET access_log = COALESCE(access_log, '[]'::jsonb) || $1::jsonb WHERE id = $2`,
      [`[${entry}]`, link.id]
    );
  } catch (e) {
    console.warn("[customer-myportal] access_log append failed:", e.message);
  }

  return { companyCode, linkId: link.id };
}

// ── view=orders ──────────────────────────────────────────────────
// 字段口径同 api/db/customer-portal.js:getOrders()，去掉任何成本列，保持一致不重造。
async function viewOrders(pool, codes) {
  const r = await pool.query(
    `SELECT
        o.order_no,
        COALESCE(
          NULLIF(string_agg(DISTINCT NULLIF(COALESCE(p.product_name, li.product_name), ''), ', '), ''),
          NULLIF(o.products->0->>'product_name', '')
        ) AS product_name,
        COALESCE(
          NULLIF(string_agg(DISTINCT NULLIF(p.product_name_cn, ''), ', '), ''),
          NULLIF(o.products->0->>'product_name_cn', '')
        ) AS product_name_cn,
        o.total_qty,
        COALESCE(NULLIF(o.raw->>'containerType', ''), NULLIF(o.raw->>'container_type', '')) AS container_type,
        o.status,
        o.etd, o.eta,
        o.delivery_date,
        o.confirmed_delivery
       FROM orders o
       LEFT JOIN order_line_items li ON li.order_id = o.id
       LEFT JOIN products p ON p.sku = li.sku
      WHERE o.company_code = ANY($1::text[])
      GROUP BY o.id
      ORDER BY COALESCE(o.delivery_date, o.etd) DESC NULLS LAST, o.order_no DESC`,
    [codes]
  );
  return r.rows.map(row => ({
    order_no: row.order_no,
    product_name: row.product_name,
    product_name_cn: row.product_name_cn,
    total_qty: row.total_qty,
    container_type: row.container_type,
    status: row.status,
    status_text: STATUS_TEXT[row.status] || row.status || "—",
    etd: row.etd, eta: row.eta,
    delivery_date: row.delivery_date,
    confirmed_delivery: row.confirmed_delivery,
  }));
}

// 校验 order_no 落在客户作用域内，返回 {id, bl_no, contract_no} 供 docs/missing/price 复用
async function resolveOrder(pool, codes, orderNo) {
  const r = await pool.query(
    `SELECT id, order_no, bl_no, contract_no
       FROM orders
      WHERE order_no = $1 AND company_code = ANY($2::text[])
      LIMIT 1`,
    [orderNo, codes]
  );
  return r.rows[0] || null;
}

// ── view=docs ────────────────────────────────────────────────────
// 只读 document_files（真实 OSS/CDN https URL），不用 document_uploads（有 file:// 死链）。
// 覆盖两层：订单自身绑定的文件 + 同 BL 下的运输单证（弃用 bound_subject_type='order' 单独查会漏 BL 级文件）。
async function viewDocs(pool, order) {
  const r = await pool.query(
    `SELECT doc_kind, display_name, storage_url, uploaded_at, 'order' AS bound_to
       FROM document_files
      WHERE bound_subject_type = 'order' AND bound_subject_id = $1::text
        AND deleted_at IS NULL
     UNION ALL
     SELECT df.doc_kind, df.display_name, df.storage_url, df.uploaded_at, 'shipment' AS bound_to
       FROM document_files df
       JOIN shipping_plans sp ON sp.id::text = df.bound_subject_id
      WHERE df.bound_subject_type = 'shipping_plan'
        AND sp.bl_no = $2
        AND $2 IS NOT NULL AND $2 != ''
        AND df.deleted_at IS NULL
     ORDER BY uploaded_at DESC`,
    [order.id, order.bl_no]
  );
  return r.rows.map(row => ({
    doc_kind: row.doc_kind,
    name: row.display_name,
    url: row.storage_url,
    uploaded_at: row.uploaded_at,
    bound_to: row.bound_to,
  }));
}

// ── view=missing ─────────────────────────────────────────────────
// 缺显缺：①合并 document_missing_items 里真实登记的 open 条目（很少，但如果有必须显示）
//        ②EXPECTED_DOC_KINDS 存在性 diff（heuristic，明确标注，不冒充系统判定）
async function viewMissing(pool, order) {
  const registered = await pool.query(
    `SELECT doc_type, description, severity
       FROM document_missing_items
      WHERE status = 'open'
        AND (shipment_no = $1 OR contract_no = $2)`,
    [order.bl_no, order.contract_no]
  );

  const present = await pool.query(
    `SELECT DISTINCT doc_kind
       FROM document_files
      WHERE deleted_at IS NULL
        AND ((bound_subject_type = 'order' AND bound_subject_id = $1::text)
          OR (bound_subject_type = 'shipping_plan' AND bound_subject_id IN (
                SELECT id::text FROM shipping_plans WHERE bl_no = $2 AND $2 IS NOT NULL AND $2 != ''
              )))`,
    [order.id, order.bl_no]
  );
  const havKinds = new Set(present.rows.map(r => r.doc_kind));
  const heuristicMissing = EXPECTED_DOC_KINDS
    .filter(k => !havKinds.has(k))
    .map(k => ({ doc_type: k, description: `缺 ${k}，请联系我们补充`, severity: "heuristic" }));

  return {
    registered: registered.rows.map(r => ({
      doc_type: r.doc_type, description: r.description, severity: r.severity,
    })),
    heuristic_missing: heuristicMissing,
    note: "heuristic_missing 是系统按常见单据类型推断，不代表业务员确认缺失；如有疑问以人工回复为准",
  };
}

// ── view=price ───────────────────────────────────────────────────
// 只出卖价（unit_price/subtotal），成本/工厂价字段绝不进 SELECT。
// 金额锚：finance_export_rebates(fer).fob_cny，按 contract_no 关联；无锚 = 待报关，不用其它字段顶替。
async function viewPrice(pool, order) {
  const lines = await pool.query(
    `SELECT
        COALESCE(p.product_name_cn, p.product_name, li.product_name) AS product_name,
        li.qty_ctn, li.unit, li.unit_price, li.subtotal
       FROM order_line_items li
       LEFT JOIN products p ON p.sku = li.sku
      WHERE li.order_id = $1
      ORDER BY li.sort_order NULLS LAST, li.id`,
    [order.id]
  );

  // 多柜票一合同多报关行: SUM 全部锚定行,绝不 LIMIT 1 漏柜(防"每柜当总价"反向坑)
  let anchor = null;
  if (order.contract_no) {
    const fer = await pool.query(
      `SELECT SUM(fob_cny) AS fob_cny, COUNT(*) AS decl_count
         FROM finance_export_rebates
        WHERE contract_no = $1 AND fob_cny IS NOT NULL`,
      [order.contract_no]
    );
    if (fer.rows.length && Number(fer.rows[0].decl_count) > 0) anchor = fer.rows[0];
  }

  return {
    lines: lines.rows.map(r => ({
      product_name: r.product_name,
      qty_ctn: r.qty_ctn,
      unit: r.unit,
      unit_price: r.unit_price,   // 卖价，非成本
      subtotal: r.subtotal,       // 卖价小计
    })),
    order_subtotal_sum: lines.rows.reduce((s, r) => s + Number(r.subtotal || 0), 0),
    declared_anchor_cny: anchor ? Number(anchor.fob_cny) : null,
    anchor_status: anchor ? "anchored" : "pending_customs",
    anchor_note: anchor ? null : "待报关：报关金额尚未生成，当前仅显示订单卖价",
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return json(res, 405, { success: false, error: "GET only — P1 是零写入门户" });

  const pool = getPool();
  const token = req.query?.token;
  const scope = await resolveScope(pool, req, token);
  if (!scope) return json(res, 401, { success: false, error: "invalid_or_expired_token" });

  const codes = [scope.companyCode];
  const view = String(req.query.view || "orders");

  try {
    if (view === "orders") {
      return json(res, 200, { success: true, data: await viewOrders(pool, codes) });
    }

    // 以下三个视图都需要 order_no，且必须先校验落在客户作用域内
    const orderNo = String(req.query.order_no || "").trim();
    if (!orderNo) return json(res, 400, { success: false, error: "order_no required" });
    const order = await resolveOrder(pool, codes, orderNo);
    if (!order) return json(res, 404, { success: false, error: "order not found in your scope" });

    if (view === "docs") return json(res, 200, { success: true, data: await viewDocs(pool, order) });
    if (view === "missing") return json(res, 200, { success: true, data: await viewMissing(pool, order) });
    if (view === "price") return json(res, 200, { success: true, data: await viewPrice(pool, order) });

    return json(res, 400, { success: false, error: "unknown view" });
  } catch (e) {
    console.error("[customer-myportal] error:", e);
    return json(res, 500, { success: false, error: e.message });
  }
}
