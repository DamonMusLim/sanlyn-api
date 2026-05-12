/**
 * api/portal/orders.js — Portal Customer Orders Read API
 *
 * GET /api/portal/orders             → paginated order list, scoped to caller's company
 * GET /api/portal/orders?order_id=X  → single order detail with ownership enforcement
 *
 * Auth:    portalGate (app.use("/api/portal", portalGate) in server.js) runs first.
 *          parsePortalAuth then loads the full PermissionsContext.
 *
 * Scope:   Built server-side from permissions.company.company_code
 *          + partner_company scopes in portal_user_scopes.
 *          req.query.company_codes is IGNORED — client must never control scope.
 *
 * Response: Every record passes through _cropForCustomer() before being returned.
 *           Internal cost, vendor, margin, and raw-blob fields are stripped.
 *
 * STOP conditions (any violation stops execution and returns error):
 *   - No valid Bearer token → 401 (handled by portalGate before this handler runs)
 *   - user_type !== 'customer' → 403
 *   - No customer role → 403
 *   - authorizedCodes empty → 200 { data: [] }
 *   - order_id ownership mismatch → 404 (don't leak existence)
 */

import { getPool, setCors } from '../db.js';
import { parsePortalAuth }  from './middleware.js';
import { isCustomer, hasRole } from './auth-check.js';

