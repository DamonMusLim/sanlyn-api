import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const CARRIER_NORM = `COALESCE(NULLIF(COALESCE(
  (SELECT code FROM carriers c WHERE upper(c.code)=upper(btrim(%SRC%))),
  (SELECT canonical_code FROM carrier_aliases a WHERE a.raw_upper=upper(btrim(%SRC%))),
  upper(btrim(%SRC%))
), ''), 'UNKNOWN')`;

const PORT_NORM = `COALESCE(
  (SELECT p.name_en FROM ports p WHERE upper(p.name_en)=upper(btrim(%SRC%)) LIMIT 1),
  %SRC%
)`;

function truthy(v, fallback = true) {
  if (v === undefined || v === null || v === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(v).trim().toLowerCase());
}

function likeParam(params, value) {
  params.push(`%${String(value).trim()}%`);
  return `$${params.length}`;
}

function carrierParam(params, value) {
  params.push(String(value).trim());
  return `$${params.length}`;
}

function buildOcean(q, activeOnly) {
  const params = [];
  const conds = [`f.status IS DISTINCT FROM 'withdrawn'`];
  if (q.pol) conds.push(`COALESCE(pol_p.name_en, f.pol) ILIKE ${likeParam(params, q.pol)}`);
  if (q.pod) conds.push(`COALESCE(pod_p.name_en, f.pod) ILIKE ${likeParam(params, q.pod)}`);
  if (q.carrier) {
    const p = carrierParam(params, q.carrier);
    conds.push(CARRIER_NORM.replaceAll("%SRC%", "f.carrier") + " = " + CARRIER_NORM.replaceAll("%SRC%", p));
  }
  if (activeOnly) conds.push(`(f.valid_to IS NULL OR f.valid_to >= CURRENT_DATE)`);
  return {
    sql: `
SELECT f.id,
  COALESCE(pol_p.name_en, f.pol) AS pol,
  COALESCE(pod_p.name_en, f.pod) AS pod,
  f.pol AS pol_raw, f.pod AS pod_raw,
  f.carrier, f.forwarder, f.supplier_id, f.currency,
  f.route_code, f.via, f.thc, f.local_charge_code,
  f.gp20, f.hq40, f.customer_gp20, f.customer_hq40,
  f.official_gp20, f.official_hq40, f.profit_20gp, f.profit_40hq,
  to_char(f.valid_from,'YYYY-MM-DD') AS valid_from,
  to_char(f.valid_to,'YYYY-MM-DD') AS valid_to,
  f.status, f.source, f.remarks,
  to_char(f.sail_date,'YYYY-MM-DD') AS sail_date,
  f.vessel_name, f.voyage_no,
  to_char(f.eta_date,'YYYY-MM-DD') AS eta_date,
  to_char(f.doc_cutoff,'YYYY-MM-DD') AS doc_cutoff,
  to_char(f.cargo_cutoff,'YYYY-MM-DD') AS cargo_cutoff,
  f.transit_days, f.freetime, f.pol_port_id, f.pod_port_id
FROM freight_rates f
LEFT JOIN ports pol_p ON pol_p.id = f.pol_port_id
LEFT JOIN ports pod_p ON pod_p.id = f.pod_port_id
WHERE ${conds.join(" AND ")}
ORDER BY COALESCE(f.valid_to,'9999-12-31'::date) DESC, f.pol, f.pod, f.carrier, f.forwarder`,
    params
  };
}

