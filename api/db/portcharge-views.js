import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { normalizeCarrier, normalizeContainerType, num } from "./lib/portcharge-close-loop.js";

function clean(v) {
  return String(v ?? "").trim();
}

function money(v) {
  return Number(num(v).toFixed(2));
}

function feeAmount(f) {
  const total = f.amount ?? f.total ?? f.totalAmount;
  if (total !== undefined && total !== null && total !== "") return num(total);
  const unit = num(f.unitPrice ?? f.unit_price ?? f.price);
  const qty = num(f.qty ?? f.quantity ?? f.count) || 1;
  return unit * qty;
}

function feeName(f) {
  return clean(f.standard_item_name || f.name || f.feeName || f.cost_category || f.item || f.charge_name);
}

function feeBasis(f) {
  return clean(f.basis || f.unit_basis || f.charge_basis || f.unit || "");
}

function feeConditional(f) {
  return Boolean(f.conditional || f.conditional_charge || f.conditionalCharge);
}

function flattenFees(v) {
  if (!v) return [];
  let data = v;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (_) { return []; }
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.fees)) return data.fees;
  if (typeof data === "object") {
    if (feeName(data) || feeAmount(data)) return [data];
    return Object.entries(data).map(([name, amount]) => (
      typeof amount === "object" ? { name, ...amount } : { name, amount }
    ));
  }
  return [];
}

async function aliasMap(pool) {
  const r = await pool.query(
    `SELECT raw_item_name, standard_item_name FROM carrier_tariff_charge_items`
  );
  const m = new Map();
  for (const row of r.rows) {
    m.set(clean(row.raw_item_name).toUpperCase(), row.standard_item_name);
    m.set(clean(row.standard_item_name).toUpperCase(), row.standard_item_name);
  }
  return m;
}

function normItem(name, aliases) {
  const key = clean(name).toUpperCase();
  return aliases.get(key) || clean(name) || "未命名费目";
}

async function officialRows(pool, port, ct, carrier = "") {
  const params = [port, normalizeContainerType(ct)];
  let where = `port ILIKE $1 AND container_type = $2 AND review_status IN ('confirmed','pending')`;
  if (carrier) {
    params.push(normalizeCarrier(carrier));
    where += ` AND upper(carrier) = upper($${params.length})`;
  }
  const r = await pool.query(
    `SELECT DISTINCT ON (upper(carrier), COALESCE(station_name,''), charge_item_code)
            carrier, station_name, charge_item_code, charge_item_name, amount_cny, unit_basis, conditional_flag
       FROM carrier_tariff_standards
      WHERE ${where}
      ORDER BY upper(carrier), COALESCE(station_name,''), charge_item_code, valid_from DESC, id DESC`,
    params
  );
  return r.rows;
}

async function localRows(pool, port, ct, carrier = "") {
  const params = [port, normalizeContainerType(ct)];
  let where = `pol ILIKE $1 AND upper(container_type) = upper($2)`;
  if (carrier) {
    params.push(normalizeCarrier(carrier));
    where += ` AND upper(carrier) = upper($${params.length})`;
  }
  const r = await pool.query(
    `SELECT carrier, company_name, container_type, fees, base_total_cny,
            conditional_total_cny, markup_cny, cost_total, sell_total, updated_at
       FROM local_charges
      WHERE COALESCE(is_active,true) AND ${where}
      ORDER BY carrier, company_name, updated_at DESC NULLS LAST`,
    params
  );
  return r.rows;
}

function addFee(bucket, item, amount) {
  bucket[item] = money(num(bucket[item]) + num(amount));
}

function stationLabel(v) {
  return clean(v) || "未指定场站";
}

function officialItem(row, aliases) {
  return `${normItem(row.charge_item_name, aliases)} @ ${stationLabel(row.station_name)}`;
}