export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  const pool = getPool();

  // ── 1. Verify token + load permissions ──────────────────────────────────────
  // portalGate already validated the token and loaded req.portalPermissions.
  // parsePortalAuth short-circuits to that if present, avoiding a second DB query.
  const permissions = await parsePortalAuth(req, res, pool);
  if (!permissions) return; // already responded 401/403

  // ── 2. Customer-only gate ────────────────────────────────────────────────────
  if (!isCustomer(permissions)) {
    return res.status(403).json({
      error: 'This endpoint is for customer accounts only',
      code:  'FORBIDDEN',
    });
  }
  if (!hasRole(permissions, ['customer_view', 'customer_admin', 'customer_division'])) {
    return res.status(403).json({
      error: 'No customer role assigned to this account',
      code:  'FORBIDDEN',
    });
  }

  // ── 3. Build server-side authorized company codes ────────────────────────────
  // Primary code: permissions.company.company_code  (bound at portal_companies)
  // Extended:     partner_company scopes            (for group customers, e.g. PETSOME)
  //
  // req.query.company_codes is never read here — that is the IDOR vector.
  const authorizedCodes = _buildAuthorizedCodes(permissions);
  if (authorizedCodes.length === 0) {
    return res.status(200).json({ success: true, data: [], count: 0, total: 0 });
  }

  const { order_id }        = req.query;
  const lim = Math.min(parseInt(req.query.limit)  || 100, 200);
  const off = Math.max(parseInt(req.query.offset) || 0,   0);

  try {
    // ── 4. Single-order detail (with ownership enforcement) ──────────────────
    if (order_id) {
      const oRes = await pool.query(
        'SELECT * FROM orders WHERE (_id = $1 OR order_no = $1) LIMIT 1',
        [order_id]
      );

      if (!oRes.rows.length) {
        // 404 — do not reveal whether the order exists at all
        return res.status(404).json({ success: false, error: 'Order not found' });
      }

      const order    = oRes.rows[0];
      const orderCode = order.company_code || order.raw?.companyCode;

      // Ownership check — fail-closed with same 404 to avoid existence leak
      if (!authorizedCodes.includes(orderCode)) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }

      const plan   = await _findShippingPlan(pool, order);
      const blockedDocs = await _fetchBlockedDocs(pool, order.company_code);
      const merged = _merge(order, plan, blockedDocs);
      return res.status(200).json({ success: true, data: _cropForCustomer(merged) });
    }

    // ── 5. Order list — scoped to authorized company codes ────────────────────
    // $1…$N = authorizedCodes  (reused in both IN clauses — valid in PostgreSQL)
    // $N+1  = limit
    // $N+2  = offset
    const ph     = authorizedCodes.map((_, i) => `$${i + 1}`).join(',');
    const params = [...authorizedCodes, lim, off];

    const ordersRes = await pool.query(
      `SELECT * FROM orders
       WHERE (raw->>'companyCode' IN (${ph}) OR company_code IN (${ph}))
       ORDER BY created_at DESC
       LIMIT  $${authorizedCodes.length + 1}
       OFFSET $${authorizedCodes.length + 2}`,
      params
    );
    const orders = ordersRes.rows;

    if (!orders.length) {
      return res.status(200).json({ success: true, data: [], count: 0, total: 0 });
    }

    // ── 6. Batch fetch shipping plans ─────────────────────────────────────────
    const orderNos = orders.map(o => o.order_no || o._id).filter(Boolean);
    let plans = [];
    if (orderNos.length > 0) {
      const nosPhs  = orderNos.map((_, i) => `$${i + 1}`).join(',');
      const planRes = await pool.query(
        `SELECT * FROM shipping_plans
         WHERE order_contract_nos IS NOT NULL
           AND string_to_array(order_contract_nos, ',') && $1::text[]
         ORDER BY etd DESC`,
        [orderNos]
      );
      plans = planRes.rows;
    }

    const planByOrderNo = {};
    for (const plan of plans) {
      const noArr = plan.order_contract_nos
        ? plan.order_contract_nos.split(',').map(s => s.trim()).filter(Boolean)
        : [];
      for (const no of noArr) planByOrderNo[String(no)] = plan;
    }

    // ── 6.5. Fetch customer doc visibility config (fail-open) ─────────────────
    // blocked_doc_keys controls UI display only — not a file access control.
    const uniqueCodes = [...new Set(orders.map(o => o.company_code).filter(Boolean))];
    const blockedByCode = {};
    if (uniqueCodes.length > 0) {
      try {
        const custRes = await pool.query(
          `SELECT company_code, raw->'blocked_doc_keys' AS blocked_doc_keys
             FROM customers WHERE company_code = ANY($1::text[])`,
          [uniqueCodes]
        );
        for (const row of custRes.rows) {
          const val = row.blocked_doc_keys;
          blockedByCode[row.company_code] = Array.isArray(val) ? val : (val ? val : []);
        }
      } catch (_) { /* fail-open: missing config = show all docs */ }
    }

    // ── 7. Merge + crop ───────────────────────────────────────────────────────
    const data = orders.map(o => {
      const key = o.order_no || o._id;
      const blocked = blockedByCode[o.company_code] || [];
      return _cropForCustomer(_merge(o, planByOrderNo[String(key)] || null, blocked));
    });

    // ── 8. Total count for pagination ─────────────────────────────────────────
    const countRes = await pool.query(
      `SELECT COUNT(*) AS total FROM orders
       WHERE (raw->>'companyCode' IN (${ph}) OR company_code IN (${ph}))`,
      authorizedCodes
    );

    return res.status(200).json({
      success: true,
      data,
      count: data.length,
      total: parseInt(countRes.rows[0].total),
    });

  } catch (err) {
    console.error('[portal/orders]', err);
    return res.status(500).json({ success: false, error: 'Internal error', code: 'DB_ERROR' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: Build server-side authorized company codes
// ─────────────────────────────────────────────────────────────────────────────
// Source 1: permissions.company.company_code  — the user's primary company
// Source 2: portal_user_scopes rows where scope_type = 'partner_company'
//           — used for group customers (e.g. PETSOME → PETSOME_EU, DIBAQ)
//
// req.query.company_codes is NEVER read. This function is the single source of truth.
function _buildAuthorizedCodes(permissions) {
  const codes = new Set([permissions.company.company_code]);
  for (const s of permissions.scopes) {
    if (s.scope_type === 'partner_company') codes.add(s.scope_value);
  }
  return [...codes].filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: Fetch customer_blocked_docs for a single company_code
// Fail-open: returns [] on any error so missing config never hides docs.
async function _fetchBlockedDocs(pool, companyCode) {
  if (!companyCode) return [];
  try {
    const res = await pool.query(
      `SELECT raw->'blocked_doc_keys' AS blocked_doc_keys
         FROM customers WHERE company_code = $1 LIMIT 1`,
      [companyCode]
    );
    const val = res.rows[0]?.blocked_doc_keys;
    return Array.isArray(val) ? val : (val ? val : []);
  } catch (_) { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: Find shipping plan for a single order
// ─────────────────────────────────────────────────────────────────────────────
async function _findShippingPlan(pool, order) {
  const key = order.order_no || order._id;
  if (!key) return null;
  try {
    const res = await pool.query(
      `SELECT * FROM shipping_plans
       WHERE order_contract_nos IS NOT NULL
         AND string_to_array(order_contract_nos, ',') && ARRAY[$1::text]
       ORDER BY etd DESC LIMIT 1`,
      [String(key)]
    );
    return res.rows[0] || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: Merge order row + shipping plan into a unified record
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: Output MUST pass through _cropForCustomer() before being returned to any client.
//       Internal cost fields are NOT included in shipping_plan here (unlike the internal
//       api/db/customer-orders.js version), but _cropForCustomer adds a second explicit
//       whitelist layer as defense-in-depth.
function _merge(order, plan, customerBlockedDocs = []) {
  const raw = order.raw || {};
  const out = {
    _id:               order._id,
    order_no:          order.order_no,
    contract_no:       order.contract_no    || raw.contractNo        || null,
    customer_po:       order.customer_po    || raw.customerPO        || null,
    customer:          order.customer       || raw.companyNameEN     || null,
    company_code:      order.company_code   || raw.companyCode       || null,
    company_name_cn:   order.company_name_cn  || raw.companyNameCN   || null,
    company_name_en:   order.company_name_en  || raw.companyNameEN   || null,
    status:            order.status         || null,
    production_status: order.production_status || raw.productionStatus || null,
    total_qty:         order.total_qty      || raw.totalQty          || null,
    total_cbm:         order.total_cbm      || raw.totalCBM          || null,
    gross_weight:      order.gross_weight   || raw.grossWeight       || null,
    net_weight:        order.net_weight     || raw.netWeight         || null,
    container_type:    order.container_type  || raw.containerType    || null,
    container_qty:     order.container_qty   || raw.containerQty     || null,
    total_amount:      order.total_amount   || raw.totalAmount       || null,
    currency:          order.currency       || raw.currency          || 'USD',
    destination_port:  order.destination_port || raw.pod || raw.destinationPort || null,
    delivery_date:     order.delivery_date  || raw.deliveryDate      || null,
    confirmed_delivery:order.confirmed_delivery || raw.actDelivery   || null,
    required_arrival:  order.required_arrival   || raw.requireArrivalDate || null,
    created_at:        order.created_at,
    updated_at:        order.updated_at,
    pol:    order.pol    || raw.pol    || null,
    pod:    order.pod    || raw.pod    || null,
    bl_no:  order.bl_no  || raw.blNo   || null,
    vessel: order.vessel || raw.vessel || null,
    voyage: order.voyage || raw.voyage || null,
    etd:    order.etd    || raw.etd    || null,
    eta:    order.eta    || raw.eta    || null,
    products:    raw.products    || order.products    || [],
    attachments: raw.attachments || order.attachments || {},
    pdf_urls:    raw.pdfUrls     || order.pdf_urls    || {},
    // UI display filter — NOT a security boundary (see documentVisibility.js)
    customer_blocked_docs: Array.isArray(customerBlockedDocs) ? customerBlockedDocs : [],
    // Intentionally omitted:
    //   remarks  — may contain internal ops notes
    //   factory  — internal supplier reference
    //   raw      — raw JSONB blob, never sent to clients
  };

  if (plan) {
    // Only customer-visible shipping fields — internal vendor/cost fields are
    // deliberately not included here (second enforcement is in _cropForCustomer).
    out.shipping_plan = {
      shipment_no:    plan.shipment_no,
      bl_no:          plan.bl_no,
      vessel:         plan.vessel,
      voyage:         plan.voyage,
      etd:            plan.etd         ? String(plan.etd).substring(0, 10)         : null,
      eta:            plan.eta         ? String(plan.eta).substring(0, 10)         : null,
      cutoff_date:    plan.cutoff_date ? String(plan.cutoff_date).substring(0, 10) : null,
      container_no:   plan.container_no,
      container_type: plan.container_type,
      pol:            plan.pol,
      pod:            plan.pod,
      flow_status:    plan.flow_status,
      order_nos:      plan.order_contract_nos
                        ? plan.order_contract_nos.split(',').map(s => s.trim()).filter(Boolean)
                        : null,
      // Excluded (cost/vendor — internal only):
      //   freight_cost, freight_sale_usd,
      //   trucking_fee, customs_fee, insurance_fee, doc_fee, thc_fee, seal_fee,
      //   forwarder_cn, trucking_cn, customs_cn, _id
    };

    // Promote key shipping fields to top level
    if (plan.bl_no          && !out.bl_no)          out.bl_no          = plan.bl_no;
    if (plan.vessel         && !out.vessel)          out.vessel         = plan.vessel;
    if (plan.voyage         && !out.voyage)          out.voyage         = plan.voyage;
    if (plan.pol            && !out.pol)             out.pol            = plan.pol;
    if (plan.pod            && !out.pod)             out.pod            = plan.pod;
    if (plan.etd            && !out.etd)             out.etd            = String(plan.etd).substring(0, 10);
    if (plan.eta            && !out.eta)             out.eta            = String(plan.eta).substring(0, 10);
    if (plan.container_no)                           out.container_no   = plan.container_no;
    if (plan.container_type && !out.container_type)  out.container_type = plan.container_type;
    if (plan.flow_status)                            out.flow_status    = plan.flow_status;
  } else {
    out.shipping_plan = null;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: Customer response cropper — explicit whitelist
// ─────────────────────────────────────────────────────────────────────────────
// Defense-in-depth layer.  Even if _merge() is updated to include new fields,
// they will be silently dropped here unless explicitly added to the whitelist.
//
// Fields stripped (explicit exclusion list for audit purposes):
//   COST / MARGIN:    freight_cost, freight_sale_usd
//   FEE BREAKDOWN:    trucking_fee, customs_fee, insurance_fee, doc_fee, thc_fee, seal_fee
//   INTERNAL VENDOR:  forwarder_cn, trucking_cn, customs_cn
//   RAW BLOB:         raw (order.raw JSONB — never sent to clients)
//   INTERNAL NOTES:   remarks (ops notes, not customer-facing)
//   SUPPLIER REF:     factory (internal supplier name)
//   PLAN INTERNAL:    shipping_plan._id (internal PK, not needed by portal)
function _cropForCustomer(order) {
  if (!order) return null;

  const {
    _id, order_no, contract_no, customer_po,
    customer, company_code, company_name_cn, company_name_en,
    status, production_status,
    total_qty, total_cbm, gross_weight, net_weight,
    container_type, container_qty, container_no,
    total_amount, currency,
    destination_port, delivery_date, confirmed_delivery, required_arrival,
    created_at, updated_at,
    pol, pod, bl_no, vessel, voyage, etd, eta, flow_status,
    products, attachments, pdf_urls,
    shipping_plan,
  } = order;

  // Whitelist shipping_plan fields
  let croppedPlan = null;
  if (shipping_plan) {
    croppedPlan = {
      shipment_no:    shipping_plan.shipment_no    ?? null,
      bl_no:          shipping_plan.bl_no          ?? null,
      vessel:         shipping_plan.vessel         ?? null,
      voyage:         shipping_plan.voyage         ?? null,
      etd:            shipping_plan.etd            ?? null,
      eta:            shipping_plan.eta            ?? null,
      cutoff_date:    shipping_plan.cutoff_date    ?? null,
      container_no:   shipping_plan.container_no   ?? null,
      container_type: shipping_plan.container_type ?? null,
      pol:            shipping_plan.pol            ?? null,
      pod:            shipping_plan.pod            ?? null,
      flow_status:    shipping_plan.flow_status    ?? null,
      order_nos:      shipping_plan.order_nos      ?? null,
      // Explicitly excluded from whitelist:
      // _id, freight_cost, freight_sale_usd,
      // trucking_fee, customs_fee, insurance_fee, doc_fee, thc_fee, seal_fee,
      // forwarder_cn, trucking_cn, customs_cn
    };
  }

  return {
    _id, order_no, contract_no, customer_po,
    customer, company_code, company_name_cn, company_name_en,
    status, production_status,
    total_qty, total_cbm, gross_weight, net_weight,
    container_type, container_qty, container_no,
    total_amount, currency,
    destination_port, delivery_date, confirmed_delivery, required_arrival,
    created_at, updated_at,
    pol, pod, bl_no, vessel, voyage, etd, eta, flow_status,
    products, attachments, pdf_urls,
    shipping_plan: croppedPlan,
    customer_blocked_docs: order.customer_blocked_docs ?? [],
    // Excluded top-level: remarks, factory, raw
  };
}
