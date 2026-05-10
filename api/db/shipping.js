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

// ── BL three-way isolation (v3.2 §8) ─────────────────────────────
// bl_no       = MBL  → ocean_partner + internal_ops
// bl_house    = HBL  → internal_ops + customer + import_broker
// bl_customs  = 报关 → internal_ops + customs_broker
// Anything else: strip the field entirely (fail-closed).
const BL_ROLE_ACCESS = {
  bl_no:      new Set(["internal_ops", "ocean_partner"]),
  bl_house:   new Set(["internal_ops", "customer", "import_broker"]),
  bl_customs: new Set(["internal_ops", "customs_broker"]),
};

// Map legacy/alias roles to canonical v3.2 RoleKey.
// `logistics + supplierRole=ocean` (legacy) → ocean_partner
// `logistics + supplierRole=customs` → customs_broker
function canonicalRole(u) {
  if (!u) return null;
  if (u.role === "admin" || u.role === "internal_ops" || u.role === "staff") return "internal_ops";
  if (u.role === "logistics") {
    if (u.supplierRole === "ocean")   return "ocean_partner";
    if (u.supplierRole === "customs") return "customs_broker";
    if (u.supplierRole === "truck")   return "trucking_partner";
    return null;
  }
  return u.role || null; // customer / import_broker / factory_* etc. pass through
}

function stripBlFields(row, role) {
  if (!row) return row;
  const out = { ...row };
  for (const [field, allowed] of Object.entries(BL_ROLE_ACCESS)) {
    if (!allowed.has(role)) delete out[field];
  }
  // Codex P1 (rounds 4 + 5): raw payload contains BL leakage through:
  //   1. Persisted notification text (raw.customer_notification_text /
  //      raw.factory_notification_text) — written by the notifier.
  //   2. Importer-written BL aliases (raw.blNo, raw.bl_no, raw.blHouse,
  //      raw.bl_house, raw.blCustoms, raw.bl_customs) — written by
  //      minimax-booking and other importers.
  // Strip ALL of these from raw based on role. internal_ops keeps everything.
  if (out.raw && typeof out.raw === "object" && role !== "internal_ops") {
    const raw = { ...out.raw };
    // BL aliases — three-way isolation
    if (!BL_ROLE_ACCESS.bl_no.has(role)) {
      delete raw.blNo;     delete raw.bl_no;
    }
    if (!BL_ROLE_ACCESS.bl_house.has(role)) {
      delete raw.blHouse;  delete raw.bl_house;
    }
    if (!BL_ROLE_ACCESS.bl_customs.has(role)) {
      delete raw.blCustoms; delete raw.bl_customs;
    }
    // Codex P1 (round 7): historical rows have raw.{customer,factory}_
    // notification_text rendered with the OLD logic (used row.bl_no for
    // customer text). Even roles that can see HBL must not receive the
    // legacy text because it may contain MBL. Always strip these for
    // non-internal_ops; the notifier re-renders fresh text on next event.
    delete raw.customer_notification_text;
    delete raw.factory_notification_text;
    out.raw = raw;
  }
  return out;
}

const PATCH_ALLOW = [
  "bl_no","bl_house","bl_customs","vessel","voyage","pol","pod","etd","eta","cutoff_date",
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

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT

  const pool = getPool();

  const role = canonicalRole(req.user);

  // ── PATCH ─────────────────────────────────────────────────
  if (req.method === "PATCH") {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    // Fail-closed: strip BL fields the caller is not allowed to write.
    for (const [blField, allowed] of Object.entries(BL_ROLE_ACCESS)) {
      if (blField in fields && !allowed.has(role)) {
        delete fields[blField];
      }
    }

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
      const r = await pool.query(sql, vals);
      saved = r.rows[0];
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    // ── BL change detection → trigger dual notifications ──
    // Trigger on either:
    //   (a) MBL first set  → factory notify (customer deferred if no HBL)
    //   (b) HBL first set  → customer notify (catches deferred case)
    // Codex P1 (round 3): without (b), a shipment that gets MBL before
    // HBL would defer customer notify and never re-fire when HBL arrives.
    const prevBl    = existing.bl_no;
    const newBl     = saved.bl_no;
    const prevHbl   = existing.bl_house;
    const newHbl    = saved.bl_house;
    let notifyResult = null;
    const blFirstSet  = !prevBl  && newBl;
    const hblFirstSet = !prevHbl && newHbl;
    if (blFirstSet || hblFirstSet) {
      try {
        // Codex P2 (round 4): if only HBL was just set, factory notify
        // should NOT fire (factory notification is tied to MBL). Tell the
        // notifier which sides are eligible this trigger.
        notifyResult = await sendShipmentNotifications(pool, saved, {
          allowFactory:  blFirstSet,   // only when MBL just appeared
          allowCustomer: true,         // both transitions can finalise customer send
        });
      } catch (e) {
        console.error("[shipping] notify failed (non-fatal):", e.message);
        notifyResult = { error: e.message };
      }
    }

    return res.status(200).json({
      success: true,
      data: stripBlFields(saved, role),
      ...(notifyResult ? { notified: notifyResult } : {}),
    });
  }

  // ── GET ───────────────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { customer, created_by, limit = 500 } = req.query;
    let query = "SELECT * FROM shipping_plans", params = [], conds = [];
    if (customer) { params.push(`%${customer}%`); conds.push(`customer ILIKE $${params.length}`); }
    if (created_by) { params.push(created_by); conds.push(`created_by = $${params.length}`); }

    // ── Vendor data scoping: logistics users see ONLY their own shipments ──
    const u = req.user || {};
    let scopeCol = null, scopeNeedle = "";
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
      conds.push(`${scopeCol} ILIKE $${params.length}`);
    }

    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY etd DESC LIMIT $${params.length}`;
    let rows = (await pool.query(query, params)).rows;

    if (scopeCol && scopeNeedle) {
      rows = rows.filter(r => {
        const cell = normCompany(r[scopeCol]);
        return cell && (cell.includes(scopeNeedle) || scopeNeedle.includes(cell));
      });
    }
    const scoped = rows.map(r => stripBlFields(r, role));
    return res.status(200).json({ success: true, data: scoped, count: scoped.length });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
