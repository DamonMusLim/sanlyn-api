import { getPool, setCors } from "../db.js";
import { loadFreeDays, resolvePortCode } from "../db/_free-days.js";
import { normalizeCarrier } from "../db/lib/portcharge-close-loop.js";
import { localNormalizePort } from "./_lane-weeks.js";

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
  return normalizeCarrier(v).replace(/\s+/g, " ");
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

function unitBasisNote(v) {
  var basis = text(v);
  if (basis === "bill") return "计价单位:票";
  if (basis === "container") return "按柜";
  if (basis === "seal") return "按封";
  return basis ? "计价单位:" + basis : "";
}

function feeCategory(row) {
  var name = text(row.charge_item_name);
  var route = text(row.route_scope);
  return route ? name + "(" + route + ")" : name;
}

function feeNote(row) {
  var parts = [];
  var unit = unitBasisNote(row.unit_basis);
  if (unit) parts.push(unit);
  if (text(row.station_name)) parts.push("场站:" + text(row.station_name));
  if (text(row.raw_item_name) && text(row.raw_item_name) !== text(row.charge_item_name)) {
    parts.push("原名:" + text(row.raw_item_name));
  }
  return parts.join(" / ");
}

function tariffRows(rows) {
  return rows.map(function(row) {
    return {
      container_type: row.container_type,
      cost_category: feeCategory(row),
      fee_code: row.charge_item_code,
      rate: row.amount_cny,
      currency: "CNY",
      note: feeNote(row),
      fee_kind: row.conditional_flag ? "conditional" : "fixed",
    };
  });
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
  const statusStats = await pool.query(
    `SELECT review_status, COUNT(*)::int AS count
       FROM public.carrier_tariff_standards
      GROUP BY review_status
      ORDER BY review_status`
  );
  var hasConfirmed = statusStats.rows.some(function(row) {
    return text(row.review_status) === "confirmed" && Number(row.count) > 0;
  });
  const { rows } = await pool.query(
    `SELECT carrier, port, container_type, charge_item_code, charge_item_name,
            raw_item_name, amount_cny, unit_basis, conditional_flag,
            station_name, route_scope, version_id, valid_from, valid_to,
            (valid_from IS NOT NULL
             AND valid_from <= CURRENT_DATE
             AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)) AS effective_today
       FROM public.carrier_tariff_standards
      WHERE ($1::boolean IS FALSE OR review_status = 'confirmed')
      ORDER BY valid_from DESC NULLS LAST, version_id DESC, charge_item_code,
               charge_item_name, route_scope, station_name, container_type`,
    [hasConfirmed]
  );
  var matched = rows.filter(function(row) {
    return normCarrier(row.carrier) === carrier
      && localNormalizePort(row.port) === polNormalized;
  });
  var effective = matched.filter(function(row) { return row.effective_today === true; });
  var warnings = [];
  if (!hasConfirmed) warnings.push("标准价未经人工审核");
  if (!effective.length && matched.length) {
    var latest = matched[0];
    effective = matched.filter(function(row) {
      return row.version_id === latest.version_id && text(row.valid_from) === text(latest.valid_from);
    });
    warnings.push("标准价不在当前有效期，已取最新版本");
  }
  var feeRows = tariffRows(effective);
  return {
    fees: groupedFee(feeRows, "fixed"),
    conditional_fees: groupedFee(feeRows, "conditional"),
    _warn: warnings,
    _review_status_counts: statusStats.rows,
  };
}

async function handleGet(pool, req, res) {
  var carrier = normCarrier(req.query && req.query.carrier);
  var rawPol = text(req.query && req.query.pol);
  if (!carrier || !rawPol) {
    return send(res, 400, { ok: false, error: "pol_carrier_required" });
  }

  var port = await resolvePortCode(pool, rawPol);
  var feeParts = await loadOfficialFees(pool, carrier, localNormalizePort(rawPol));
  var freeDayParts = await loadFreeDays(pool, carrier, port.code, port.name_cn || rawPol);
  var body = {
    ok: true,
    carrier: carrier,
    pol: port.name_cn || rawPol,
    pol_code: port.code,
    boxes: BOXES,
    fees: feeParts.fees,
    free_days: freeDayParts.free_days,
    free_days_match: freeDayParts.free_days_match,
    free_days_source: FREE_DAYS_SOURCE,
    conditional_fees: feeParts.conditional_fees,
  };
  var warnings = [].concat(feeParts._warn || [], duplicateFeeWarnings(feeParts));
  if (warnings.length) body._warn = warnings;
  if (freeDayParts.free_days_reason) body.free_days_reason = freeDayParts.free_days_reason;
  if (freeDayParts.free_days_carrier) body.free_days_carrier = freeDayParts.free_days_carrier;
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
