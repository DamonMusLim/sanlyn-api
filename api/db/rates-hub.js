// 价表总台 · 五类价表只读聚合接口
// ⛔ 只读: 不建表、不改结构、不补 0、不默认币种。
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
  f.carrier, f.forwarder, f.currency,
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

export async function loadRatesHub(pool, q = {}) {
  const activeOnly = truthy(q.active_only, true);
  const ocean = buildOcean(q, activeOnly);
  const tariff = buildTariff(q, activeOnly);
  const matrices = buildMatrices(q, activeOnly);
  const matrixItems = buildMatrixItems(q, activeOnly);
  const local = buildLocal(q, activeOnly);
  const truck = buildTruck(q, activeOnly);
  const truckLegacy = buildTruckLegacy();
  const customs = buildCustoms(q, activeOnly);
  const insurance = buildInsurance(q);
  const [
    oceanRes, tariffRes, matricesRes, matrixItemsRes, localRes,
    truckRes, truckLegacyRes, customsRes, insuranceRes
  ] = await Promise.all([
    pool.query(ocean.sql, ocean.params),
    pool.query(tariff.sql, tariff.params),
    pool.query(matrices.sql, matrices.params),
    pool.query(matrixItems.sql, matrixItems.params),
    pool.query(local.sql, local.params),
    pool.query(truck.sql, truck.params),
    pool.query(truckLegacy.sql, truckLegacy.params),
    pool.query(customs.sql, customs.params),
    pool.query(insurance.sql, insurance.params),
  ]);
  return {
    data: {
      ocean: oceanRes.rows,
      tariff: tariffRes.rows,
      matrices: matricesRes.rows,
      matrix_items: matrixItemsRes.rows,
      local: localRes.rows,
      truck: truckRes.rows,
      truck_legacy: truckLegacyRes.rows,
      customs: customsRes.rows,
      insurance: insuranceRes.rows,
    },
    count: {
      ocean: oceanRes.rowCount,
      tariff: tariffRes.rowCount,
      matrices: matricesRes.rowCount,
      matrix_items: matrixItemsRes.rowCount,
      local: localRes.rowCount,
      truck: truckRes.rowCount,
      truck_legacy: truckLegacyRes.rowCount,
      customs: customsRes.rowCount,
      insurance: insuranceRes.rowCount,
    },
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const out = await loadRatesHub(getPool(), req.query);
    res.status(200).json({ success: true, data: out.data, count: out.count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

