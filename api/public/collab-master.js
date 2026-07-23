// collab-master.js — DRAFT, NOT DEPLOYED. Task #bp-collab-master-build-0723.
// 「协同总表统一界面」后端投影层：一张主表(一票货)，七个视角×两个阶段决定谁看到什么。
// GET-only，零写入。字段可见性全部委托给 collab-master-projection.js（默认拒绝白名单）。
//
// 硬约束（自查通过后才可提交部署，详见交付报告）：
//   - 鉴权=magic_links token_hash + expires_at/revoked_at + access_log 追加，
//     recipient_role='collab_master'（不重复造签发口，只消费已存在链接）
//   - 成本类字段物理不进非 internal 视角的 SQL（allowedFields() 反查白名单列名）
//   - 金额闸：stage='after' 时外部视角金额一律清零，唯一例外=报关行申报金额
//   - 工厂/报关行按 meta.factory_code、车队按 meta.container_nos 严格 fail-closed，
//     未指定一律返回空不是返回全部
//   - 客户视角强制要求 meta.order_no（不接受只给 bl_no）——见交付报告发现①
//     （一票多客户的合并 BL，裸 bl_no 广播查询会跨客户泄露，例 265796274）
//
// 路由建议（未 mount）：GET /api/public/collab-master?token=RAW
//   view/scope 全部编码在 token 对应的 magic_links.meta 里，不接受 query 覆盖——
//   前端不能靠改 query string 换视角。
//
// 交付报告里的发现②③④（factory_price 工厂自见与金额闸的规则冲突 / container_bookings
// .contract_no 列名误导不可靠 / 按厂过滤柜目前无可靠字段）不在此重复，仅在代码里
// 对应位置打了简短注释指回来。

import crypto from "node:crypto";
import { getPool, setCors } from "../db.js";
import {
  VIEWS, allowedFields, projectRow, amountAllowedAfterLoading,
} from "./collab-master-projection.js";

const RECIPIENT_ROLE = "collab_master";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

// ── 鉴权 + scope 解析（同 customer-myportal.js 的 token_hash 查表模式）──────
async function resolveScope(pool, req, token) {
  if (!token || String(token).length < 16) return null;
  const hash = rawToHash(token);
  const { rows } = await pool.query(
    `SELECT id, meta, expires_at, revoked_at
       FROM magic_links
      WHERE token_hash = $1 AND recipient_role = $2
        AND expires_at > NOW() AND revoked_at IS NULL AND COALESCE(revoked, false) = false
      LIMIT 1`,
    [hash, RECIPIENT_ROLE]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const meta = typeof row.meta === "string" ? JSON.parse(row.meta || "{}") : (row.meta || {});
  try {
    const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);
    const entry = JSON.stringify({ accessed_at: new Date().toISOString(), ip, ua, view: meta.view || null });
    await pool.query(
      `UPDATE magic_links SET access_log = COALESCE(access_log, '[]'::jsonb) || $1::jsonb WHERE id = $2`,
      [`[${entry}]`, row.id]
    );
  } catch (e) {
    console.warn("[collab-master] access_log append failed:", e.message);
  }
  return { linkId: row.id, meta };
}

// 每个 bl_no 都能在 shipping_plans 找到对应行（已核实 0 例外），order_no 只是
// 派生 bl_no/company_code/contract_no 的入口，不直接参与后续 WHERE。
async function resolveShipment(pool, meta) {
  let blNo = meta.bl_no ? String(meta.bl_no).trim() : "";
  let companyCode = null;
  let contractNos = [];
  if (meta.order_no) {
    const { rows } = await pool.query(
      `SELECT bl_no, company_code, contract_no FROM orders WHERE order_no = $1 LIMIT 1`,
      [String(meta.order_no).trim()]
    );
    if (rows.length) {
      if (!blNo) blNo = rows[0].bl_no || "";
      companyCode = rows[0].company_code || null;
      if (rows[0].contract_no) contractNos = [rows[0].contract_no];
    }
  }
  let plan = null;
  if (blNo) {
    const { rows } = await pool.query(
      `SELECT id, bl_no, vessel, voyage, etd, eta, pol, pod, current_status,
              atd, shipped_confirmed_at, cargo_ready_date, cargo_description
         FROM shipping_plans WHERE bl_no = $1 LIMIT 1`,
      [blNo]
    );
    plan = rows[0] || null;
  }
  return { blNo, plan, companyCode, contractNos };
}

