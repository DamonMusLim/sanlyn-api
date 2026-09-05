import { getPool, setCors } from "../db.js";
import { normalizePort } from "../db/_official-port-charges.js";

function cleanCode(req) {
  var p = req.params && req.params.code;
  if (p) return String(p).split("?")[0].trim();
  var parts = String(req.url || "").split("?")[0].split("/").filter(Boolean);
  return (parts[parts.length - 1] || "").trim();
}

function send(res, status, body) {
  return res.status(status).json(body);
}

function text(v) {
  return String(v == null ? "" : v).trim();
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ymd(date) {
  var d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + "-" + (m < 10 ? "0" + m : String(m)) + "-" + (day < 10 ? "0" + day : String(day));
}

function dateOnly(v) {
  var s = text(v);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  return v ? ymd(v) : null;
}

function ts(v) {
  if (!v) return 0;
  var d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function normCarrier(v) {
  return text(v).toUpperCase().replace(/\s+/g, " ");
}

function normBox(v) {
  return text(v).toUpperCase().replace(/\s+/g, "").replace("HC", "HQ");
}

function cleanCurrency(v) {
  var s = text(v).toUpperCase();
  return s || "USD";
}

function sameLane(row, pol, pod) {
  return normalizePort(row.pol) === pol && normalizePort(row.pod) === pod;
}

function firstDate(row) {
  return row.valid_from || row.valid_to || row.etd || row.submitted_at || row.updated_at || "";
}

function parseDepartures(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    var parsed = JSON.parse(v || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function rateRows(row) {
  var base = {
    source: "freight_rates",
    gp20: numOrNull(row.gp20),
    hq40: numOrNull(row.hq40),
    valid_from: dateOnly(row.valid_from),
    valid_to: dateOnly(row.valid_to),
    status: row.status || null,
    rate_source: row.source || null,
    updated_at: row.updated_at || null,
    date: dateOnly(firstDate(row)),
    currency: cleanCurrency(row.currency),
  };
  var box = normBox(row.container_type);
  if (box === "20GP") {
    return [{ ...base, container_type: "20GP", amount: base.gp20 }];
  }
  if (box === "40HQ" || box === "40GP") {
    return [{ ...base, container_type: box, amount: base.hq40 }];
  }
  var out = [];
  if (base.gp20 != null) out.push({ ...base, container_type: "20GP", amount: base.gp20 });
  if (base.hq40 != null) out.push({ ...base, container_type: "40HQ", amount: base.hq40 });
  if (!out.length) out.push({ ...base, container_type: null, amount: null });
  return out;
}

async function loadToken(pool, code) {
  if (!code) return { error: 404, body: { ok: false, error: "not_found" } };
  const { rows } = await pool.query(
    `SELECT code, forwarder_co, company_id, expires_at
       FROM forwarder_portal_tokens
      WHERE code = $1
      LIMIT 1`,
    [code]
  );
  if (!rows.length) return { error: 404, body: { ok: false, error: "not_found" } };
  var token = rows[0];
  if (token.expires_at && new Date(token.expires_at) < new Date()) {
    return { error: 410, body: { ok: false, error: "expired", message: "链接已过期" } };
  }
  if (!token.company_id) {
    return { error: 403, body: { ok: false, error: "token missing company_id" } };
  }
  return { token: token };
}

async function loadRateHistory(pool, companyId, pol, pod, carrier) {
  const { rows } = await pool.query(
    `SELECT fr.gp20, fr.hq40, fr.currency, fr.valid_from, fr.valid_to, fr.status, fr.source,
            fr.updated_at, fr.pol, fr.pod
       FROM freight_rates fr
      WHERE fr.forwarder_company_id = $1
        AND upper(btrim(COALESCE(fr.carrier, ''))) = $2
      ORDER BY COALESCE(fr.valid_from, fr.updated_at::date) DESC NULLS LAST, fr.updated_at DESC NULLS LAST
      LIMIT 300`,
    [companyId, carrier]
  );
  return rows.filter(function(row) { return sameLane(row, pol, pod); }).slice(0, 30).flatMap(rateRows);
}

async function loadRfqHistory(pool, companyId, pol, pod, carrier) {
  const { rows } = await pool.query(
    `SELECT i.usd_rate, i.currency, i.container_type, i.vessel, i.etd, i.submitted_at, r.pol, r.pod
       FROM freight_rfq_items i
       JOIN freight_rfqs r ON r.id = i.rfq_id
      WHERE i.forwarder_company_id = $1
        AND upper(btrim(COALESCE(i.carrier, ''))) = $2
      ORDER BY i.submitted_at DESC NULLS LAST, i.etd DESC NULLS LAST
      LIMIT 300`,
    [companyId, carrier]
  );
  return rows.filter(function(row) { return sameLane(row, pol, pod); }).slice(0, 30).map(function(row) {
    return {
      source: "freight_rfq_items",
      usd_rate: numOrNull(row.usd_rate),
      amount: numOrNull(row.usd_rate),
      currency: cleanCurrency(row.currency),
      container_type: row.container_type || null,
      vessel: row.vessel || null,
      etd: dateOnly(row.etd),
      submitted_at: row.submitted_at || null,
      date: dateOnly(firstDate(row)),
    };
  });
}

async function loadShipmentHistory(pool, companyId, pol, pod, carrier) {
  const { rows } = await pool.query(
    `SELECT sp.freight_cost, sp.freight_cost_currency, sp.container_type, sp.etd, sp.bl_no, sp.shipment_no, sp.pol, sp.pod
       FROM shipping_plans sp
      WHERE sp.forwarder_company_id = $1
        AND upper(btrim(COALESCE(sp.carrier_code, ''))) = $2
      ORDER BY sp.etd DESC NULLS LAST, sp.id DESC
      LIMIT 300`,
    [companyId, carrier]
  );
  return rows.filter(function(row) { return sameLane(row, pol, pod); }).slice(0, 30).map(function(row) {
    return {
      source: "shipping_plans",
      freight_cost: numOrNull(row.freight_cost),
      amount: numOrNull(row.freight_cost),
      currency: cleanCurrency(row.freight_cost_currency),
      container_type: row.container_type || null,
      etd: dateOnly(row.etd),
      bl_no: row.bl_no || null,
      shipment_no: row.shipment_no || null,
      date: dateOnly(row.etd),
    };
  });
}

async function loadNextSailings(pool, pol, pod, carrier) {
  const { rows } = await pool.query(
    `SELECT ss.pol, ss.pod, ss.carrier_name, ss.next_sailing, ss.all_departures, ss.updated_at
       FROM ship_schedules ss
      WHERE upper(btrim(COALESCE(ss.carrier_name, ''))) = $1
      ORDER BY ss.updated_at DESC NULLS LAST
      LIMIT 100`,
    [carrier]
  );
  var today = ymd(new Date());
  var out = [];
  var seen = {};
  rows.forEach(function(row) {
    if (!sameLane(row, pol, pod)) return;
    var deps = parseDepartures(row.all_departures);
    if (!deps.length && row.next_sailing) deps = [{ etd: row.next_sailing }];
    deps.forEach(function(dep) {
      var etd = dateOnly(dep && dep.etd);
      if (!etd || etd < today) return;
      var entry = {
        vessel: (dep && dep.vessel) || null,
        voyage: (dep && dep.voyage) || null,
        etd: etd,
        eta: dateOnly(dep && dep.eta),
      };
      var key = [entry.vessel || "", entry.voyage || "", entry.etd, entry.eta || ""].join("|");
      if (seen[key]) return;
      seen[key] = true;
      out.push(entry);
    });
  });
  out.sort(function(a, b) { return String(a.etd).localeCompare(String(b.etd)); });
  return out.slice(0, 3);
}

async function handleGet(pool, token, req, res) {
  var pol = normalizePort(req.query && req.query.pol);
  var pod = normalizePort(req.query && req.query.pod);
  var carrier = normCarrier(req.query && req.query.carrier);
  if (!pol || !pod || !carrier) {
    return send(res, 400, { ok: false, error: "pol_pod_carrier_required" });
  }

  var parts = await Promise.all([
    loadRateHistory(pool, token.company_id, pol, pod, carrier),
    loadRfqHistory(pool, token.company_id, pol, pod, carrier),
    loadShipmentHistory(pool, token.company_id, pol, pod, carrier),
    loadNextSailings(pool, pol, pod, carrier),
  ]);
  var history = parts[0].concat(parts[1]).concat(parts[2]);
  history.sort(function(a, b) { return ts(firstDate(b)) - ts(firstDate(a)); });

  return send(res, 200, {
    ok: true,
    pol: pol,
    pod: pod,
    carrier: carrier,
    history: history.slice(0, 90),
    next_sailings: parts[3],
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "method_not_allowed" });
  const pool = getPool();
  const code = cleanCode(req);
  const loaded = await loadToken(pool, code);
  if (loaded.error) return send(res, loaded.error, loaded.body);
  return handleGet(pool, loaded.token, req, res);
}
