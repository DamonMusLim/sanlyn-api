import { getPool, setCors } from "../db.js";
import { loadFreeDays, resolvePortCode } from "../db/_free-days.js";
import { normalizeCarrier, normalizeChargeName } from "../db/lib/portcharge-close-loop.js";
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

function positiveAmount(v) {
  var n = amountOrNull(v);
  return n != null && n >= 0 ? n : null;
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
    var confidence = text(row.review_status) === "pending" ? "pending" : "confirmed";
    return {
      container_type: row.container_type,
      cost_category: feeCategory(row),
      fee_code: row.charge_item_code,
      rate: null,
      currency: "CNY",
      note: feeNote(row),
      fee_kind: row.conditional_flag ? "conditional" : "fixed",
      standard_confidence: confidence,
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

async function companyFullName(pool, companyId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(name_cn, ''), NULLIF(name_en, ''), code) AS name
       FROM companies
      WHERE id = $1
      LIMIT 1`,
    [companyId]
  );
  return text(rows[0] && rows[0].name);
}

function inputFees(body) {
  var fees = Array.isArray(body.fees) ? body.fees : Array.isArray(body.items) ? body.items : [];
  return fees.map(function(fee) {
    return {
      name: text(fee.name || fee.raw_name || fee.cost_category || fee.fee_name),
      amount: positiveAmount(fee.amount),
    };
  }).filter(function(fee) {
    return fee.name || fee.amount != null;
  });
}

function basisCode(unitBasis) {
  var basis = text(unitBasis).toLowerCase();
  if (basis === "container") return "per_ctn";
  if (basis === "bill") return "per_bl";
  if (basis === "seal") return "per_seal";
  return "";
}

async function loadChargeItem(pool, rawName, carrier) {
  const c = normCarrier(carrier || "*") || "*";
  const { rows } = await pool.query(
    `SELECT standard_item_code, standard_item_name, unit_basis, conditional_charge
       FROM carrier_tariff_charge_items
      WHERE (normalized_carrier = $1 OR normalized_carrier = '*')
        AND lower(btrim(raw_item_name)) = lower(btrim($2))
      ORDER BY (normalized_carrier = $1) DESC, confidence DESC NULLS LAST
      LIMIT 1`,
    [c, rawName]
  );
  return rows[0] || null;
}

function pickStandardRows(rows, carrier, pol, box) {
  var c = normCarrier(carrier);
  var p = localNormalizePort(pol);
  var b = normBox(box);
  var exact = rows.filter(function(row) {
    return normCarrier(row.carrier) === c
      && localNormalizePort(row.port) === p
      && normBox(row.container_type) === b;
  });
  if (exact.length) return exact;
  var lane = rows.filter(function(row) {
    return localNormalizePort(row.port) === p && normBox(row.container_type) === b;
  });
  if (lane.length) return lane;
  return rows.filter(function(row) { return normBox(row.container_type) === b; });
}

async function loadConditionalFlag(pool, code, carrier, pol, box, fallback) {
  const { rows } = await pool.query(
    `SELECT carrier, port, container_type, required_flag, conditional_flag, valid_from, version_id
       FROM carrier_tariff_standards
      WHERE lower(btrim(charge_item_code)) = lower(btrim($1))
        AND COALESCE(review_status, '') = 'confirmed'
        AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
        AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
      ORDER BY valid_from DESC NULLS LAST, version_id DESC NULLS LAST, id DESC`,
    [code]
  );
  var picked = pickStandardRows(rows, carrier, pol, box);
  if (!picked.length) return !!fallback;
  return picked.some(function(row) { return row.conditional_flag === true; });
}

async function normalizeSubmittedFee(pool, fee, carrier, pol, box) {
  var charge = await normalizeChargeName(pool, fee.name, carrier, "");
  if (charge.unmapped) return { unmapped: fee.name };
  var item = await loadChargeItem(pool, fee.name, carrier);
  var basis = basisCode(item && item.unit_basis);
  if (!item || !basis) return { unmapped: fee.name };
  var conditional = await loadConditionalFlag(
    pool,
    item.standard_item_code,
    carrier,
    pol,
    box,
    item.conditional_charge
  );
  return {
    line: {
      code: item.standard_item_code,
      name: item.standard_item_name,
      basis: basis,
      amount: fee.amount,
      conditional: conditional,
    },
  };
}

function totals(lines) {
  return lines.reduce(function(acc, line) {
    var amount = amountOrNull(line.amount) || 0;
    if (line.conditional) acc.conditional += amount;
    else acc.base += amount;
    return acc;
  }, { base:0, conditional:0 });
}

async function upsertLocalCharge(client, params) {
  const existing = await client.query(
    `SELECT id
       FROM local_charges
      WHERE lower(btrim(carrier)) = lower(btrim($1))
        AND lower(btrim(pol)) = lower(btrim($2))
        AND lower(btrim(pod)) = lower(btrim($3))
        AND lower(btrim(container_type)) = lower(btrim($4))
        AND lower(btrim(company_name)) = lower(btrim($5))
        AND COALESCE(is_active, true) IS TRUE
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 1
      FOR UPDATE`,
    [params.carrier, params.pol, params.pod, params.box, params.companyName]
  );
  var raw = {
    source: "forwarder_portal",
    token_code: params.tokenCode,
    unmapped: params.unmapped,
  };
  if (existing.rows.length) {
    const updated = await client.query(
      `UPDATE local_charges
          SET fees = $2::jsonb,
              base_total_cny = $3,
              conditional_total_cny = $4,
              cost_total = $3,
              charge_type = 'port_charge',
              currency = 'CNY',
              updated_by = $5,
              raw = COALESCE(raw, '{}'::jsonb) || $6::jsonb,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        existing.rows[0].id,
        JSON.stringify(params.lines),
        params.baseTotal,
        params.conditionalTotal,
        params.updatedBy,
        JSON.stringify(raw),
      ]
    );
    return { row: updated.rows[0], action: "updated" };
  }
  const inserted = await client.query(
    `INSERT INTO local_charges
       (carrier, pol, pod, container_type, company_name, fees, base_total_cny,
        conditional_total_cny, cost_total, charge_type, currency, is_active,
        updated_by, raw, valid_from)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$7,'port_charge','CNY',true,$9,$10::jsonb,CURRENT_DATE)
     RETURNING *`,
    [
      params.carrier,
      params.pol,
      params.pod,
      params.box,
      params.companyName,
      JSON.stringify(params.lines),
      params.baseTotal,
      params.conditionalTotal,
      params.updatedBy,
      JSON.stringify(raw),
    ]
  );
  return { row: inserted.rows[0], action: "inserted" };
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
        standard_confidence: "confirmed",
      };
      out.push(byKey[key]);
    }
    var box = normBox(row.container_type);
    if (text(row.standard_confidence) === "pending") {
      byKey[key].standard_confidence = "pending";
    }
    if (Object.prototype.hasOwnProperty.call(byKey[key].amounts, box)) {
      byKey[key].amounts[box] = text(row.standard_confidence) === "pending" ? null : amountOrNull(row.rate);
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

function pendingFeeCount(feeParts) {
  return [].concat(feeParts.fees || [], feeParts.conditional_fees || [])
    .filter(function(fee) { return text(fee.standard_confidence) === "pending"; }).length;
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
            review_status,
            (valid_from IS NOT NULL
             AND valid_from <= CURRENT_DATE
             AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)) AS effective_today
       FROM public.carrier_tariff_standards
      ORDER BY valid_from DESC NULLS LAST, version_id DESC, charge_item_code,
               charge_item_name, route_scope, station_name, container_type`
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
    standards_pending_count: pendingFeeCount(feeParts),
  };
  var warnings = [].concat(feeParts._warn || [], duplicateFeeWarnings(feeParts));
  if (warnings.length) body._warn = warnings;
  if (freeDayParts.free_days_reason) body.free_days_reason = freeDayParts.free_days_reason;
  if (freeDayParts.free_days_carrier) body.free_days_carrier = freeDayParts.free_days_carrier;
  return send(res, 200, body);
}

async function handlePost(pool, req, token, res) {
  var body = req.body || {};
  var carrier = normCarrier(body.carrier || body.carrier_code);
  var pol = text(body.pol);
  var pod = text(body.pod);
  var box = normBox(body.container_type || body.box);
  var fees = inputFees(body);
  if (!carrier || !pol || !pod || !box) {
    return send(res, 400, { ok: false, error: "carrier_pol_pod_container_type_required" });
  }
  if (!fees.length) return send(res, 400, { ok: false, error: "fees_required" });

  var companyName = await companyFullName(pool, token.company_id);
  if (!companyName) return send(res, 404, { ok: false, error: "company_not_found" });

  var lines = [];
  var unmapped = [];
  for (const fee of fees) {
    if (fee.amount == null) return send(res, 400, { ok: false, error: "fee_amount_required", fee_name: fee.name });
    var normalized = await normalizeSubmittedFee(pool, fee, carrier, pol, box);
    if (normalized.unmapped) unmapped.push(normalized.unmapped);
    if (normalized.line) lines.push(normalized.line);
  }
  if (unmapped.length) {
    return send(res, 422, { ok: false, error: "unmapped_fee_names", unmapped: unmapped });
  }
  var sum = totals(lines);
  var client = await pool.connect();
  try {
    await client.query("BEGIN");
    var saved = await upsertLocalCharge(client, {
      carrier: carrier,
      pol: pol,
      pod: pod,
      box: box,
      companyName: companyName,
      lines: lines,
      baseTotal: sum.base,
      conditionalTotal: sum.conditional,
      updatedBy: "portal:" + token.code,
      tokenCode: token.code,
      unmapped: unmapped,
    });
    await client.query("COMMIT");
    return send(res, 200, {
      ok: true,
      action: saved.action,
      local_charge: saved.row,
      unmapped: [],
      base_total_cny: sum.base,
      conditional_total_cny: sum.conditional,
      fees: lines,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    return send(res, 500, { ok: false, error: e.message });
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" });
  const pool = getPool();
  const code = cleanCode(req);
  const loaded = await loadToken(pool, code);
  if (loaded.error) return send(res, loaded.error, loaded.body);
  if (req.method === "POST") return handlePost(pool, req, loaded.token, res);
  return handleGet(pool, req, res);
}
