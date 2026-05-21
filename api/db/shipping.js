import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard
import { sendShipmentNotifications } from "../../jobs/shipment-notify.js";

// Normalize a Chinese company name for matching:
//  - strip full/half-width brackets, spaces, punctuation
//  - drop leading geo prefix (厦门/上海/天津/…)
//  - drop generic corporate suffixes (有限公司/有限责任公司/股份有限公司/分公司)
// So e.g. both "万汇国际（厦门）" and "万汇国际厦门有限公司" → "万汇国际"
// while "万汇恒通(厦门)国际物流有限公司" → "万汇恒通国际物流" (distinct!)
function normCompany(s) {
  if (!s) return "";
  let x = String(s).replace(/[（）()【】\[\]\s、，,。.·\-_/\\]/g, "");
  const geo = ["厦门","上海","天津","青岛","宁波","深圳","山东","江苏","烟台","福建","广州"];
  for (const g of geo) if (x.startsWith(g) && x.length > g.length + 1) { x = x.slice(g.length); break; }
  x = x.replace(/(股份有限公司|有限责任公司|有限公司|分公司)$/g, "");
  return x;
}

const PATCH_ALLOW = [
  "bl_no","vessel","voyage","pol","pod","etd","eta","cutoff_date","carrier_code",
  "flow_status","container_type","container_no","seal_no",
  "qty_total","total_cbm","total_cartons","gross_weight_kg",
  "freight_cost","freight_sale_usd","port_surcharge_total",
  "bkg_fee","doc_fee","tlx_fee","thc_fee","eir_fee","seal_fee","vgm_fee","customs_declare_fee",
  "customs_cost_total","trucking_cost_total","agency_fee_rmb",
  "forwarder_cn","customs_cn","trucking_cn","shipper","consignee",
  "cargo_description","product_notes","release_type",
  "order_contract_nos","contract_no","shipment_no","forwarder_booking_no","booking_sent_at","collab_sheet_status",
  "notes","status","current_status","current_status_cn",
  // driver + insurance (added 2026-05-09)
  "driver_info","insurance_required","insurance_premium","insurance_policy_no","insurance_rate",
];