function buildOceanPlans(q) {
  const params = [];
  const conds = [`sp.deleted_at IS NULL`];
  if (q.pol) conds.push(`COALESCE(pol_p.name_en, sp.pol) ILIKE ${likeParam(params, q.pol)}`);
  if (q.pod) conds.push(`COALESCE(pod_p.name_en, sp.pod) ILIKE ${likeParam(params, q.pod)}`);
  if (q.carrier) {
    const p = carrierParam(params, q.carrier);
    conds.push(CARRIER_NORM.replaceAll("%SRC%", "sp.carrier_code") + " = " + CARRIER_NORM.replaceAll("%SRC%", p));
  }
  return {
    sql: `
SELECT sp.id,
  sp.bl_no,
  COALESCE(pol_p.name_en, sp.pol) AS pol,
  COALESCE(pod_p.name_en, sp.pod) AS pod,
  sp.pol AS pol_raw, sp.pod AS pod_raw,
  sp.carrier_code, sp.forwarder_cn, sp.container_type, sp.container_qty,
  to_char(sp.etd,'YYYY-MM-DD') AS etd,
  sp.freight_cost, sp.freight_cost_currency, sp.freight_sale_usd, sp.shipment_no
FROM shipping_plans sp
LEFT JOIN ports pol_p ON pol_p.id = sp.pol_port_id
LEFT JOIN ports pod_p ON pod_p.id = sp.pod_port_id
WHERE ${conds.join(" AND ")}
ORDER BY sp.etd DESC NULLS LAST, sp.bl_no NULLS LAST, sp.shipment_no NULLS LAST, sp.id`,
    params
  };
}

function buildOceanBills(q) {
  const params = [];
  const conds = [`b.cost_category ILIKE '%海运%'`];
  if (q.pol) conds.push(`COALESCE(pol_p.name_en, sp.pol) ILIKE ${likeParam(params, q.pol)}`);
  if (q.pod) conds.push(`COALESCE(pod_p.name_en, sp.pod) ILIKE ${likeParam(params, q.pod)}`);
  if (q.carrier) {
    const p = carrierParam(params, q.carrier);
    conds.push(CARRIER_NORM.replaceAll("%SRC%", "COALESCE(sp.carrier_code, sp.shipping_line)") + " = " + CARRIER_NORM.replaceAll("%SRC%", p));
  }
  return {
    sql: `
SELECT b.id, b.bl_no, b.cost_category, b.currency, b.amount, b.sale_amount,
  b.supplier, b.bill_month, b.fee_status, COALESCE(b.remarks, b.reconcile_note) AS remarks
FROM freight_supplier_bills b
LEFT JOIN LATERAL (
  SELECT sp.*
  FROM shipping_plans sp
  WHERE sp.deleted_at IS NULL
    AND (
      (NULLIF(b.link_plan_id,'') IS NOT NULL AND sp.id::text = b.link_plan_id)
      OR (NULLIF(b.bl_no,'') IS NOT NULL AND sp.bl_no = b.bl_no)
    )
  ORDER BY (sp.id::text = b.link_plan_id) DESC, sp.id
  LIMIT 1
) sp ON true
LEFT JOIN ports pol_p ON pol_p.id = sp.pol_port_id
LEFT JOIN ports pod_p ON pod_p.id = sp.pod_port_id
WHERE ${conds.join(" AND ")}
ORDER BY b.bill_month DESC NULLS LAST, b.bl_no NULLS LAST, b.supplier, b.cost_category, b.id`,
    params
  };
}

function buildTariff(q, activeOnly) {
  const params = [];
  const conds = [];
  if (q.pol) conds.push(PORT_NORM.replaceAll("%SRC%", "t.port") + ` ILIKE ${likeParam(params, q.pol)}`);
  if (q.pod) conds.push(PORT_NORM.replaceAll("%SRC%", "t.port") + ` ILIKE ${likeParam(params, q.pod)}`);
  if (q.carrier) {
    const p = carrierParam(params, q.carrier);
    conds.push(CARRIER_NORM.replaceAll("%SRC%", "t.carrier") + " = " + CARRIER_NORM.replaceAll("%SRC%", p));
  }
  if (activeOnly) conds.push(`(t.valid_to IS NULL OR t.valid_to >= CURRENT_DATE)`);
  return {
    sql: `
SELECT t.id, t.carrier, ${PORT_NORM.replaceAll("%SRC%", "t.port")} AS port, t.port AS port_raw, t.container_type,
  t.charge_item_code, t.charge_item_name, t.amount_cny,
  t.unit_basis, t.required_flag, t.conditional_flag, t.station_name,
  to_char(t.valid_from,'YYYY-MM-DD') AS valid_from,
  to_char(t.valid_to,'YYYY-MM-DD') AS valid_to,
  t.review_status
FROM carrier_tariff_standards t
${conds.length ? "WHERE " + conds.join(" AND ") : ""}
ORDER BY t.carrier, t.port, t.container_type, t.required_flag DESC, t.charge_item_code, t.id`,
    params
  };
}

