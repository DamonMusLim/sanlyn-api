// GET /api/db/order-services?plan_id= or ?bl_no=
// Read-only order service lens. Unknown service state must stay no_data.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  ORDER_SERVICE_DERIVED_COLUMNS,
  ORDER_SERVICE_ITEMS,
  isOrderServiceCode,
} from "../constants/order-services.js";

const NO_DATA_NOTE = "该服务项我们尚无字段记录";

function clean(v, max = 160) {
  return String(v ?? "").trim().slice(0, max);
}

function hasRecordedValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

function derivedServiceState(item, plan) {
  const rule = ORDER_SERVICE_DERIVED_COLUMNS[item.code];
  if (!rule) return null;

  const { column, kind } = rule;
  const value = plan[column];
  if (!hasRecordedValue(value)) return null;

  if (kind === "text") {
    const arrangedBy = clean(value, 80);
    if (!arrangedBy) return null;
    return {
      code: item.code,
      name_zh: item.zh,
      state: "selected",
      source: "derived_from_column",
      source_column: column,
      arranged_by: arrangedBy,
    };
  }

  if (kind === "bool") {
    return {
      code: item.code,
      name_zh: item.zh,
      state: value === true ? "selected" : "not_selected",
      source: "derived_from_column",
      source_column: column,
    };
  }

  return null;
}

async function tableColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

async function loadPlan(pool, query) {
  const planId = clean(query?.plan_id || query?.id);
  const blNo = clean(query?.bl_no);
  if (!planId && !blNo) return { error: "plan_id or bl_no required" };

  const conds = [];
  const vals = [];
  if (planId) {
    vals.push(planId);
    conds.push(`(id::text = $${vals.length} OR _id::text = $${vals.length})`);
  }
  if (blNo) {
    vals.push(blNo);
    conds.push(`bl_no = $${vals.length}`);
  }

  const r = await pool.query(
    `SELECT id, _id, bl_no, shipment_no,
            trucking_arrange, customs_arrange, insurance_required
       FROM shipping_plans
      WHERE deleted_at IS NULL AND (${conds.join(" OR ")})
      ORDER BY id DESC
      LIMIT 1`,
    vals
  );
  return r.rows[0] || null;
}

async function loadExplicitServices(pool, plan, cols) {
  if (!cols.has("service_type")) return [];

  const conds = [];
  const vals = [];
  if (cols.has("plan_id")) {
    vals.push(String(plan.id));
    conds.push(`plan_id::text = $${vals.length}`);
  }
  if (cols.has("shipping_plan_id")) {
    vals.push(String(plan.id));
    conds.push(`shipping_plan_id::text = $${vals.length}`);
  }
  if (cols.has("bl_no") && plan.bl_no) {
    vals.push(plan.bl_no);
    conds.push(`bl_no = $${vals.length}`);
  }
  if (!conds.length) return [];

  const select = [
    "service_type",
    cols.has("source") ? "source" : "NULL::text AS source",
  ];
  const r = await pool.query(
    `SELECT ${select.join(", ")}
       FROM order_services
      WHERE ${conds.join(" OR ")}`,
    vals
  );
  return r.rows;
}

function buildServices(plan, explicitRows) {
  const explicit = new Map();
  for (const row of explicitRows) {
    const code = clean(row.service_type, 80).toUpperCase();
    if (isOrderServiceCode(code)) explicit.set(code, row);
  }

  return ORDER_SERVICE_ITEMS.map((item) => {
    const row = explicit.get(item.code);
    if (row) {
      return {
        code: item.code,
        name_zh: item.zh,
        state: "selected",
        source: "explicit",
        stored_source: row.source || null,
      };
    }

    const derived = derivedServiceState(item, plan);
    if (derived) return derived;

    return {
      code: item.code,
      name_zh: item.zh,
      state: "no_data",
      source: null,
      note: NO_DATA_NOTE,
    };
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;

  try {
    const pool = getPool();
    const plan = await loadPlan(pool, req.query || {});
    if (plan?.error) return res.status(400).json({ success: false, error: plan.error });
    if (!plan) return res.status(404).json({ success: false, error: "shipping plan not found" });

    const orderServiceCols = await tableColumns(pool, "order_services");
    const explicitRows = await loadExplicitServices(pool, plan, orderServiceCols);
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      plan: {
        id: plan.id,
        plan_id: plan._id,
        bl_no: plan.bl_no || null,
        shipment_no: plan.shipment_no || null,
      },
      data: buildServices(plan, explicitRows),
    });
  } catch (err) {
    console.error("[order-services]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
