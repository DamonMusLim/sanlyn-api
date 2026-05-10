// POST /api/db/loading-collab-sheets
//
// Bidirectional "Submit Cargo Ready / Request Shipment" entry point.
// Supports two initiator types:
//   1. Factory-side: body.factory_code set, body.cargo_ready_date required
//   2. Customer-side: body.customer_code set, cargo_ready_date optional
//
// Body: { order_id, factory_code?, customer_code?, cargo_ready_date?,
//         trade_terms?, freight_by?, note? }
//
// Auth:
//   · Internal roles: always allowed
//   · Factory JWT: JWT companyCode must match body.factory_code
//   · Customer JWT: JWT companyCode must match body.customer_code
//
// Side effect: marks matching shipping_plans raw->collab_sheet_status='submitted'
import { getPool, setCors } from "../db.js";
import { isInternalRole, roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";

function callerCompanyCode(req) {
  if (req && req.user && (req.user.companyCode || req.user.company_code)) {
    return req.user.companyCode || req.user.company_code;
  }
  try {
    const auth = (req.headers && req.headers.authorization) || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return payload.companyCode || payload.company_code || payload.factory_code || null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const role = roleFromAuth(req);
  if (role === "anonymous") return sendError(res, 401, "auth_required");

  // ── GET: fetch collab sheets for an order ───────────────────────
  if (req.method === "GET") {
    const { order_id, initiated_by } = req.query;
    if (!order_id) return sendError(res, 400, "order_id_required");
    const pool = getPool();
    try {
      const conds = ["order_id = $1"];
      const vals  = [parseInt(order_id)];
      if (initiated_by === "factory") {
        conds.push("(loading->>'submitted_by_factory')::boolean = true");
      } else if (initiated_by === "customer") {
        conds.push("(loading->>'submitted_by_factory')::boolean = false");
      }
      const r = await pool.query(
        `SELECT id, order_id, order_no, contract_no, factory_code, customer_code,
                status, submitted_at, trade_terms, freight_by,
                loading, products, participant_note
           FROM loading_collab_sheets
          WHERE ${conds.join(" AND ")}
          ORDER BY submitted_at DESC NULLS LAST
          LIMIT 20`,
        vals
      );
      return res.json({ success: true, data: r.rows });
    } catch (err) {
      return sendError(res, 500, "internal_error", err.message);
    }
  }

  if (req.method !== "POST") return sendError(res, 405, "method_not_allowed");

  const body = req.body || {};
  const orderId      = parseInt(body.order_id);
  const factoryCode  = body.factory_code  ? String(body.factory_code).trim()  : null;
  const customerCode = body.customer_code ? String(body.customer_code).trim() : null;
  const cargoReadyDate = body.cargo_ready_date || null;
  const tradeTerms   = body.trade_terms   ? String(body.trade_terms).trim()   : null;
  const freightBy    = body.freight_by    ? String(body.freight_by).trim()    : null;
  const note         = body.note          || null;

  if (!orderId || isNaN(orderId)) return sendError(res, 400, "order_id_required");
  if (!factoryCode && !customerCode)  return sendError(res, 400, "factory_code_or_customer_code_required");

  // Factory path: cargo_ready_date required
  const isCustomerSubmit = Boolean(customerCode && !factoryCode);
  if (!isCustomerSubmit && !cargoReadyDate) {
    return sendError(res, 400, "cargo_ready_date_required");
  }

  // Scope guard — JWT companyCode must match the submitter field
  if (!isInternalRole(role)) {
    const jwtCo = callerCompanyCode(req);
    if (isCustomerSubmit) {
      if (!jwtCo || String(jwtCo) !== customerCode) {
        return sendError(res, 403, "customer_scope_mismatch");
      }
    } else {
      if (!jwtCo || String(jwtCo) !== factoryCode) {
        return sendError(res, 403, "factory_scope_mismatch");
      }
    }
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Pull order context — include company_code (customer) + raw (factory contact).
    const ord = await client.query(
      `SELECT id, order_no, contract_no, products,
              company_code, raw->>'factory_code' AS raw_factory_code,
              raw->>'factory_wechat' AS factory_wechat,
              raw->>'customer_wechat' AS customer_wechat
         FROM orders WHERE id = $1`,
      [orderId]
    );
    if (!ord.rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "order_not_found");
    }
    const o = ord.rows[0];

    // Snapshot order.products[] → planned rows
    let planned = [];
    try {
      const prods = Array.isArray(o.products)
        ? o.products
        : (o.products ? JSON.parse(o.products) : []);
      planned = prods.map((p) => ({
        sku:               p.sku || p.product_sku || "",
        product_name:      p.name || p.product_name || "",
        planned_cartons:   p.carton_count || p.qty_cartons || 0,
        actual_cartons:    null,
        planned_gw:        p.gw_total_kg || p.gross_weight || null,
        actual_gw:         null,
        planned_cbm:       p.cbm_total || p.cbm || null,
        actual_cbm:        null,
        packaging_status:  "pending",
        qc_status:         "pending",
      }));
    } catch (_) { planned = []; }

    const loadingPayload = {
      cargo_ready_date:      cargoReadyDate,
      submitted_by_factory:  !isCustomerSubmit,
    };

    const ins = await client.query(
      `INSERT INTO loading_collab_sheets
         (order_id, order_no, contract_no, factory_code,
          status, submitted_at,
          products, loading, participant_note,
          trade_terms, freight_by, customer_code)
       VALUES ($1,$2,$3,$4,'submitted', NOW(), $5::jsonb, $6::jsonb, $7, $8, $9, $10)
       RETURNING *`,
      [
        orderId, o.order_no || null, o.contract_no || null, factoryCode,
        JSON.stringify(planned), JSON.stringify(loadingPayload), note,
        tradeTerms, freightBy, customerCode,
      ]
    );
    const row = ins.rows[0];

    // Mark the matching shipping_plan — update BOTH the actual column and raw JSONB.
    let planUpdated = 0;
    if (o.contract_no) {
      const upd = await client.query(
        `UPDATE shipping_plans
            SET collab_sheet_status = 'submitted',
                raw = jsonb_set(COALESCE(raw, '{}'::jsonb),
                                '{collab_sheet_status}', '"submitted"', true),
                updated_at = NOW()
          WHERE order_contract_nos ILIKE '%' || $1 || '%'
             OR contract_no = $1`,
        [o.contract_no]
      );
      planUpdated = upd.rowCount || 0;
    }

    await client.query("COMMIT");

    // ── QQ friend-request: notify counterparty via WeChat webhook ──
    // Factory submitted → notify customer; customer submitted → notify factory.
    // Fire-and-forget after commit so it never blocks the response.
    const webhookUrl = process.env.WECOM_WEBHOOK_URL;
    if (webhookUrl) {
      const orderTag = `\`${o.order_no || o.contract_no || orderId}\``;
      let msgLines;
      if (isCustomerSubmit) {
        msgLines = [
          "🛒 **客户已发起出货请求**",
          `**订单**: ${orderTag}`,
          tradeTerms ? `**贸易条款**: ${tradeTerms}` : null,
          freightBy  ? `**运费安排**: ${freightBy}`   : null,
          note       ? `**备注**: ${note}`            : null,
          "_请工厂登录 Sanlyn 确认货好日期_",
        ];
      } else {
        msgLines = [
          "📦 **工厂已提交货好通知**",
          `**订单**: ${orderTag}`,
          cargoReadyDate ? `**货好日期**: ${cargoReadyDate}` : null,
          tradeTerms     ? `**贸易条款**: ${tradeTerms}`     : null,
          note           ? `**备注**: ${note}`               : null,
          "_请客户登录 Sanlyn 确认并安排出货_",
        ];
      }
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: { content: msgLines.filter(Boolean).join("\n") },
        }),
      }).catch(e => console.error("[loading-collab-sheets] wecom notify failed:", e.message));
    }

    return res.status(201).json({
      success: true,
      data: row,
      shipping_plan_updated: planUpdated,
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[loading-collab-sheets]", err);
    return sendError(res, 500, "internal_error", err.message);
  } finally {
    client.release();
  }
}
