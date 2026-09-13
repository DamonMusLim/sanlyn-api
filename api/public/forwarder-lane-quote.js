import { getPool, setCors } from "../db.js";
import { normalizePort } from "../db/_official-port-charges.js";
import { containerType } from "./_container-type.js";
import { upsertRate } from "./_forwarder-lane-rates.js";

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

function positiveNumber(v) {
  var n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nullableNumber(v) {
  if (v == null || v === "") return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ymd(date) {
  // 2026-09-06 修:原来用 toISOString().slice(0,10) 取的是 UTC 日期。
  // 服务器在东八区,00:00-08:00 之间 UTC 还停在前一天 —— 实测 9/6 00:32 CST 提交,
  // 有效期被写成 9/5~9/12,货代少拿一天。日期一律按服务器本地日算。
  var d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + "-" + (m < 10 ? "0" + m : String(m)) + "-" + (day < 10 ? "0" + day : String(day));
}

function addDays(date, days) {
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + days);   // 同上:本地日推进,不用 setUTCDate
  return d;
}

function cleanDate(v) {
  var s = text(v);
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  return ymd(s);
}

function route(pol, pod) {
  return pol + "→" + pod;
}

async function loadActiveContainerTypes(pool) {
  const { rows } = await pool.query(
    `SELECT code
       FROM container_types
      WHERE is_active`
  );
  return new Set(rows.map(function(row) {
    return text(row.code).toUpperCase();
  }).filter(Boolean));
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

async function loadCompany(pool, companyId) {
  const { rows } = await pool.query(
    `SELECT code AS company_code, name_cn
       FROM companies
      WHERE id = $1
      LIMIT 1`,
    [companyId]
  );
  if (!rows.length) return null;
  return {
    company_code: text(rows[0].company_code),
    name_cn: text(rows[0].name_cn),
  };
}

async function findOrCreateRfq(client, line) {
  const found = await client.query(
    `SELECT id
       FROM freight_rfqs r
      WHERE lower(btrim(r.pol)) = lower(btrim($1))
        AND lower(btrim(r.pod)) = lower(btrim($2))
        AND COALESCE(r.ctnr_type, '') = $3
        AND COALESCE(r.service_type, 'ocean') = 'ocean'
        AND r.status = 'open'
      ORDER BY r.created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [line.pol, line.pod, line.container_type]
  );
  if (found.rows.length) return found.rows[0].id;

  const ins = await client.query(
    `INSERT INTO freight_rfqs
       (id, route, pol, pod, ctnr_type, status, service_type, created_by,
        created_at, updated_at, request_meta)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'open', 'ocean', 'portal',
        now(), now(), $5::jsonb)
     RETURNING id`,
    [
      route(line.pol, line.pod),
      line.pol,
      line.pod,
      line.container_type,
      JSON.stringify({
        source: "portal_lane_quote",
        forwarder_company_id: line.forwarder_company_id,
      }),
    ]
  );
  return ins.rows[0].id;
}

async function upsertItem(client, rfqId, line) {
  const detail = {
    week_idx: line.week_idx,
    week_from: line.week_from,
    week_to: line.week_to,
    etd: line.etd,
    vessel: line.vessel,
    voyage: line.voyage,
    guaranteed_usd: line.guaranteed_usd,
    unguaranteed_usd: line.unguaranteed_usd,
    penalty_cny: line.penalty_cny,
    deposit_cny: line.deposit_cny,
    submitted_at: ymd(new Date()),
  };
  const upd = await client.query(
    `UPDATE freight_rfq_items
        SET usd_rate = $5,
            currency = 'USD',
            status = 'quoted',
            vessel = $6,
            voyage = $7,
            etd = $8::date,
            forwarder_co = $9,
            forwarder_company_id = $10,
            submitted_at = COALESCE(submitted_at, now()),
            quote_detail_json = CASE
              WHEN quote_detail_json IS NULL THEN jsonb_build_array($11::jsonb)
              WHEN jsonb_typeof(quote_detail_json) = 'array' THEN quote_detail_json || $11::jsonb
              ELSE jsonb_build_array(quote_detail_json, $11::jsonb)
            END
      WHERE rfq_id = $1
        AND forwarder_company_id = $2
        AND COALESCE(carrier, '') = COALESCE($3, '')
        AND COALESCE(container_type, '') = COALESCE($4, '')
        AND COALESCE(etd::date::text, '') = COALESCE($12::text, '')
      RETURNING id`,
    [
      rfqId,
      line.forwarder_company_id,
      line.carrier,
      line.container_type,
      line.unguaranteed_usd,
      line.vessel,
      line.voyage,
      line.etd,
      line.forwarder_name,
      line.forwarder_company_id,
      JSON.stringify(detail),
      line.etd,
    ]
  );
  if (upd.rows.length) return upd.rows[0].id;

  const ins = await client.query(
    `INSERT INTO freight_rfq_items
       (id, rfq_id, forwarder_co, forwarder_company_id, vessel, voyage, etd,
        usd_rate, currency, status, container_type, carrier, submitted_at, quote_detail_json)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::date, $7, 'USD', 'quoted', $8,
        $9, now(), $10::jsonb)
     RETURNING id`,
    [
      rfqId,
      line.forwarder_name,
      line.forwarder_company_id,
      line.vessel,
      line.voyage,
      line.etd,
      line.unguaranteed_usd,
      line.container_type,
      line.carrier,
      JSON.stringify(detail),
    ]
  );
  return ins.rows[0].id;
}

function lineValidTo(line, bodyValidTo, defaultValidTo) {
  var etd = cleanDate(line && line.etd);
  var weekTo = cleanDate(line && line.week_to);
  if (etd) return { value: etd, source: "etd", etd: etd, week_to: weekTo };
  if (weekTo) return { value: weekTo, source: "week_to", etd: etd, week_to: weekTo };
  if (bodyValidTo) return { value: bodyValidTo, source: "body", etd: etd, week_to: weekTo };
  return { value: defaultValidTo, source: "default_14d", etd: etd, week_to: weekTo };
}

function buildLines(body, token, company, validFrom, bodyValidTo, defaultValidTo, activeContainerTypes) {
  var pol = normalizePort(body.pol);
  var pod = normalizePort(body.pod);
  var rawLines = Array.isArray(body.lines) ? body.lines : [];
  var out = { lines: [], skipped: [] };
  if (!pol || !pod) {
    rawLines.forEach(function(line) {
      out.skipped.push({
        carrier: text(line && line.carrier),
        container_type: containerType(line && line.container_type, activeContainerTypes) || text(line && line.container_type),
        reason: "pol_or_pod_required",
      });
    });
    return out;
  }
  rawLines.forEach(function(line) {
    var carrier = text(line && line.carrier);
    var rawContainerType = text(line && line.container_type);
    var ct = containerType(line && line.container_type, activeContainerTypes);
    if (!ct) {
      out.skipped.push({
        carrier: carrier,
        container_type: rawContainerType,
        reason: "unsupported_container_type: " + rawContainerType,
      });
      return;
    }
    var usd = positiveNumber(line && line.unguaranteed_usd);
    if (!usd) {
      out.skipped.push({ carrier: carrier, container_type: ct, reason: "unguaranteed_usd_not_positive" });
      return;
    }
    var resolvedValidTo = lineValidTo(line, bodyValidTo, defaultValidTo);
    if (validFrom > resolvedValidTo.value) {
      out.skipped.push({ carrier: carrier, container_type: ct, reason: "sailing_already_departed" });
      return;
    }
    out.lines.push({
      pol: pol,
      pod: pod,
      carrier: carrier,
      container_type: ct,
      unguaranteed_usd: usd,
      guaranteed_usd: nullableNumber(line && line.guaranteed_usd),
      penalty_cny: nullableNumber(line && line.penalty_cny),
      deposit_cny: nullableNumber(line && line.deposit_cny),
      week_idx: line && line.week_idx == null ? null : nullableNumber(line && line.week_idx),
      week_from: cleanDate(line && line.week_from),
      week_to: resolvedValidTo.week_to,
      etd: resolvedValidTo.etd,
      vessel: text(line && line.vessel),
      voyage: text(line && line.voyage),
      transit_days: nullableNumber(line && line.transit_days),
      valid_from: validFrom,
      valid_to: resolvedValidTo.value,
      valid_to_source: resolvedValidTo.source,
      forwarder_company_id: token.company_id,
      forwarder_company_code: company.company_code,
      forwarder_name: company.name_cn,
    });
  });
  return out;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" });

  const pool = getPool();
  const code = cleanCode(req);
  const loaded = await loadToken(pool, code);
  if (loaded.error) return send(res, loaded.error, loaded.body);
  const company = await loadCompany(pool, loaded.token.company_id);
  if (!company || !company.company_code) {
    return send(res, 403, { ok: false, error: "company_not_found" });
  }

  var today = new Date();
  var body = req.body || {};
  var validFrom = cleanDate(body.valid_from) || ymd(today);
  var bodyValidTo = cleanDate(body.valid_to);
  var defaultValidTo = ymd(addDays(today, 14));
  var activeContainerTypes = await loadActiveContainerTypes(pool);
  var prepared = buildLines(body, loaded.token, company, validFrom, bodyValidTo, defaultValidTo, activeContainerTypes);
  if (!prepared.lines.length) {
    return send(res, 400, { ok: false, error: "no_valid_lines", saved: [], skipped: prepared.skipped });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    var saved = [];
    for (var i = 0; i < prepared.lines.length; i++) {
      var line = prepared.lines[i];
      var rfqId = await findOrCreateRfq(client, line);
      var rfqItemId = await upsertItem(client, rfqId, line);
      var freightRateId = await upsertRate(client, line, rfqItemId, code);
      saved.push({
        carrier: line.carrier,
        container_type: line.container_type,
        rfq_id: rfqId,
        rfq_item_id: rfqItemId,
        freight_rate_id: freightRateId,
        week_idx: line.week_idx,
        etd: line.etd,
        valid_to: line.valid_to,
        valid_to_source: line.valid_to_source,
      });
    }
    await client.query("COMMIT");
    return send(res, 200, { ok: true, saved: saved, skipped: prepared.skipped });
  } catch (err) {
    await client.query("ROLLBACK");
    return send(res, 500, { ok: false, error: err.message });
  } finally {
    client.release();
  }
}
