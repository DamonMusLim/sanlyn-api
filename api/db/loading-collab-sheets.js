// POST /api/db/loading-collab-sheets
//
// Factory-driven "Submit Cargo Ready" entry point.
// Creates a loading_collab_sheets row with status='submitted' (skipping
// 'assigned' / 'in_progress'), so the sheet enters CollabHub Pending Review
// the moment the factory hits the button.
//
// Body: { order_id, factory_code, cargo_ready_date, note }
//
// Auth: factory JWT (or any internal role for ops). Non-internal callers must
// have JWT companyCode === body.factory_code — defense-in-depth so a Factory A
// token cannot submit for Factory B.
//
// Side effect: locates the matching shipping_plans row (via order's
// contract_no / id) and marks raw->collab_sheet_status='submitted' so
// downstream UI can show the cargo-ready signal without a JOIN to this table.
import { getPool, setCors } from "../db.js";
import { isInternalRole, roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";

function callerCompanyCode(req) {
  if (req && req.user && (req.user.companyCode || req.user.company_code)) {
    return req.user.companyCode || req.user.company_code;
  }
  // Fallback: parse JWT bearer payload (mirrors loading-sheets.js best-effort).
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
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return sendError(res, 405, "method_not_allowed");

  const role = roleFromAuth(req);
  if (role === "anonymous") return sendError(res, 401, "auth_required");

  const body = req.body || {};
  const orderId = parseInt(body.order_id);
  const factoryCode = body.factory_code && String(body.factory_code).trim();
  const cargoReadyDate = body.cargo_ready_date || null;
  const note = body.note || null;

  if (!orderId || isNaN(orderId)) return sendError(res, 400, "order_id_required");
  if (!factoryCode) return sendError(res, 400, "factory_code_required");
  if (!cargoReadyDate) return sendError(res, 400, "cargo_ready_date_required");

  // Factory scope guard — JWT companyCode must match body factory_code.
  if (!isInternalRole(role)) {
    const jwtCo = callerCompanyCode(req);
    if (!jwtCo || String(jwtCo) !== factoryCode) {
      return sendError(res, 403, "factory_scope_mismatch");
    }
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Pull order context for the products snapshot.
    const ord = await client.query(
      "SELECT id, order_no, contract_no, products FROM orders WHERE id = $1",
      [orderId]
    );
    if (!ord.rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "order_not_found");
    }
    const o = ord.rows[0];

    // Snapshot order.products[] → planned/actual rows (matches loading-sheets.js shape).
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
      cargo_ready_date: cargoReadyDate,
      submitted_by_factory: true,
    };

    const ins = await client.query(
      `INSERT INTO loading_collab_sheets
         (order_id, order_no, contract_no, factory_code,
          status, submitted_at,
          products, loading, participant_note)
       VALUES ($1,$2,$3,$4,'submitted', NOW(), $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
      [
        orderId, o.order_no || null, o.contract_no || null, factoryCode,
        JSON.stringify(planned), JSON.stringify(loadingPayload), note,
      ]
    );
    const row = ins.rows[0];

    // Mark the matching shipping_plan with collab_sheet_status='submitted'.
    // Match by order_contract_nos (text[]) containing this order's contract_no.
    // Stored in raw JSONB to avoid a schema migration here.
    let planUpdated = 0;
    if (o.contract_no) {
      const upd = await client.query(
        `UPDATE shipping_plans
            SET raw = jsonb_set(COALESCE(raw, '{}'::jsonb),
                                '{collab_sheet_status}', '"submitted"', true),
                updated_at = NOW()
          WHERE order_contract_nos ILIKE '%' || $1 || '%'
             OR contract_no = $1`,
        [o.contract_no]
      );
      planUpdated = upd.rowCount || 0;
    }

    await client.query("COMMIT");
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
