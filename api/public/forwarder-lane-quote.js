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
  var d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function addDays(date, days) {
  var d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function cleanDate(v) {
  var s = text(v);
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  return ymd(s);
}

function containerType(v) {
  var s = text(v || "40HQ").toUpperCase().replace(/\s+/g, "");
  s = s.replace("40HC", "40HQ").replace("HC", "HQ");
  if (s === "20" || s === "20GP") return "20GP";
  if (s === "40" || s === "40HQ") return "40HQ";
  return "";
}

function rateColumn(ct) {
  return ct === "20GP" ? "gp20" : "hq40";
}

function route(pol, pod) {
  return pol + "→" + pod;
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
    guaranteed_usd: line.guaranteed_usd,
    penalty_cny: line.penalty_cny,
    deposit_cny: line.deposit_cny,
  };
  const upd = await client.query(
    `UPDATE freight_rfq_items
        SET usd_rate = $5,
            currency = 'USD',
            vessel = $6,
            voyage = $7,
            etd = $8,
            forwarder_co = $9,
            forwarder_company_id = $10,
            submitted_at = COALESCE(submitted_at, now()),
            quote_detail_json = $11::jsonb
      WHERE rfq_id = $1
        AND forwarder_company_id = $2
        AND COALESCE(carrier, '') = COALESCE($3, '')
        AND COALESCE(container_type, '') = COALESCE($4, '')
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
    ]
  );
  if (upd.rows.length) return upd.rows[0].id;

  const ins = await client.query(
    `INSERT INTO freight_rfq_items
       (id, rfq_id, forwarder_co, forwarder_company_id, vessel, voyage, etd,
        usd_rate, currency, container_type, carrier, submitted_at, quote_detail_json)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'USD', $8, $9,
        now(), $10::jsonb)
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

async function findRate(client, line) {
  var col = rateColumn(line.container_type);
  const { rows } = await client.query(
    `SELECT id
       FROM freight_rates fr
      WHERE fr.forwarder_company_id = $1
        AND COALESCE(fr.carrier, '') = COALESCE($2, '')
        AND lower(btrim(fr.pol)) = lower(btrim($3))
        AND lower(btrim(fr.pod)) = lower(btrim($4))
        AND fr.source = 'portal_quote'
        AND fr.${col} IS NOT NULL
      ORDER BY fr.updated_at DESC NULLS LAST, fr.id DESC
      LIMIT 1
      FOR UPDATE`,
    [line.forwarder_company_id, line.carrier, line.pol, line.pod]
  );
  return rows[0] ? rows[0].id : null;
}

async function expireOverlaps(client, line, keepId) {
  var col = rateColumn(line.container_type);
  await client.query(
    `UPDATE freight_rates
        SET status = 'expired', updated_at = now()
      WHERE forwarder_company_id = $1
        AND COALESCE(carrier, '') = COALESCE($2, '')
        AND lower(btrim(pol)) = lower(btrim($3))
        AND lower(btrim(pod)) = lower(btrim($4))
        AND ${col} IS NOT NULL
        AND status = 'active'
        AND ($7::int IS NULL OR id <> $7)
        AND COALESCE(valid_from::date, '-infinity'::date) <= COALESCE($6::date, 'infinity'::date)
        AND COALESCE(valid_to::date, 'infinity'::date) >= COALESCE($5::date, '-infinity'::date)`,
    [line.forwarder_company_id, line.carrier, line.pol, line.pod, line.valid_from, line.valid_to, keepId]
  );
}

async function upsertRate(client, line, rfqItemId, code) {
  var col = rateColumn(line.container_type);
  var existingId = await findRate(client, line);
  var raw = {
    rfq_item_id: rfqItemId,
    submitted_by_portal_code: code,
    forwarder_company_code: line.forwarder_company_code,
    guaranteed_usd: line.guaranteed_usd,
    penalty_cny: line.penalty_cny,
    deposit_cny: line.deposit_cny,
  };
  await expireOverlaps(client, line, existingId);
  if (existingId) {
    const upd = await client.query(
      `UPDATE freight_rates
          SET forwarder = $2,
              carrier = $3,
              pol = $4,
              pod = $5,
              ${col} = $6,
              valid_from = $7,
              valid_to = $8,
              status = 'active',
              source = 'portal_quote',
              raw = COALESCE(raw, '{}'::jsonb) || $9::jsonb,
              updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [
        existingId,
        line.forwarder_name,
        line.carrier,
        line.pol,
        line.pod,
        line.unguaranteed_usd,
        line.valid_from,
        line.valid_to,
        JSON.stringify(raw),
      ]
    );
    return upd.rows[0].id;
  }

  const ins = await client.query(
    `INSERT INTO freight_rates
       (forwarder_company_id, forwarder, carrier, pol, pod, ${col},
        valid_from, valid_to, status, source, raw, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active','portal_quote',$9::jsonb,now(),now())
     RETURNING id`,
    [
      line.forwarder_company_id,
      line.forwarder_name,
      line.carrier,
      line.pol,
      line.pod,
      line.unguaranteed_usd,
      line.valid_from,
      line.valid_to,
      JSON.stringify(raw),
    ]
  );
  return ins.rows[0].id;
}

function buildLines(body, token, company, validFrom, validTo) {
  var pol = normalizePort(body.pol);
  var pod = normalizePort(body.pod);
  var rawLines = Array.isArray(body.lines) ? body.lines : [];
  var out = { lines: [], skipped: [] };
  if (!pol || !pod) {
    rawLines.forEach(function(line) {
      out.skipped.push({
        carrier: text(line && line.carrier),
        container_type: containerType(line && line.container_type) || text(line && line.container_type),
        reason: "pol_or_pod_required",
      });
    });
    return out;
  }
  rawLines.forEach(function(line) {
    var carrier = text(line && line.carrier);
    var rawContainerType = text(line && line.container_type);
    var ct = containerType(line && line.container_type);
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
    out.lines.push({
      pol: pol,
      pod: pod,
      carrier: carrier,
      container_type: ct,
      unguaranteed_usd: usd,
      guaranteed_usd: nullableNumber(line && line.guaranteed_usd),
      penalty_cny: nullableNumber(line && line.penalty_cny),
      deposit_cny: nullableNumber(line && line.deposit_cny),
      etd: cleanDate(line && line.etd),
      vessel: text(line && line.vessel),
      voyage: text(line && line.voyage),
      valid_from: validFrom,
      valid_to: validTo,
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
  var validTo = cleanDate(body.valid_to) || ymd(addDays(today, 7));
  var prepared = buildLines(body, loaded.token, company, validFrom, validTo);
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
