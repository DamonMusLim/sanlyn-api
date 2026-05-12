// /api/db/customer-orders.js
// GET  ?company_code=PETSOME   → 客户订单列表（含关联海运计划）
// GET  ?order_id=xxx           → 单个订单详情（含海运）
// 只读接口，供客户门户使用

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ── Normalize company codes from JWT (case, whitespace, dedup, length guard) ──
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
    // shipping_plans.order_contract_nos is a TEXT column with comma/pipe-separated contract_nos
    // Match: order.contract_no appearing in plan.order_contract_nos
    const contractNos = orders
      .map(o => o.contract_no || (o.raw && o.raw.contractNo))
      .filter(Boolean);

    let plans = [];
    if (contractNos.length > 0) {
      // Split order_contract_nos by comma or pipe into an array, then check overlap
      // string_to_array(regexp_replace(col, '|', ',', 'g'), ',') && ARRAY[$1, $2, ...]
      const planRes = await pool.query(
        `SELECT * FROM shipping_plans
         WHERE order_contract_nos IS NOT NULL
           AND string_to_array(
             regexp_replace(order_contract_nos, '\\|', ',', 'g'),
             ','
           ) && $1::text[]
         ORDER BY etd DESC`,
        [contractNos]
      );
      plans = planRes.rows;
    }

    // ── Build lookup: contract_no → plan ──
    // order_contract_nos is TEXT (comma/pipe-separated); split to build the index
    const planByContractNo = {};
    for (const plan of plans) {
      const raw = plan.order_contract_nos || "";
      const nos = String(raw).split(/[,|]/).map(s => s.trim()).filter(Boolean);
      for (const no of nos) {
        planByContractNo[no] = plan;
      }
    }

    // ── Merge orders with their shipping plans ──
    const merged = orders.map(o => {
      const key = o.contract_no || (o.raw && o.raw.contractNo);
      const plan = key ? (planByContractNo[String(key).trim()] || null) : null;
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
  const key = order.contract_no || (order.raw && order.raw.contractNo);
  if (!key) return null;
  try {
    const res = await pool.query(
      `SELECT * FROM shipping_plans
       WHERE order_contract_nos IS NOT NULL
         AND string_to_array(
           regexp_replace(order_contract_nos, '\\|', ',', 'g'),
           ','
         ) @> ARRAY[$1::text]
       ORDER BY etd DESC LIMIT 1`,
      [String(key).trim()]
    );
    return res.rows[0] || null;
  } catch (e) {
    return null;
  }
}

// ── Product-level forbidden fields (non-admin must not see Sanlyn's cost/tax structure) ──
const PRODUCT_FORBIDDEN_KEYS = [
  "factoryPrice", "factorySubtotal", "factory_price", "factory_subtotal",
  "declareAmountPerBox", "declare_amount_per_box",
  "vatRate", "vat_rate",
  "taxRebateRate", "tax_rebate_rate",
  "_masterFilled",
];

// ── Shipping plan internal cost fields (non-admin must not see Sanlyn's procurement costs) ──
// Column names verified against production shipping_plans schema 2026-05-12
const PLAN_FORBIDDEN_KEYS = [
  "freight_cost",         // Sanlyn's wholesale freight cost
  "trucking_cost_total",  // Sanlyn's trucking cost
  "customs_cost_total",   // Sanlyn's customs filing cost
  "customs_declare_fee",  // Customs declaration fee
  "insurance_premium",    // Sanlyn's insurance cost
  "insurance_rate",       // Insurance rate
  "port_surcharge_total", // Port surcharge
  "doc_fee",              // Internal doc fee
  "thc_fee",              // Terminal handling charge
  "seal_fee",             // Seal fee
  "bkg_fee",              // Booking fee
  "tlx_fee",              // Telex release fee
  "eir_fee",              // Equipment interchange fee
  "vgm_fee",              // VGM fee
  "driver_info",          // Driver contact info (internal)
];

// ── Merge order + shipping plan into unified record ──
// isAdmin controls whether internal cost fields are included in the response.
function _merge(order, plan, isAdmin) {
  const raw = order.raw || {};

  // Strip forbidden product-level fields for non-admin callers.
  // orders.raw.products may contain factoryPrice/factorySubtotal/vatRate etc.
  // that reveal Sanlyn's procurement cost and tax structure.
  let products = raw.products || order.products || [];
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
      etd:           plan.etd ? String(plan.etd).substring(0, 10) : null,
      eta:           plan.eta ? String(plan.eta).substring(0, 10) : null,
      cutoff_date:   plan.cutoff_date ? String(plan.cutoff_date).substring(0, 10) : null,
      container_no:  plan.container_no,
      container_type: plan.container_type,
      pol:           plan.pol,
      pod:           plan.pod,
      flow_status:   plan.flow_status,
      forwarder_cn:  plan.forwarder_cn,
      trucking_cn:   plan.trucking_cn,
      customs_cn:    plan.customs_cn,
      freight_sale_usd: plan.freight_sale_usd, // customer-facing charge — safe to expose
      order_contract_nos: plan.order_contract_nos,
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
    if (plan.etd     && !out.etd)       out.etd    = String(plan.etd).substring(0, 10);
    if (plan.eta     && !out.eta)       out.eta    = String(plan.eta).substring(0, 10);
    if (plan.container_no)              out.container_no = plan.container_no;
    if (plan.container_type && !out.container_type) out.container_type = plan.container_type;
    if (plan.flow_status)               out.flow_status = plan.flow_status;
  } else {
    out.shipping_plan = null;
  }

  return out;
}