function matrixConds(q, activeOnly, alias, params) {
  const conds = [];
  if (q.pol) conds.push(PORT_NORM.replaceAll("%SRC%", `${alias}.pol`) + ` ILIKE ${likeParam(params, q.pol)}`);
  if (q.pod) conds.push(PORT_NORM.replaceAll("%SRC%", `${alias}.pod`) + ` ILIKE ${likeParam(params, q.pod)}`);
  if (q.carrier) {
    const p = carrierParam(params, q.carrier);
    conds.push(CARRIER_NORM.replaceAll("%SRC%", `${alias}.carrier_code`) + " = " + CARRIER_NORM.replaceAll("%SRC%", p));
  }
  if (activeOnly) conds.push(`${alias}.is_active IS TRUE AND (${alias}.valid_to IS NULL OR ${alias}.valid_to >= CURRENT_DATE)`);
  return conds;
}

function buildMatrices(q, activeOnly) {
  const params = [];
  const conds = matrixConds(q, activeOnly, "m", params);
  return {
    sql: `
SELECT m.code, m.forwarder_company_id, m.carrier_code,
  ${PORT_NORM.replaceAll("%SRC%", "m.pol")} AS pol,
  ${PORT_NORM.replaceAll("%SRC%", "m.pod")} AS pod,
  m.pol AS pol_raw, m.pod AS pod_raw,
  m.bl_type, m.free_days_origin, m.free_days_dest,
  m.total_cost_20gp, m.total_cost_40hq, m.cost_currency, m.is_active,
  to_char(m.valid_from,'YYYY-MM-DD') AS valid_from,
  to_char(m.valid_to,'YYYY-MM-DD') AS valid_to
FROM port_charge_matrices m
${conds.length ? "WHERE " + conds.join(" AND ") : ""}
ORDER BY m.carrier_code, m.pol, m.pod, m.forwarder_company_id, m.code`,
    params
  };
}

function buildMatrixItems(q, activeOnly) {
  const params = [];
  const conds = matrixConds(q, activeOnly, "m", params);
  return {
    sql: `
SELECT i.matrix_code, i.charge_name, i.currency, i.unit, i.container_type,
  i.unit_price, i.qty, i.amount, i.is_required, i.sort_order
FROM port_charge_matrix_items i
JOIN port_charge_matrices m ON m.code = i.matrix_code
${conds.length ? "WHERE " + conds.join(" AND ") : ""}
ORDER BY i.matrix_code, i.sort_order, i.charge_name`,
    params
  };
}

function buildLocal(q, activeOnly) {
  const params = [];
  const conds = [];
  if (q.pol) conds.push(PORT_NORM.replaceAll("%SRC%", "l.pol") + ` ILIKE ${likeParam(params, q.pol)}`);
  if (q.pod) conds.push(PORT_NORM.replaceAll("%SRC%", "l.pod") + ` ILIKE ${likeParam(params, q.pod)}`);
  if (q.carrier) {
    const p = carrierParam(params, q.carrier);
    conds.push(CARRIER_NORM.replaceAll("%SRC%", "l.carrier") + " = " + CARRIER_NORM.replaceAll("%SRC%", p));
  }
  if (activeOnly) conds.push(`l.is_active IS TRUE AND (l.valid_until IS NULL OR l.valid_until >= CURRENT_DATE)`);
  return {
    sql: `
SELECT l.id, l.carrier,
  ${PORT_NORM.replaceAll("%SRC%", "l.pol")} AS pol,
  ${PORT_NORM.replaceAll("%SRC%", "l.pod")} AS pod,
  l.pol AS pol_raw, l.pod AS pod_raw,
  l.company_name, l.container_type, l.charge_name, l.amount, l.currency,
  l.cost_total, l.sell_total, l.base_total_cny, l.markup_cny,
  to_char(l.valid_from,'YYYY-MM-DD') AS valid_from,
  to_char(l.valid_until,'YYYY-MM-DD') AS valid_until,
  l.is_active, l.free_time
FROM local_charges l
${conds.length ? "WHERE " + conds.join(" AND ") : ""}
ORDER BY l.carrier, l.pol, l.pod, l.company_name, l.container_type, l.charge_name, l.id`,
    params
  };
}