// 阶段判定：优先真实数据（atd/装货确认/current_status），meta.stage 可覆盖
// （运营需要在真实数据滞后录入时手动纠正，例如货已走但 atd 还没补录）。
function deriveStage(plan, meta) {
  if (meta.stage === "before" || meta.stage === "after") return meta.stage;
  if (!plan) return "before";
  const after = Boolean(plan.atd) || Boolean(plan.shipped_confirmed_at) ||
    plan.current_status === "departed" || plan.current_status === "shipped";
  return after ? "after" : "before";
}

async function buildOrders(pool, view, scope) {
  if (view === "trucker" || view === "insurer") return { rows: [] };
  const cols = allowedFields("order", view);
  const idCols = allowedFields("identity", view);
  if (!cols.length && !idCols.length) return { rows: [] };

  const params = [];
  const where = [];
  if (scope.planId) { params.push(scope.planId); where.push(`o.shipping_plan_id = $${params.length}`); }
  if (scope.blNo) { params.push(scope.blNo); where.push(`o.bl_no = $${params.length}`); }
  if (!where.length) return { rows: [], scope_missing: true };
  let whereClause = `(${where.join(" OR ")})`;

  if (view === "factory" || view === "broker") {
    if (!scope.factoryCode) return { rows: [], scope_missing: true }; // fail-closed，见规则
    params.push(scope.factoryCode);
    whereClause += ` AND o.factory_code = $${params.length}`;
  }
  if (view === "customer") {
    if (!scope.companyCode) return { rows: [], scope_missing: true }; // 见"发现的问题①"
    params.push(scope.companyCode);
    whereClause += ` AND o.company_code = $${params.length}`;
  }

  // identity 字段名 != 列名时必须带 AS 别名回来，否则 projectRow 按字段名取值会全取到 null
  const dbCol = { customer_name: "customer" };
  const selectCols = [...cols, ...idCols]
    .map(f => (dbCol[f] ? `o.${dbCol[f]} AS ${f}` : `o.${f}`)).join(", ");
  const { rows } = await pool.query(
    `SELECT o.id, o.order_no AS _order_no, o.contract_no AS _contract_no, ${selectCols}
       FROM orders o WHERE ${whereClause} ORDER BY o.order_no`,
    params
  );
  const projected = rows.map(r => ({
    ...projectRow("order", view, scope.stage, r),
    ...projectRow("identity", view, scope.stage, r),
  }));
  return {
    rows: projected,
    _orderIds: rows.map(r => r.id),
    _contractNos: [...new Set(rows.map(r => r._contract_no).filter(Boolean))],
  };
}

async function buildLines(pool, view, scope, orderIds) {
  if (!orderIds || !orderIds.length) return { rows: [] };
  const all = allowedFields("line", view);
  if (!all.length) return { rows: [] };
  const wantsName = all.includes("product_name");
  const plainCols = all.filter(f => f !== "product_name").map(f => `li.${f}`);
  const nameExpr = wantsName ? ["COALESCE(p.product_name_cn, li.product_name) AS product_name"] : [];
  const { rows } = await pool.query(
    `SELECT li.order_id, ${[...nameExpr, ...plainCols].join(", ")}
       FROM order_line_items li LEFT JOIN products p ON p.sku = li.sku
      WHERE li.order_id = ANY($1::int[])
      ORDER BY li.order_id, li.sort_order NULLS LAST, li.id`,
    [orderIds]
  );
  return { rows: rows.map(r => ({ order_id: r.order_id, ...projectRow("line", view, scope.stage, r) })) };
}

