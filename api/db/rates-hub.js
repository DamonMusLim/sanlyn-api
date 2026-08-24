// 价表总台 · 三张价表只读聚合接口
// ⛔ 只读: 不建表、不改结构、不补 0、不默认币种。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const CARRIER_NORM = `COALESCE(NULLIF(COALESCE(
  (SELECT code FROM carriers c WHERE upper(c.code)=upper(btrim(%SRC%))),
  (SELECT canonical_code FROM carrier_aliases a WHERE a.raw_upper=upper(btrim(%SRC%))),
  upper(btrim(%SRC%))
), ''), 'UNKNOWN')`;

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
  if (q.pol) conds.push(`t.port ILIKE ${likeParam(params, q.pol)}`);
  if (q.pod) conds.push(`t.port ILIKE ${likeParam(params, q.pod)}`);
  if (q.carrier) {
    const p = carrierParam(params, q.carrier);
    conds.push(CARRIER_NORM.replaceAll("%SRC%", "t.carrier") + " = " + CARRIER_NORM.replaceAll("%SRC%", p));
  }
  if (activeOnly) conds.push(`(t.valid_to IS NULL OR t.valid_to >= CURRENT_DATE)`);
  return {
    sql: `
SELECT t.id, t.carrier, t.port, t.container_type,
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

function buildLocal(q, activeOnly) {
  const params = [];
  const conds = [];
  if (q.pol) conds.push(`l.pol ILIKE ${likeParam(params, q.pol)}`);
  if (q.pod) conds.push(`l.pod ILIKE ${likeParam(params, q.pod)}`);
  if (q.carrier) {
    const p = carrierParam(params, q.carrier);
    conds.push(CARRIER_NORM.replaceAll("%SRC%", "l.carrier") + " = " + CARRIER_NORM.replaceAll("%SRC%", p));
  }
  if (activeOnly) conds.push(`l.is_active IS TRUE AND (l.valid_until IS NULL OR l.valid_until >= CURRENT_DATE)`);
  return {
    sql: `
SELECT l.id, l.carrier, l.pol, l.pod, l.company_name, l.container_type,
  l.charge_name, l.amount, l.currency,
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

export async function loadRatesHub(pool, q = {}) {
  const activeOnly = truthy(q.active_only, true);
  const ocean = buildOcean(q, activeOnly);
  const tariff = buildTariff(q, activeOnly);
  const local = buildLocal(q, activeOnly);
  const [oceanRes, tariffRes, localRes] = await Promise.all([
    pool.query(ocean.sql, ocean.params),
    pool.query(tariff.sql, tariff.params),
    pool.query(local.sql, local.params),
  ]);
  return {
    data: { ocean: oceanRes.rows, tariff: tariffRes.rows, local: localRes.rows },
    count: { ocean: oceanRes.rowCount, tariff: tariffRes.rowCount, local: localRes.rowCount },
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

