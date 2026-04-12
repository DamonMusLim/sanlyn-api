// /api/db/customer-orders.js
// GET  ?company_code=PETSOME   → 客户订单列表（含关联海运计划）
// GET  ?order_id=xxx           → 单个订单详情（含海运）
// 只读接口，供客户门户使用

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

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
      const plan = await _findShippingPlan(pool, order);
      return res.status(200).json({ success: true, data: _merge(order, plan) });
    }

    // ── Build company filter ──
    let codeList = [];
    if (company_codes) {
      try { codeList = JSON.parse(company_codes); } catch { codeList = company_codes.split(","); }
    } else if (company_code) {
      codeList = [company_code];
    }

    if (!codeList.length) {
      return res.status(400).json({ success: false, error: "company_code or company_codes 必填" });
    }

    // ── Fetch orders ──
    const ph = codeList.map((_, i) => `$${i + 1}`).join(",");
    const orderSql = `
      SELECT * FROM orders
      WHERE (raw->>'companyCode' IN (${ph}) OR company_code IN (${ph}))
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
    const merged = orders.map(o => {
      const key = o.order_no || o._id;
      const plan = planByOrderNo[String(key)] || null;
      return _merge(o, plan);
    });

    // ── Count total (for pagination) ──
    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM orders WHERE (raw->>'companyCode' IN (${ph}) OR company_code IN (${ph}))`,
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

// ── Merge order + shipping plan into unified record ──
function _merge(order, plan) {
  const raw = order.raw || {};
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
    // ── Products ──
    products: raw.products || order.products || [],
    // ── Attachments / docs ──
    attachments: raw.attachments || order.attachments || {},
    pdf_urls: raw.pdfUrls || order.pdf_urls || {},
  };

  // ── Overlay shipping plan if found ──
  if (plan) {
    out.shipping_plan = {
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
      freight_cost:  plan.freight_cost,
      freight_sale_usd: plan.freight_sale_usd,
      // Fee breakdown
      trucking_fee:  plan.trucking_fee,
      customs_fee:   plan.customs_fee,
      insurance_fee: plan.insurance_fee,
      doc_fee:       plan.doc_fee,
      thc_fee:       plan.thc_fee,
      seal_fee:      plan.seal_fee,
      order_nos:     plan.order_nos,
    };

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