// 只查 order 级绑定；internal/customer 额外并入 shipping_plan 级绑定（主 BL/装箱单）。
// factory/broker 绝不并入 shipping_plan 级——那类文件常带跨厂汇总，防跳单红线。
async function buildDocs(pool, view, scope, orderIds) {
  if (!["internal", "customer", "broker", "factory"].includes(view)) return { rows: [] };
  if (!orderIds || !orderIds.length) return { rows: [] };
  const cols = allowedFields("doc", view);
  if (!cols.length) return { rows: [] };
  const selectCols = cols.map(f => `df.${f}`).join(", ");
  const includeShipment = (view === "internal" || view === "customer") && scope.planId;
  const params = [orderIds.map(String)];
  let sql = `SELECT ${selectCols} FROM document_files df
              WHERE df.deleted_at IS NULL AND df.bound_subject_type = 'order'
                AND df.bound_subject_id = ANY($1::text[])`;
  if (includeShipment) {
    params.push(String(scope.planId));
    sql += ` UNION ALL
             SELECT ${selectCols} FROM document_files df
              WHERE df.deleted_at IS NULL AND df.bound_subject_type = 'shipping_plan'
                AND df.bound_subject_id = $2::text`;
  }
  const { rows } = await pool.query(sql, params);
  return { rows: rows.map(r => projectRow("doc", view, scope.stage, r)) };
}

// customs_invoice_status PK=(customs_no,factory_code)，走 orders.contract_no 搭桥关联
// 到这一票这一个厂；factory_code 未指定 = fail-closed。
async function buildCustoms(pool, view, scope) {
  if (!["internal", "broker", "factory"].includes(view)) return { rows: [] };
  if (!scope.factoryCode) return { rows: [], scope_missing: true };
  const cols = allowedFields("customs", view);
  if (!cols.length) return { rows: [] };
  const selectCols = cols.map(f => `cis.${f}`).join(", ");
  const { rows } = await pool.query(
    `SELECT ${selectCols} FROM customs_invoice_status cis
      WHERE cis.factory_code = $1
        AND cis.contract_no IN (
          SELECT o.contract_no FROM orders o
           WHERE (o.shipping_plan_id = $2 OR o.bl_no = $3)
             AND o.factory_code = $1 AND o.contract_no IS NOT NULL AND o.contract_no <> ''
        )`,
    [scope.factoryCode, scope.planId, scope.blNo]
  );
  return { rows: rows.map(r => projectRow("customs", view, scope.stage, r)) };
}

// 车队：container_no 直接对 meta.container_nos 白名单（不走 contract_no，见"发现的问题③"）。
async function buildContainers(pool, view, scope) {
  if (!["internal", "fwd", "trucker"].includes(view)) return { rows: [] };
  if (!scope.planId) return { rows: [], scope_missing: true };
  const cols = allowedFields("container", view);
  if (!cols.length) return { rows: [] };
  const params = [scope.planId];
  let where = "cb.shipping_plan_id = $1";
  if (view === "trucker") {
    if (!scope.containerNos.length) return { rows: [], scope_missing: true }; // fail-closed
    params.push(scope.containerNos);
    where += ` AND cb.container_no = ANY($2::text[])`;
  }
  const selectCols = cols.map(f => `cb.${f}`).join(", ");
  const { rows } = await pool.query(
    `SELECT ${selectCols} FROM container_bookings cb WHERE ${where} ORDER BY cb.container_no`,
    params
  );
  return { rows: rows.map(r => projectRow("container", view, scope.stage, r)) };
}

async function buildInsurance(pool, view, scope) {
  if (!["internal", "insurer"].includes(view)) return { rows: [] };
  if (!scope.blNo) return { rows: [] };
  const cols = allowedFields("insurance", view);
  if (!cols.length) return { rows: [] };
  const selectCols = cols.map(f => `ip.${f}`).join(", ");
  const { rows } = await pool.query(
    `SELECT ${selectCols} FROM insurance_policies ip WHERE ip.bl_no = $1 ORDER BY ip.created_at DESC`,
    [scope.blNo]
  );
  return { rows: rows.map(r => projectRow("insurance", view, scope.stage, r)) };
}