function buildTruck(q, activeOnly) {
  const params = [];
  const conds = [`s.service = 'truck'`];
  if (q.pol) conds.push(PORT_NORM.replaceAll("%SRC%", "s.pol") + ` ILIKE ${likeParam(params, q.pol)}`);
  if (q.pod) conds.push(PORT_NORM.replaceAll("%SRC%", "s.pod") + ` ILIKE ${likeParam(params, q.pod)}`);
  if (activeOnly) conds.push(`s.is_active IS TRUE AND (s.valid_to IS NULL OR s.valid_to >= CURRENT_DATE)`);
  return {
    sql: `
SELECT s.service, s.factory_name,
  ${PORT_NORM.replaceAll("%SRC%", "s.pol")} AS pol,
  ${PORT_NORM.replaceAll("%SRC%", "s.pod")} AS pod,
  s.pol AS pol_raw, s.pod AS pod_raw,
  s.container_type, s.tier, s.rate, s.currency, s.unit,
  to_char(s.valid_from,'YYYY-MM-DD') AS valid_from,
  to_char(s.valid_to,'YYYY-MM-DD') AS valid_to,
  s.is_active
FROM service_rates s
WHERE ${conds.join(" AND ")}
ORDER BY s.factory_name, s.pol, s.pod, s.container_type, s.tier`,
    params
  };
}

function buildTruckLegacy() {
  return { sql: `SELECT * FROM trucking_rates ORDER BY 1`, params: [] };
}

function buildCustoms(q, activeOnly) {
  const params = [];
  const conds = [];
  if (q.pol) conds.push(PORT_NORM.replaceAll("%SRC%", "c.pol") + ` ILIKE ${likeParam(params, q.pol)}`);
  if (activeOnly) conds.push(`(c.valid_to IS NULL OR c.valid_to >= CURRENT_DATE)`);
  return {
    sql: `
SELECT c.vendor_cn,
  ${PORT_NORM.replaceAll("%SRC%", "c.pol")} AS pol,
  c.pol AS pol_raw, c.base_fee, c.extra_per_desc, c.max_free_descs,
  c.currency, c.notes,
  to_char(c.valid_from,'YYYY-MM-DD') AS valid_from,
  to_char(c.valid_to,'YYYY-MM-DD') AS valid_to
FROM customs_rates c
${conds.length ? "WHERE " + conds.join(" AND ") : ""}
ORDER BY c.pol, c.vendor_cn`,
    params
  };
}

function buildInsurance(q) {
  const params = [];
  const conds = [];
  if (q.pol) conds.push(PORT_NORM.replaceAll("%SRC%", "i.pol") + ` ILIKE ${likeParam(params, q.pol)}`);
  if (q.pod) conds.push(PORT_NORM.replaceAll("%SRC%", "i.pod") + ` ILIKE ${likeParam(params, q.pod)}`);
  return {
    sql: `
SELECT i.bl_no, i.insured_name, i.policyholder_name, i.markup_pct,
  i.insured_amount, i.invoice_amount, i.currency, i.status,
  ${PORT_NORM.replaceAll("%SRC%", "i.pol")} AS pol,
  ${PORT_NORM.replaceAll("%SRC%", "i.pod")} AS pod,
  i.pol AS pol_raw, i.pod AS pod_raw,
  to_char(i.etd,'YYYY-MM-DD') AS etd,
  i.vessel_voyage, i.cargo_description,
  s.insurance_required, s.insurance_rate, s.insurance_cost,
  s.insurance_policy_no, s.insurance_cn
FROM insurance_policies i
LEFT JOIN (
  SELECT DISTINCT ON (bl_no) bl_no, insurance_required, insurance_rate, insurance_cost,
    insurance_policy_no, insurance_cn
  FROM shipping_plans
  WHERE bl_no IS NOT NULL
  ORDER BY bl_no
) s ON s.bl_no = i.bl_no
${conds.length ? "WHERE " + conds.join(" AND ") : ""}
ORDER BY i.etd DESC NULLS LAST, i.bl_no`,
    params
  };
}