async function matrix(pool, q) {
  const port = clean(q.port || "青岛");
  const ct = normalizeContainerType(q.ct || "40HQ");
  const aliases = await aliasMap(pool);
  const official = await officialRows(pool, port, ct);
  const locals = await localRows(pool, port, ct);
  const carriers = new Map();
  for (const row of official) {
    const c = normalizeCarrier(row.carrier);
    if (!carriers.has(c)) carriers.set(c, { carrier: c, official: {}, official_rows: [], forwarders: {}, forwarders_status: "no_data" });
    const g = carriers.get(c);
    addFee(g.official, officialItem(row, aliases), row.amount_cny);
    g.official_rows.push({
      station_name: stationLabel(row.station_name),
      charge_item_name: normItem(row.charge_item_name, aliases),
      amount_cny: money(row.amount_cny),
      unit_basis: row.unit_basis || "",
    });
  }
  for (const row of locals) {
    const c = normalizeCarrier(row.carrier);
    const fwd = clean(row.company_name) || "未命名货代";
    if (!carriers.has(c)) carriers.set(c, { carrier: c, official: {}, official_rows: [], forwarders: {}, forwarders_status: "no_data" });
    const group = carriers.get(c).forwarders[fwd] || {};
    for (const fee of flattenFees(row.fees)) {
      if (feeConditional(fee)) continue;
      addFee(group, normItem(feeName(fee), aliases), feeAmount(fee));
    }
    carriers.get(c).forwarders[fwd] = group;
    carriers.get(c).forwarders_status = "ok";
  }
  return { view: "matrix", port, container_type: ct, carriers: [...carriers.values()] };
}

async function carrierView(pool, q) {
  const port = clean(q.port || "青岛");
  const ct = normalizeContainerType(q.ct || "40HQ");
  const carrier = normalizeCarrier(q.carrier || "");
  const aliases = await aliasMap(pool);
  const official = {};
  const official_rows = [];
  for (const row of await officialRows(pool, port, ct, carrier)) {
    addFee(official, officialItem(row, aliases), row.amount_cny);
    official_rows.push({
      station_name: stationLabel(row.station_name),
      charge_item_name: normItem(row.charge_item_name, aliases),
      amount_cny: money(row.amount_cny),
      unit_basis: row.unit_basis || "",
    });
  }
  const forwarders = {};
  for (const row of await localRows(pool, port, ct, carrier)) {
    const fwd = clean(row.company_name) || "未命名货代";
    forwarders[fwd] ||= {};
    for (const fee of flattenFees(row.fees)) {
      if (feeConditional(fee)) continue;
      addFee(forwarders[fwd], normItem(feeName(fee), aliases), feeAmount(fee));
    }
  }
  const items = [...new Set([...Object.keys(official), ...Object.values(forwarders).flatMap(Object.keys)])];
  return { view: "carrier", port, container_type: ct, carrier, official, official_rows, forwarders, forwarders_status: Object.keys(forwarders).length ? "ok" : "no_data", items };
}

async function lane(pool, q) {
  const ct = normalizeContainerType(q.ct || "40HQ");
  const priceCol = ct === "20GP" ? "gp20" : "hq40";
  const r = await pool.query(
    `SELECT f.pol, f.pod, f.carrier, f.forwarder, f.${priceCol} AS ocean_cost,
            lc.cost_total AS port_base, lc.company_name AS port_forwarder
       FROM freight_rates f
       LEFT JOIN LATERAL (
         SELECT COALESCE(base_total_cny,cost_total) AS cost_total, company_name FROM local_charges lc
          WHERE COALESCE(lc.is_active,true)
            AND upper(lc.container_type) = upper($1)
            AND lower(btrim(lc.pol)) = lower(btrim(f.pol))
            AND lower(btrim(lc.carrier)) = lower(btrim(f.carrier))
            AND (f.forwarder IS NULL OR lower(btrim(lc.company_name)) = lower(btrim(f.forwarder)))
          ORDER BY lc.updated_at DESC NULLS LAST LIMIT 1
       ) lc ON TRUE
      WHERE COALESCE(f.status,'active') <> 'withdrawn'
      ORDER BY f.pol, f.pod, f.carrier, (COALESCE(f.${priceCol},0) + COALESCE(lc.cost_total,0)) ASC`,
    [ct]
  );
  const groups = new Map();
  for (const row of r.rows) {
    const key = `${row.pol}|${row.pod}|${normalizeCarrier(row.carrier)}`;
    if (!groups.has(key)) groups.set(key, { pol: row.pol, pod: row.pod, carrier: normalizeCarrier(row.carrier), options: [] });
    groups.get(key).options.push({
      forwarder: row.forwarder || row.port_forwarder || "",
      ocean_cost: money(row.ocean_cost),
      port_base: money(row.port_base),
      total_cost: money(num(row.ocean_cost) + num(row.port_base)),
    });
  }
  for (const g of groups.values()) {
    g.options.sort((a, b) => a.total_cost - b.total_cost);
    if (g.options[0]) g.options[0].is_lowest = true;
  }
  return { view: "lane", container_type: ct, groups: [...groups.values()] };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    const view = clean(req.query.view || "matrix").toLowerCase();
    const data = view === "carrier" ? await carrierView(pool, req.query)
      : view === "lane" ? await lane(pool, req.query)
      : await matrix(pool, req.query);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