// 客户金额锚：只在 finance_export_rebates 有报关锚定行时给值，无锚='待报关'，
// 绝不用 orders.declare_amount / OLI 等其它字段顶替。
async function buildPriceAnchor(pool, view, scope) {
  if (!["internal", "customer"].includes(view)) return null;
  if (!scope.contractNos.length) return { declared_anchor_cny: null, anchor_status: "pending_customs" };
  const { rows } = await pool.query(
    `SELECT SUM(fob_cny) AS fob_cny, COUNT(*) AS decl_count
       FROM finance_export_rebates WHERE contract_no = ANY($1::text[]) AND fob_cny IS NOT NULL`,
    [scope.contractNos]
  );
  const hit = rows[0] && Number(rows[0].decl_count) > 0;
  const gated = scope.stage === "after" && !amountAllowedAfterLoading(view);
  return {
    declared_anchor_cny: hit && !gated ? Number(rows[0].fob_cny) : null,
    anchor_status: gated ? "gated_after_loading" : hit ? "anchored" : "pending_customs",
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET only" });

  const pool = getPool();
  const token = req.query?.token;
  const link = await resolveScope(pool, req, token);
  if (!link) return res.status(401).json({ success: false, error: "invalid_or_expired_token" });

  const meta = link.meta || {};
  const view = String(meta.view || "");
  if (!VIEWS.includes(view)) return res.status(400).json({ success: false, error: "unknown_view_in_token" });

  try {
    const { blNo, plan, companyCode, contractNos } = await resolveShipment(pool, meta);
    if (!blNo) return res.status(404).json({ success: false, error: "shipment_not_resolved" });
    if (view === "customer" && !meta.order_no) {
      // 发现的问题①：customer 视角必须携带 order_no，禁止只靠 bl_no 广播查询
      return res.status(400).json({ success: false, error: "customer_view_requires_order_no", scope_missing: true });
    }
    const stage = deriveStage(plan, meta);
    const scope = {
      view, stage, blNo, planId: plan ? plan.id : null,
      factoryCode: meta.factory_code ? String(meta.factory_code).trim() : null,
      containerNos: Array.isArray(meta.container_nos) ? meta.container_nos.map(String) : [],
      companyCode: view === "customer" ? companyCode : null,
      contractNos,
    };

    const orders = await buildOrders(pool, view, scope);
    const orderIds = orders._orderIds || [];
    if (orders._contractNos && orders._contractNos.length) scope.contractNos = orders._contractNos;

    const [lines, docs, customs, containers, insurance, priceAnchor] = await Promise.all([
      buildLines(pool, view, scope, orderIds),
      buildDocs(pool, view, scope, orderIds),
      buildCustoms(pool, view, scope),
      buildContainers(pool, view, scope),
      buildInsurance(pool, view, scope),
      buildPriceAnchor(pool, view, scope),
    ]);

    // 默认拒绝也管键名：本视角无权的区块连键都不下发（不是给个空壳）。
    // 起因：车队响应里带着 price_anchor:null，权限审计当场报红——空壳键既是噪音也是信息泄漏面。
    const body = {
      success: true, view, stage, bl_no: blNo,
      shipment: plan
        ? { vessel: plan.vessel, voyage: plan.voyage, etd: plan.etd, eta: plan.eta,
            pol: plan.pol, pod: plan.pod, status: plan.current_status }
        : null,
      scope_missing: Boolean(orders.scope_missing || customs.scope_missing || containers.scope_missing),
    };
    if (allowedFields("order", view).length || allowedFields("identity", view).length) body.orders = orders.rows;
    if (allowedFields("line", view).length) body.order_lines = lines.rows;
    if (allowedFields("doc", view).length) body.documents = docs.rows;
    if (allowedFields("customs", view).length) body.customs = customs.rows;
    if (allowedFields("container", view).length) body.containers = containers.rows;
    if (allowedFields("insurance", view).length) body.insurance = insurance.rows;
    if (priceAnchor != null) body.price_anchor = priceAnchor;
    return res.status(200).json(body);
  } catch (e) {
    console.error("[collab-master] error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
}
