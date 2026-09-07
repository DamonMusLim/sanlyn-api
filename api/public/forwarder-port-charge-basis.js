import { getPool, setCors } from "../db.js";
import { normalizePort } from "../db/_official-port-charges.js";

const BOXES = ["20GP", "40GP", "40HQ"];
const FREE_DAYS_SOURCE = "维运网滞箱费计算器(船司官方标准)";

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

function normCarrier(v) {
  return text(v).toUpperCase().replace(/\s+/g, " ");
}

function normBox(v) {
  return text(v).toUpperCase().replace(/\s+/g, "").replace("HC", "HQ");
}

function amountOrNull(v) {
  if (v == null || v === "") return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function emptyAmounts() {
  return { "20GP": null, "40GP": null, "40HQ": null };
}

function emptyNotes() {
  return { "20GP": null, "40GP": null, "40HQ": null };
}

function emptyFreeDays() {
  return { "20GP": null, "40GP": null, "40HQ": null };
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

async function resolvePort(pool, pol) {
  var wanted = normalizePort(pol);
  if (!wanted) return { normalized: "", code: null, name_cn: "" };
  const { rows } = await pool.query(
    `SELECT code, name_cn, name_en
       FROM public.ports`
  );
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (
      normalizePort(row.code) === wanted ||
      normalizePort(row.name_cn) === wanted ||
      normalizePort(row.name_en) === wanted
    ) {
      return {
        normalized: wanted,
        code: text(row.code).toUpperCase() || null,
        name_cn: text(row.name_cn) || text(row.name_en) || text(pol),
      };
    }
  }
  return { normalized: wanted, code: null, name_cn: text(pol) };
}

function groupedFee(rows, feeKind) {
  var out = [];
  var byKey = {};
  rows.forEach(function(row) {
    if (text(row.fee_kind) !== feeKind) return;
    var key = [
      text(row.fee_code),
      text(row.cost_category),
      text(row.currency),
      text(row.fee_kind),
    ].join("\u0001");
    if (!byKey[key]) {
      byKey[key] = {
        fee_code: text(row.fee_code),
        cost_category: text(row.cost_category),
        amounts: emptyAmounts(),
        notes: emptyNotes(),
        currency: text(row.currency) || null,
        note: "",
        fee_kind: feeKind,
      };
      out.push(byKey[key]);
    }
    var box = normBox(row.container_type);
    if (Object.prototype.hasOwnProperty.call(byKey[key].amounts, box)) {
      byKey[key].amounts[box] = amountOrNull(row.rate);
      byKey[key].notes[box] = text(row.note) || null;
      var notes = BOXES.map(function(k) { return byKey[key].notes[k]; })
        .filter(Boolean)
        .filter(function(note, idx, arr) { return arr.indexOf(note) === idx; });
      byKey[key].note = notes.join(" | ");
    }
  });
  return out;
}

function duplicateFeeWarnings(feeParts) {
  var seen = {};
  var warned = {};
  var warnings = [];
  var rows = [].concat(feeParts.fees || [], feeParts.conditional_fees || []);
  rows.forEach(function(fee) {
    var name = text(fee.cost_category);
    if (!name) return;
    if (seen[name] && !warned[name]) {
      warned[name] = true;
      warnings.push("费目 " + name + " 出现多次");
    }
    seen[name] = true;
  });
  return warnings;
}

async function loadOfficialFees(pool, carrier, polNormalized) {
  const { rows } = await pool.query(
    `SELECT carrier_code, pol, container_type, cost_category, fee_code, rate, currency, note, fee_kind
       FROM public.freight_port_rates_official
      WHERE UPPER(TRIM(carrier_code)) = $1
      ORDER BY fee_kind, fee_code, cost_category, currency, note, container_type`,
    [carrier]
  );
  var matched = rows.filter(function(row) {
    return normalizePort(row.pol) === polNormalized;
  });
  return {
    fees: groupedFee(matched, "fixed"),
    conditional_fees: groupedFee(matched, "conditional"),
  };
}

async function loadFreeDays(pool, carrier, portCode, rawPol) {
  var freeDays = emptyFreeDays();
  if (!portCode) {
    return {
      free_days: freeDays,
      free_days_reason: "未能把 " + text(rawPol) + " 解析成五字码",
    };
  }
  const { rows } = await pool.query(
    `SELECT container_type, free_days
       FROM public.carrier_free_days
      WHERE UPPER(TRIM(carrier_code)) = $1
        AND UPPER(TRIM(port_code)) = $2
        AND direction = $3`,
    [carrier, portCode, "出口"]
  );
  rows.forEach(function(row) {
    var box = normBox(row.container_type);
    if (Object.prototype.hasOwnProperty.call(freeDays, box)) {
      freeDays[box] = amountOrNull(row.free_days);
    }
  });
  return { free_days: freeDays };
}

async function handleGet(pool, req, res) {
  var carrier = normCarrier(req.query && req.query.carrier);
  var rawPol = text(req.query && req.query.pol);
  if (!carrier || !rawPol) {
    return send(res, 400, { ok: false, error: "pol_carrier_required" });
  }

  var port = await resolvePort(pool, rawPol);
  var feeParts = await loadOfficialFees(pool, carrier, port.normalized);
  var freeDayParts = await loadFreeDays(pool, carrier, port.code, rawPol);
  var body = {
    ok: true,
    carrier: carrier,
    pol: port.name_cn || rawPol,
    pol_code: port.code,
    boxes: BOXES,
    fees: feeParts.fees,
    free_days: freeDayParts.free_days,
    free_days_source: FREE_DAYS_SOURCE,
    conditional_fees: feeParts.conditional_fees,
  };
  var warnings = duplicateFeeWarnings(feeParts);
  if (warnings.length) body._warn = warnings;
  if (freeDayParts.free_days_reason) body.free_days_reason = freeDayParts.free_days_reason;
  return send(res, 200, body);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "method_not_allowed" });
  const pool = getPool();
  const code = cleanCode(req);
  const loaded = await loadToken(pool, code);
  if (loaded.error) return send(res, loaded.error, loaded.body);
  return handleGet(pool, req, res);
}