const SOURCE_META = {
  ocean: { table: "freight_rates", required: ["pol", "pod", "carrier", "forwarder", "gp20", "hq40", "valid_to"], needed: ["id", "pol", "pod", "carrier", "forwarder", "currency", "gp20", "hq40", "customer_gp20", "customer_hq40", "official_gp20", "official_hq40", "profit_20gp", "profit_40hq", "valid_from", "valid_to", "status", "source", "remarks", "sail_date", "vessel_name", "voyage_no", "eta_date", "doc_cutoff", "cargo_cutoff", "transit_days", "freetime", "pol_port_id", "pod_port_id"], joined: { ports: ["id", "name_en"] } },
  ocean_plans: { table: "shipping_plans", required: ["bl_no", "pol", "pod", "carrier_code", "freight_cost", "freight_cost_currency", "freight_sale_usd"], needed: ["id", "deleted_at", "bl_no", "pol", "pod", "carrier_code", "forwarder_cn", "container_type", "container_qty", "etd", "freight_cost", "freight_cost_currency", "freight_sale_usd", "shipment_no", "pol_port_id", "pod_port_id"], joined: { ports: ["id", "name_en"] } },
  ocean_bills: { table: "freight_supplier_bills", required: ["bl_no", "cost_category", "currency", "amount", "supplier", "bill_month"], needed: ["id", "bl_no", "cost_category", "currency", "amount", "sale_amount", "supplier", "bill_month", "fee_status", "remarks", "reconcile_note", "link_plan_id"], joined: { shipping_plans: ["id", "deleted_at", "bl_no", "pol", "pod", "shipping_line", "carrier_code", "pol_port_id", "pod_port_id"], ports: ["id", "name_en"] } },
  tariff: { table: "carrier_tariff_standards", required: ["carrier", "port", "container_type", "charge_item_name", "amount_cny", "unit_basis"], needed: ["id", "carrier", "port", "container_type", "charge_item_code", "charge_item_name", "amount_cny", "unit_basis", "required_flag", "conditional_flag", "station_name", "valid_from", "valid_to", "review_status"], joined: { ports: ["name_en"] } },
  matrices: { table: "port_charge_matrices", required: ["code", "carrier_code", "pol", "pod", "total_cost_20gp", "total_cost_40hq", "cost_currency"], needed: ["code", "forwarder_company_id", "carrier_code", "pol", "pod", "bl_type", "free_days_origin", "free_days_dest", "total_cost_20gp", "total_cost_40hq", "cost_currency", "is_active", "valid_from", "valid_to"], joined: { ports: ["name_en"] } },
  matrix_items: { table: "port_charge_matrix_items", required: ["matrix_code", "charge_name", "unit_price", "amount", "currency"], needed: ["matrix_code", "charge_name", "currency", "unit", "container_type", "unit_price", "qty", "amount", "is_required", "sort_order"] },
  local: { table: "local_charges", required: ["carrier", "pol", "pod", "company_name", "charge_name", "amount", "currency"], needed: ["id", "carrier", "pol", "pod", "company_name", "container_type", "charge_name", "amount", "currency", "cost_total", "sell_total", "base_total_cny", "markup_cny", "valid_from", "valid_until", "is_active", "free_time"], joined: { ports: ["name_en"] } },
  truck: { table: "service_rates", required: ["factory_name", "pol", "container_type", "tier", "rate", "currency", "unit"], needed: ["service", "factory_name", "pol", "pod", "container_type", "tier", "rate", "currency", "unit", "valid_from", "valid_to", "is_active"], joined: { ports: ["name_en"] } },
  truck_legacy: { table: "trucking_rates", required: ["id"], needed: ["id"] },
  customs: { table: "customs_rates", required: ["vendor_cn", "pol", "base_fee", "max_free_descs", "extra_per_desc", "currency"], needed: ["vendor_cn", "pol", "base_fee", "extra_per_desc", "max_free_descs", "currency", "notes", "valid_from", "valid_to"], joined: { ports: ["name_en"] } },
  insurance: { table: "insurance_policies", required: ["bl_no", "insured_name", "policyholder_name", "invoice_amount", "insured_amount", "markup_pct", "insurance_rate"], needed: ["bl_no", "insured_name", "policyholder_name", "markup_pct", "insured_amount", "invoice_amount", "currency", "status", "pol", "pod", "etd", "vessel_voyage", "cargo_description"], joined: { shipping_plans: ["bl_no", "insurance_required", "insurance_rate", "insurance_cost", "insurance_policy_no", "insurance_cn"], ports: ["name_en"] } },
};

