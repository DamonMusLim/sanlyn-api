// /api/db/customer-orders.js
// GET  ?company_code=PETSOME   → 客户订单列表（含关联海运计划）
// GET  ?order_id=xxx           → 单个订单详情（含海运）
// 只读接口，供客户门户使用

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ── Normalize company codes from JWT (case, whitespace, dedup, length guard) ──

// 2026-08-06 时区根治：PG 的 date/timestamptz 取出来是 JS Date 对象。
//   String(d).substring(0,10) → "Thu Aug 13"（乱码）
//   JSON 下发再 slice        → 差 8 小时，date 型直接差一天
// 唯一正确写法：显式转 Asia/Shanghai。sv-SE locale 输出就是 YYYY-MM-DD HH:mm。
function bjDate(v){ if(v==null||v==="")return null; try{ return new Date(v).toLocaleDateString("sv-SE",{timeZone:"Asia/Shanghai"}); }catch(e){ return null; } }
function bjTime(v){ if(v==null||v==="")return null; try{ return new Date(v).toLocaleString("sv-SE",{timeZone:"Asia/Shanghai"}).slice(0,16); }catch(e){ return null; } }

function normalizeCompanyCodes(raw) {
  // Guard null/undefined before String() to avoid "null" / "undefined" entries
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  return [...new Set(
    arr
      .map(c => String(c).trim().toUpperCase())
      .filter(c => c.length > 0 && c.length <= 64)
  )];
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // ── Auth: require valid JWT ──
  if (!requireAuth(req, res)) return;

  // ── Tenant scope: non-admin callers are restricted to their own company codes ──
  const isAdmin = req.user.role === "admin";
  // Normalize: handle array, comma-string, single value; uppercase; dedup; length-cap
  const userCodes = normalizeCompanyCodes(
    req.user.companyCodes ?? req.user.companyCode ?? null
  );
  if (!isAdmin && userCodes.length === 0) {
    return res.status(403).json({ success: false, error: "Account scope missing — please log out and log in again." });
  }

  try {
    const pool = getPool();
    const { company_code, company_codes, order_id, limit = 200, offset = 0 } = req.query;

    // ── Single order detail ──
    if (order_id) {
      const oRes = await pool.query(
        "SELECT * FROM orders WHERE _id = $1 OR order_no = $1 LIMIT 1",
        [order_id]
      );
      if (!oRes.rows.length) return res.status(404).json({ success: false, error: "Order not found" });
      const order = oRes.rows[0];
      // Non-admin: verify caller owns this order.
      // Fail-closed: if company_code is empty, deny access — do NOT fallback to raw.
      if (!isAdmin) {
        const orderCode = order.company_code
          ? String(order.company_code).trim().toUpperCase()
          : null;
        if (!orderCode || !userCodes.includes(orderCode)) {
          return res.status(403).json({ success: false, error: "Access denied — order belongs to a different account." });
        }
      }
      const plan = await _findShippingPlan(pool, order);
      await attachLiveProducts(pool, order);
      return res.status(200).json({ success: true, data: _merge(order, plan, isAdmin) });
    }

    // ── Build company filter — non-admin: ignore client-supplied codes, use JWT scope ──
    let codeList = [];
    if (!isAdmin) {
      // Hard-pin to JWT-issued company codes; client-supplied values are ignored
      codeList = userCodes;
    } else if (company_codes) {
      try { codeList = JSON.parse(company_codes); } catch { codeList = company_codes.split(","); }
    } else if (company_code) {
      codeList = [company_code];
    }

    if (!codeList.length) {
      return res.status(400).json({ success: false, error: "company_code or company_codes 必填" });
    }

    // ── Fetch orders ──
    // Permission filter uses only the canonical company_code column.
    // raw->>'companyCode' is legacy/import data and must NOT participate in auth decisions.
    const ph = codeList.map((_, i) => `$${i + 1}`).join(",");
    const orderSql = `
      SELECT * FROM orders
      WHERE company_code IN (${ph})
      ORDER BY created_at DESC
      LIMIT $${codeList.length + 1} OFFSET $${codeList.length + 2}
    `;
    const params = [...codeList, parseInt(limit), parseInt(offset)];
    const ordersRes = await pool.query(orderSql, params);
    const orders = ordersRes.rows;

    if (!orders.length) {
      return res.status(200).json({ success: true, data: [], count: 0 });
    }

    // ── Batch fetch all shipping plans for these orders ──
    // shipping_plans.order_nos is a JSONB array of order_no strings
    // Match: order.order_no OR order._id appearing in plan.order_nos
    const orderNos = orders
      .map(o => o.order_no || o._id)
      .filter(Boolean);

    let plans = [];
    if (orderNos.length > 0) {
      // Use jsonb ? operator to check if any order_no exists in the array
      // We do a broader fetch of recent shipping plans for this customer and match in JS
      // (More efficient than N queries for N orders)
      const customerNames = [...new Set(orders.map(o => o.customer || o.raw?.companyNameEN).filter(Boolean))];
      let planSql = `SELECT * FROM shipping_plans WHERE 1=1`;
      const planParams = [];

      if (customerNames.length > 0) {
        const custPh = customerNames.map((_, i) => `$${i + 1}`).join(",");
        planSql += ` AND customer ILIKE ANY (ARRAY[${customerNames.map((_, i) => `$${i + 1}`).join(",")}])`;
        planParams.push(...customerNames.map(n => `%${n}%`));
        // This doesn't work with ILIKE ANY ARRAY - let's use OR instead
      }

      // Simpler: fetch ALL plans where order_nos contains any of our order numbers
      // Use a single query with jsonb containment checks
      const orderNoPhs = orderNos.map((_, i) => `$${i + 1}`).join(",");
      const planRes = await pool.query(
        `SELECT * FROM shipping_plans
         WHERE order_nos IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(order_nos) AS ono
             WHERE ono IN (${orderNoPhs})
           )
         ORDER BY etd DESC`,
        orderNos
      );
      plans = planRes.rows;
    }

    // ── Build lookup: order_no → plan ──
    const planByOrderNo = {};
    for (const plan of plans) {
      const planOrderNos = plan.order_nos || [];
      const noArr = Array.isArray(planOrderNos) ? planOrderNos : [];
      for (const no of noArr) {
        planByOrderNo[String(no)] = plan;
      }
    }

    // ── Merge orders with their shipping plans ──
    await attachLiveProducts(pool, orders);
    const merged = orders.map(o => {
      const key = o.order_no || o._id;
      const plan = planByOrderNo[String(key)] || null;
      return _merge(o, plan, isAdmin);
    });

    // ── Count total (for pagination) ──
    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM orders WHERE company_code IN (${ph})`,
      codeList
    );

    return res.status(200).json({
      success: true,
      data: merged,
      count: merged.length,
      total: parseInt(countRes.rows[0].total),
    });

  } catch (err) {
    console.error("[customer-orders]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ── Find shipping plan for a single order ──
async function _findShippingPlan(pool, order) {
  const key = order.order_no || order._id;
  if (!key) return null;
  try {
    const res = await pool.query(
      `SELECT * FROM shipping_plans
       WHERE order_nos IS NOT NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(order_nos) AS ono WHERE ono = $1)
       ORDER BY etd DESC LIMIT 1`,
      [String(key)]
    );
    return res.rows[0] || null;
  } catch (e) {
    return null;
  }
}

// MIN_FIX_BATCH_20260526 A-2 (2026-05-25):
// _merge previously emitted `company_code` (CN-XXXXX 防伪 ID) and `factory` name
// to non-admin callers, bypassing the canonical CUSTOMER_FACING allowlist in
// api/lib/orders/serializer.js. Below TOP_FORBIDDEN_KEYS_CUSTOMER strips those
// + a defensive list of other internal identifiers from the final response when
// caller is not admin. Per memory rule feedback_customer_code_anti_counterfeit.md:
// company_code NEVER on customer-facing payload.
const TOP_FORBIDDEN_KEYS_CUSTOMER = [
  "company_code",                  // 防伪 ID — never customer-facing
  "factory",                       // factory name leak (跳单 risk)
  "factory_code",                  // factory anti-counterfeit ID
  "factory_name",
  "issuing_company", "issuing_company_code",
  "forwarder", "forwarder_cn", "forwarder_en",
  "merged_forwarder_cn",
  "freight_cost", "trucking_fee", "customs_fee", "insurance_fee",
  "doc_fee", "thc_fee", "seal_fee",
  "factory_price", "factory_subtotal", "factory_amount", "factory_price_total",
  "profit", "margin",
  "middleman_markup_total", "middleman_markup_pct",
  "exchange_rate", "fx_rate",
  "vault", "pricing_snapshot",
];

// ── Product-level forbidden fields (non-admin must not see Sanlyn's cost/tax structure) ──
const PRODUCT_FORBIDDEN_KEYS = [
  "factoryPrice", "factorySubtotal", "factory_price", "factory_subtotal",
  "declareAmountPerBox", "declare_amount_per_box",
  "vatRate", "vat_rate",
  "taxRebateRate", "tax_rebate_rate",
  "_masterFilled",
];

// ── Shipping plan internal cost fields (non-admin must not see Sanlyn's procurement costs) ──
const PLAN_FORBIDDEN_KEYS = [
  "freight_cost",   // Sanlyn's wholesale freight cost
  "trucking_fee",   // Sanlyn's trucking cost
  "customs_fee",    // Sanlyn's customs filing cost
  "insurance_fee",  // Sanlyn's insurance cost
  "doc_fee",        // Internal doc fee
  "thc_fee",        // Terminal handling charge
  "seal_fee",       // Seal fee
];


// ── 把 order_line_items(真表)批量挂到订单上,给 _merge 用 ──
// ⚖️ 2026-08-13:同一份数据有「真表」和「快照副本」两处时,永远读真表。
async function attachLiveProducts(pool, orders) {
  const list = Array.isArray(orders) ? orders : [orders];
  const ids = list.map(function(o){ return o && o.id; }).filter(Boolean);
  if (!ids.length) return orders;
  try {
    const { rows } = await pool.query(
      "SELECT order_id, sku, barcode, product_name, size, qty_ctn, unit, unit_price, subtotal, nw_ctn, gw_ctn, cbm_ctn, hs_code, declaration_name, sort_order FROM order_line_items WHERE order_id = ANY($1) ORDER BY sort_order NULLS LAST, id",
      [ids]
    );
    const by = {};
    rows.forEach(function(li){
      (by[li.order_id] = by[li.order_id] || []).push({
        sku: li.sku, barcode: li.barcode, name: li.product_name, productName: li.product_name,
        size: li.size, qty: li.qty_ctn, unit: li.unit || "CTN",
        unitPrice: li.unit_price, subtotal: li.subtotal,
        netWeight: li.nw_ctn, grossWeight: li.gw_ctn, cbm: li.cbm_ctn,
        hsCode: li.hs_code, declarationName: li.declaration_name,
      });
    });
    list.forEach(function(o){ if (o && by[o.id]) o.__liveProducts = by[o.id]; });
  } catch (e) { console.warn("[customer-orders] attachLiveProducts failed:", e.message); }
  return orders;
}

// ── Merge order + shipping plan into unified record ──
// isAdmin controls whether internal cost fields are included in the response.
function _merge(order, plan, isAdmin) {
  const raw = order.raw || {};

  // Strip forbidden product-level fields for non-admin callers.
  // orders.raw.products may contain factoryPrice/factorySubtotal/vatRate etc.
  // that reveal Sanlyn's procurement cost and tax structure.
  // ⚖️ 根治 2026-08-13:真表(order_line_items)优先,快照只是副本。
  //    调用方需先 await attachLiveProducts(pool, orders) 把 __liveProducts 挂上。
  //    ⚠️ 本文件当前未挂路由(routes 里搜不到),改对是防它哪天被挂上又带回旧坑。
  let products = (Array.isArray(order.__liveProducts) && order.__liveProducts.length)
               ? order.__liveProducts
               : (raw.products || order.products || []);
  if (!isAdmin && Array.isArray(products)) {
    products = products.map(function(p) {
      if (!p || typeof p !== "object") return p;
      const safe = Object.assign({}, p);
      PRODUCT_FORBIDDEN_KEYS.forEach(function(k) { delete safe[k]; });
      return safe;
    });
  }

  const out = {
    // ── Core order fields ──
    _id:          order._id,
    order_no:     order.order_no,
    contract_no:  order.contract_no  || raw.contractNo || null,
    customer_po:  order.customer_po  || raw.customerPO || null,
    customer:     order.customer     || raw.companyNameEN || null,
    company_code: order.company_code || raw.companyCode || null,
    company_name_cn: order.company_name_cn || raw.companyNameCN || null,
    company_name_en: order.company_name_en || raw.companyNameEN || null,
    status:       order.status || null,
    production_status: order.production_status || raw.productionStatus || null,
    total_qty:    order.total_qty || raw.totalQty || null,
    total_cbm:    order.total_cbm || raw.totalCBM || null,
    gross_weight: order.gross_weight || raw.grossWeight || null,
    net_weight:   order.net_weight || raw.netWeight || null,
    container_type: order.container_type || raw.containerType || null,
    container_qty:  order.container_qty || raw.containerQty || null,
    total_amount: order.total_amount || raw.totalAmount || null,
    currency:     order.currency     || raw.currency || "USD",
    factory:      order.factory      || raw.factory || null,
    destination_port: order.destination_port || raw.pod || raw.destinationPort || null,
    delivery_date: order.delivery_date || raw.deliveryDate || null,
    confirmed_delivery: order.confirmed_delivery || raw.actDelivery || null,
    required_arrival: order.required_arrival || raw.requireArrivalDate || null,
    remarks:      order.remarks || raw.remarks || null,
    created_at:   order.created_at,
    updated_at:   order.updated_at,
    // ── Order-level logistics (if managed by Sanlyn) ──
    pol: order.pol || raw.pol || null,
    pod: order.pod || raw.pod || null,
    bl_no: order.bl_no || raw.blNo || null,
    vessel: order.vessel || raw.vessel || null,
    voyage: order.voyage || raw.voyage || null,
    etd: order.etd || raw.etd || null,
    eta: order.eta || raw.eta || null,
    // ── Products (filtered above for non-admin) ──
    products: products,
    // ── Attachments / docs ──
    attachments: raw.attachments || order.attachments || {},
    pdf_urls: raw.pdfUrls || order.pdf_urls || {},
  };

  // ── Overlay shipping plan if found ──
  if (plan) {
    // Build base plan object (logistics-facing fields only)
    const planBase = {
      _id:           plan._id,
      shipment_no:   plan.shipment_no,
      bl_no:         plan.bl_no,
      vessel:        plan.vessel,
      voyage:        plan.voyage,
      etd:           bjDate(plan.etd),
      eta:           bjDate(plan.eta),
      cutoff_date:   bjDate(plan.cutoff_date),
      container_no:  plan.container_no,
      container_type: plan.container_type,
      pol:           plan.pol,
      pod:           plan.pod,
      flow_status:   plan.flow_status,
      forwarder_cn:  plan.forwarder_cn,
      trucking_cn:   plan.trucking_cn,
      customs_cn:    plan.customs_cn,
      freight_sale_usd: plan.freight_sale_usd, // customer-facing charge — safe to expose
      order_nos:     plan.order_nos,
    };
    // Admin: include full internal cost breakdown
    if (isAdmin) {
      PLAN_FORBIDDEN_KEYS.forEach(function(k) { planBase[k] = plan[k]; });
    }
    out.shipping_plan = planBase;

    // Promote key shipping fields to top level (for backward compat with _toCard)
    if (plan.bl_no   && !out.bl_no)     out.bl_no  = plan.bl_no;
    if (plan.vessel  && !out.vessel)    out.vessel = plan.vessel;
    if (plan.voyage  && !out.voyage)    out.voyage = plan.voyage;
    if (plan.pol     && !out.pol)       out.pol    = plan.pol;
    if (plan.pod     && !out.pod)       out.pod    = plan.pod;
    if (plan.etd     && !out.etd)       out.etd    = bjDate(plan.etd);
    if (plan.eta     && !out.eta)       out.eta    = bjDate(plan.eta);
    if (plan.container_no)              out.container_no = plan.container_no;
    if (plan.container_type && !out.container_type) out.container_type = plan.container_type;
    if (plan.flow_status)               out.flow_status = plan.flow_status;
  } else {
    out.shipping_plan = null;
  }

  // A-2 customer-facing scrub: strip top-level forbidden keys for non-admin.
  // Belt-and-braces with per-call serializer; this is the merge-path safety net.
  if (!isAdmin) {
    TOP_FORBIDDEN_KEYS_CUSTOMER.forEach(function(k) { delete out[k]; });
    // Defensive: also scrub nested shipping_plan internal cost fields if any
    // slipped through PLAN_FORBIDDEN_KEYS guard above (e.g. future field additions).
    if (out.shipping_plan && typeof out.shipping_plan === "object") {
      ["freight_cost","trucking_fee","customs_fee","insurance_fee",
       "doc_fee","thc_fee","seal_fee"].forEach(function(k) {
        delete out.shipping_plan[k];
      });
    }
  }

  return out;
}