async function nextShipmentNo(pool) {
  try {
    const { rows } = await pool.query(
      "SELECT shipment_no FROM shipping_plans WHERE shipment_no ~ '^CY[0-9]{5}$' ORDER BY shipment_no DESC LIMIT 1"
    );
    const last = rows[0]?.shipment_no || "CY00000";
    const n = Math.max(parseInt(last.slice(2), 10), 146) + 1;
    return "CY" + String(n).padStart(5, "0");
  } catch {
    return "CY" + String(Date.now()).slice(-5);
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT

  const pool = getPool();
  const _role = req.user?.role || 'customer';
  const _isInternalWriter = _role === 'admin' || _role === 'finance' || _role === 'logistics';

  // Layer 3: write operations (POST/PATCH) restricted to internal roles only
  if ((req.method === "POST" || req.method === "PATCH") && !_isInternalWriter) {
    return res.status(403).json({
      error: "Forbidden: shipping plan writes require admin/finance/logistics role",
      code:  "SHIPPING_WRITE_FORBIDDEN",
    });
  }

  // ── POST (create new shipping plan) ───────────────────────
  if (req.method === "POST") {
    const body = req.body || {};

    // L3: bl_no 写入时自动升级 status（DB trigger 双保险）
    if (body.bl_no && body.bl_no.trim() && (!body.flow_status || body.flow_status === 'draft')) {
      body.flow_status = 'booked';
    }

    // L3: freight_sale_usd 写入时校验 currency 格式（422）
    if (body.freight_sale_usd !== undefined && body.freight_sale_usd !== null) {
      const fsu = Number(body.freight_sale_usd);
      if (isNaN(fsu) || fsu < 0) {
        return res.status(422).json({ error: "freight_sale_usd must be a non-negative number" });
      }
    }

    const shipmentNo = await nextShipmentNo(pool);
    const _id = "sp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    // booking_no is the UI field name; DB column is forwarder_booking_no
    const forwarderBookingNo = body.forwarder_booking_no || body.booking_no || null;

    const insertFields = {
      _id,
      shipment_no:        shipmentNo,
      order_contract_nos: body.order_contract_nos || null,
      contract_no:        body.contract_no        || null,
      bl_no:              body.bl_no              || null,
      vessel:             body.vessel             || null,
      voyage:             body.voyage             || null,
      carrier_code:       body.carrier_code       || null,
      pol:                body.pol                || null,
      pod:                body.pod                || null,
      etd:                body.etd                || null,
      eta:                body.eta                || null,
      cutoff_date:        body.cutoff_date        || null,
      flow_status:        body.flow_status        || "draft",
      container_type:     body.container_type     || null,
      container_no:       body.container_no       || null,
      seal_no:            body.seal_no            || null,
      customer:           body.customer           || null,
      forwarder_cn:       body.forwarder_cn       || null,
      customs_cn:         body.customs_cn         || null,
      trucking_cn:        body.trucking_cn        || null,
      shipper:            body.shipper            || null,
      cargo_description:  body.cargo_description  || null,
      freight_cost:       body.freight_cost       || null,
      freight_sale_usd:   body.freight_sale_usd   || null,
      port_surcharge_total: body.port_surcharge_total || null,
      forwarder_booking_no: forwarderBookingNo,
      status:             body.status             || null,
      created_by:         req.user?.id || req.user?.email || body.created_by || "admin",
    };

    const cols = Object.keys(insertFields).filter(k => insertFields[k] !== null && insertFields[k] !== undefined);
    const vals = cols.map(k => insertFields[k]);
    const placeholders = cols.map((_, i) => `$${i + 1}`);

    try {
      const r = await pool.query(
        `INSERT INTO shipping_plans (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
        vals
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PATCH ─────────────────────────────────────────────────
  if (req.method === "PATCH") {
    let { id, ...fields } = req.body || {};
    // booking_no is the UI alias; DB column is forwarder_booking_no
    if ("booking_no" in fields && !("forwarder_booking_no" in fields)) {
      fields = { ...fields, forwarder_booking_no: fields.booking_no };
    }
    if (!id) return res.status(400).json({ error: "id required" });

    // Fetch existing row first (for bl_no change detection)
    let existing = null;
    try {
      const ex = await pool.query("SELECT * FROM shipping_plans WHERE id = $1", [id]);
      existing = ex.rows[0] || null;
    } catch (e) {
      return res.status(500).json({ error: "fetch existing: " + e.message });
    }
    if (!existing) return res.status(404).json({ error: "row not found" });

    const sets = [];
    const vals = [];
    PATCH_ALLOW.forEach(k => {
      if (k in fields) {
        vals.push(fields[k]);
        sets.push(`${k} = $${vals.length}`);
      }
    });
    // Merge first_issued_at JSONB (per-docType timestamps)
    if (fields.first_issued_at && typeof fields.first_issued_at === "object") {
      vals.push(JSON.stringify(fields.first_issued_at));
      sets.push(`first_issued_at = COALESCE(first_issued_at,'{}') || $${vals.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: "no updatable fields" });
    vals.push(id);
    const sql = `UPDATE shipping_plans SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} RETURNING *`;

    let saved;
    try {
      // Phase 5: set app.current_user so trg_sp_audit can record the actor
      const actor = req.user?.email || req.user?.id || "system";
      await pool.query(`SET LOCAL app.current_user = $1`, [actor]);
      const r = await pool.query(sql, vals);
      saved = r.rows[0];
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    // ── bl_no change detection → trigger dual notifications ──
    const prevBl = existing.bl_no;
    const newBl  = saved.bl_no;
    let notifyResult = null;
    if (!prevBl && newBl) {
      try {
        notifyResult = await sendShipmentNotifications(pool, saved);
      } catch (e) {
        console.error("[shipping] notify failed (non-fatal):", e.message);
        notifyResult = { error: e.message };
      }
    }

    return res.status(200).json({
      success: true,
      data: saved,
      ...(notifyResult ? { notified: notifyResult } : {}),
    });
  }

  // ── GET ───────────────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { customer, created_by, limit = 500 } = req.query;
    // Use alias sp so EXISTS subqueries can reference it
    let query = "SELECT sp.* FROM shipping_plans sp", params = [], conds = [];
    if (customer) { params.push(`%${customer}%`); conds.push(`sp.customer ILIKE $${params.length}`); }
    if (created_by) { params.push(created_by); conds.push(`sp.created_by = $${params.length}`); }

    const u = req.user || {};
    const isInternal = u.role === 'admin' || u.role === 'finance';
    let scopeCol = null, scopeNeedle = "";

    if (!isInternal) {
      // ── Logistics: see only their own shipments ────────────────────────────
      if (u.role === "logistics") {
        scopeCol = u.supplierRole === "ocean" ? "forwarder_cn"
                : u.supplierRole === "customs" ? "customs_cn"
                : u.supplierRole === "truck"   ? "trucking_cn"
                : null;
        scopeNeedle = normCompany(u.company);
        if (!scopeCol || !scopeNeedle) {
          return res.status(200).json({ success: true, data: [], count: 0, scoped: "logistics:empty" });
        }
        const hint = scopeNeedle.slice(0, 2);
        params.push(`%${hint}%`);
        conds.push(`sp.${scopeCol} ILIKE $${params.length}`);

      // ── Customer: see only plans tied to their orders ─────────────────────
      } else if (u.role === "customer") {
        const codes = u.companyCodes || (u.companyCode ? [u.companyCode] : []);
        if (codes.length === 0) {
          // FAIL-CLOSED-2026-05-19: no scope → empty
          return res.status(200).json({ success: true, data: [], count: 0, scoped: "customer:empty" });
        }
        params.push(codes);
        conds.push(
          `EXISTS (
            SELECT 1 FROM orders o
            WHERE o.company_code = ANY($${params.length}::text[])
            AND (
              sp.contract_no = o.contract_no
              OR sp.order_contract_nos LIKE '%' || o.contract_no || '%'
            )
          )`
        );

      // ── Factory: see only plans tied to their factory orders ──────────────
      } else if (u.role === "factory" || u.role === "supplier") {
        const codes = u.companyCodes || (u.companyCode ? [u.companyCode] : []);
        if (codes.length === 0) {
          return res.status(200).json({ success: true, data: [], count: 0, scoped: "factory:empty" });
        }
        params.push(codes);
        conds.push(
          `EXISTS (
            SELECT 1 FROM orders o
            WHERE (
              o.raw->>'factory_code' = ANY($${params.length}::text[])
              OR o.raw->>'factoryCompanyCode' = ANY($${params.length}::text[])
            )
            AND (
              sp.contract_no = o.contract_no
              OR sp.order_contract_nos LIKE '%' || o.contract_no || '%'
            )
          )`
        );

      } else {
        // Unknown role: FAIL-CLOSED — return empty rather than full data
        return res.status(200).json({ success: true, data: [], count: 0, scoped: "unknown:empty" });
      }
    }
    // admin/finance: no scope filter — see everything

    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY sp.etd DESC LIMIT $${params.length}`;
    let rows = (await pool.query(query, params)).rows;

    // Defense-in-depth: secondary filter for logistics (name normalization)
    if (scopeCol && scopeNeedle) {
      rows = rows.filter(r => {
        const cell = normCompany(r[scopeCol]);
        return cell && (cell.includes(scopeNeedle) || scopeNeedle.includes(cell));
      });
    }
    return res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
