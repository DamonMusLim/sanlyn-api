// GET/PATCH /api/db/order-services?plan_id= or ?bl_no=
// Service item lens. Unknown service state must stay no_data.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  ORDER_SERVICE_DERIVED_COLUMNS,
  ORDER_SERVICE_ITEMS,
  isOrderServiceCode,
} from "../constants/order-services.js";

const NO_DATA_NOTE = "未接入: 缺服务项目真源字段";

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

async function tableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(r.rows[0]?.name);
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

function orderServiceReady(cols) {
  return cols.has("service_type") && (cols.has("plan_id") || cols.has("shipping_plan_id") || cols.has("bl_no"));
}

async function loadExplicitServices(pool, plan, cols) {
  if (!orderServiceReady(cols)) return [];

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

async function loadCoverage(pool, cols, totalPlans) {
  const byCode = new Map();
  if (orderServiceReady(cols)) {
    const identity = cols.has("plan_id") ? "plan_id::text" : (cols.has("shipping_plan_id") ? "shipping_plan_id::text" : "bl_no");
    const r = await pool.query(
      `SELECT upper(service_type::text) AS code, COUNT(DISTINCT ${identity})::int AS filled
         FROM order_services
        WHERE service_type IS NOT NULL
        GROUP BY upper(service_type::text)`
    );
    r.rows.forEach((x) => byCode.set(x.code, x.filled));
  }

  const derived = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE trucking_arrange IS NOT NULL AND btrim(trucking_arrange::text) <> '')::int AS trucking,
       COUNT(*) FILTER (WHERE customs_arrange IS NOT NULL AND btrim(customs_arrange::text) <> '')::int AS customs,
       COUNT(*) FILTER (WHERE insurance_required IS NOT NULL)::int AS insurance
     FROM shipping_plans
     WHERE deleted_at IS NULL`
  );
  const d = derived.rows[0] || {};
  return { explicit: byCode, total: totalPlans || d.total || 0, derived: d };
}

function coverageText(filled, total) {
  if (!total) return "未接入";
  return `样本 ${total} 行，已填 ${filled || 0} 行`;
}

function sourceFieldsFor(item) {
  const fields = ["order_services.service_type"];
  const rule = ORDER_SERVICE_DERIVED_COLUMNS[item.code];
  if (rule) fields.push(`shipping_plans.${rule.column}`);
  return fields;
}

function coverageFor(item, coverage) {
  const explicit = coverage.explicit.get(item.code) || 0;
  const derivedKey = item.code.toLowerCase();
  const derived = Number(coverage.derived[derivedKey] || 0);
  return { filled: explicit + derived, total: Number(coverage.total || 0) };
}

function buildServices(plan, explicitRows, coverage) {
  const explicit = new Map();
  for (const row of explicitRows) {
    const code = clean(row.service_type, 80).toUpperCase();
    if (isOrderServiceCode(code)) explicit.set(code, row);
  }

  return ORDER_SERVICE_ITEMS.map((item) => {
    const row = explicit.get(item.code);
    if (row) {
      const c = coverageFor(item, coverage);
      return {
        code: item.code,
        name_zh: item.zh,
        state: "selected",
        source: "explicit",
        stored_source: row.source || null,
        source_fields: sourceFieldsFor(item),
        fill_rate: coverageText(c.filled, c.total),
      };
    }

    const derived = derivedServiceState(item, plan);
    if (derived) {
      const c = coverageFor(item, coverage);
      return { ...derived, source_fields: sourceFieldsFor(item), fill_rate: coverageText(c.filled, c.total) };
    }

    const c = coverageFor(item, coverage);
    return {
      code: item.code,
      name_zh: item.zh,
      state: "no_data",
      source: null,
      note: NO_DATA_NOTE,
      missing_fields: sourceFieldsFor(item),
      fill_rate: coverageText(c.filled, c.total),
    };
  });
}

function normalizeServices(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    const code = clean(raw, 80).toUpperCase();
    if (!isOrderServiceCode(code)) return null;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

function planWhere(plan, cols, vals) {
  const conds = [];
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
  return conds.join(" OR ");
}

async function saveExplicitServices(pool, plan, cols, services) {
  if (!cols.has("service_type") || !cols.has("source") || !(cols.has("plan_id") || cols.has("shipping_plan_id"))) {
    return { notConnected: "缺 order_services.service_type + source + plan_id/shipping_plan_id" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const vals = [];
    const where = planWhere(plan, cols, vals);
    await client.query(`DELETE FROM order_services WHERE source = 'explicit' AND (${where})`, vals);

    for (const code of services) {
      const names = [];
      const placeholders = [];
      const rowVals = [];
      if (cols.has("plan_id")) { names.push("plan_id"); rowVals.push(plan.id); placeholders.push(`$${rowVals.length}`); }
      else { names.push("shipping_plan_id"); rowVals.push(plan.id); placeholders.push(`$${rowVals.length}`); }
      if (cols.has("bl_no")) { names.push("bl_no"); rowVals.push(plan.bl_no || null); placeholders.push(`$${rowVals.length}`); }
      names.push("service_type"); rowVals.push(code); placeholders.push(`$${rowVals.length}`);
      if (cols.has("source")) { names.push("source"); rowVals.push("explicit"); placeholders.push(`$${rowVals.length}`); }
      if (cols.has("created_at")) { names.push("created_at"); placeholders.push("now()"); }
      if (cols.has("updated_at")) { names.push("updated_at"); placeholders.push("now()"); }
      await client.query(`INSERT INTO order_services (${names.join(",")}) VALUES (${placeholders.join(",")})`, rowVals);
    }
    await client.query("COMMIT");
    return { success: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "PATCH") return res.status(405).json({ success: false, error: "GET/PATCH required" });
  if (!requireAuth(req, res)) return;

  try {
    const pool = getPool();
    const query = req.method === "PATCH" ? { ...(req.query || {}), ...(req.body || {}) } : (req.query || {});
    const plan = await loadPlan(pool, query);
    if (plan?.error) return res.status(400).json({ success: false, error: plan.error });
    if (!plan) return res.status(404).json({ success: false, error: "shipping plan not found" });

    const exists = await tableExists(pool, "order_services");
    const orderServiceCols = exists ? await tableColumns(pool, "order_services") : new Set();
    if (req.method === "PATCH") {
      const services = normalizeServices(req.body?.services);
      if (!services) return res.status(400).json({ success: false, error: "services must be 12-item enum codes only" });
      const saved = await saveExplicitServices(pool, plan, orderServiceCols, services);
      if (saved.notConnected) return res.status(409).json({ success: false, state: "not_connected", error: saved.notConnected });
    }

    const explicitRows = await loadExplicitServices(pool, plan, orderServiceCols);
    const total = await pool.query("SELECT COUNT(*)::int AS n FROM shipping_plans WHERE deleted_at IS NULL");
    const coverage = await loadCoverage(pool, orderServiceCols, total.rows[0]?.n || 0);
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      writable: exists && orderServiceCols.has("service_type") && orderServiceCols.has("source") && (orderServiceCols.has("plan_id") || orderServiceCols.has("shipping_plan_id")),
      missing_setup: exists ? [] : ["order_services"],
      plan: {
        id: plan.id,
        plan_id: plan._id,
        bl_no: plan.bl_no || null,
        shipment_no: plan.shipment_no || null,
      },
      data: buildServices(plan, explicitRows, coverage),
    });
  } catch (err) {
    console.error("[order-services]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