function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

function pct(filled, total) {
  if (!total) return null;
  return Math.round((filled * 1000) / total) / 10;
}

async function tableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(r.rows[0]?.name);
}

async function tableColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function sourceCoverage(key, rows, cols, missingTable = false) {
  const meta = SOURCE_META[key], total = rows.length;
  const fields = meta.required.map((name) => {
    if (missingTable || (!cols.has(name) && !rows.some((r) => Object.prototype.hasOwnProperty.call(r, name)))) return { name, state: "not_connected", filled: 0, total, fill_rate: null };
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, state: "ready", filled, total, fill_rate: pct(filled, total) };
  });
  return {
    table: meta.table,
    state: missingTable || !total || fields.some((f) => f.state !== "ready") ? "not_connected" : "ready",
    missing_fields: missingTable || !total ? meta.required : meta.required.filter((name) => !cols.has(name)),
    total_rows: total,
    fields,
  };
}

async function runSource(pool, key, built) {
  const meta = SOURCE_META[key];
  if (!(await tableExists(pool, meta.table))) return { rows: [], coverage: sourceCoverage(key, [], new Set(), true) };
  const cols = await tableColumns(pool, meta.table);
  const missingNeeded = meta.needed.filter((name) => !cols.has(name));
  const joinedCols = new Set(), missingJoined = [];
  for (const [table, names] of Object.entries(meta.joined || {})) {
    if (!(await tableExists(pool, table))) {
      names.forEach((name) => missingJoined.push(`${table}.${name}`));
      continue;
    }
    const c = await tableColumns(pool, table);
    names.forEach((name) => { if (c.has(name)) joinedCols.add(name); else missingJoined.push(`${table}.${name}`); });
  }
  if (missingNeeded.length || missingJoined.length) {
    const coverage = sourceCoverage(key, [], cols, false);
    coverage.missing_fields = [...new Set(coverage.missing_fields.concat(missingNeeded, missingJoined))];
    return { rows: [], coverage };
  }
  const r = await pool.query(built.sql, built.params);
  return { rows: r.rows, coverage: sourceCoverage(key, r.rows, new Set([...cols, ...joinedCols]), false) };
}

export async function loadRatesHub(pool, q = {}) {
  const activeOnly = truthy(q.active_only, false);
  const built = {
    ocean: buildOcean(q, activeOnly),
    ocean_plans: buildOceanPlans(q),
    ocean_bills: buildOceanBills(q),
    tariff: buildTariff(q, activeOnly),
    matrices: buildMatrices(q, activeOnly),
    matrix_items: buildMatrixItems(q, activeOnly),
    local: buildLocal(q, activeOnly),
    truck: buildTruck(q, activeOnly),
    truck_legacy: buildTruckLegacy(),
    customs: buildCustoms(q, activeOnly),
    insurance: buildInsurance(q),
  };
  const keys = Object.keys(built);
  const packs = await Promise.all(keys.map((key) => runSource(pool, key, built[key])));
  const byKey = Object.fromEntries(keys.map((key, i) => [key, packs[i]]));
  return {
    data: {
      ocean: byKey.ocean.rows,
      ocean_plans: byKey.ocean_plans.rows,
      ocean_bills: byKey.ocean_bills.rows,
      tariff: byKey.tariff.rows,
      matrices: byKey.matrices.rows,
      matrix_items: byKey.matrix_items.rows,
      local: byKey.local.rows,
      truck: byKey.truck.rows,
      truck_legacy: byKey.truck_legacy.rows,
      customs: byKey.customs.rows,
      insurance: byKey.insurance.rows,
    },
    count: Object.fromEntries(keys.map((key) => [key, byKey[key].rows.length])),
    coverage: Object.fromEntries(keys.map((key) => [key, byKey[key].coverage])),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const out = await loadRatesHub(getPool(), req.query);
    res.status(200).json({ success: true, generated_at: new Date().toISOString(), data: out.data, count: out.count, coverage: out.coverage });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
