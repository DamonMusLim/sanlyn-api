import { getPool, setCors } from "../db.js";
import { loadFreeDaysBatch, resolvePortCode } from "../db/_free-days.js";

const BOXES = ["20GP", "40GP", "40HQ"];

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

function parseCarriers(raw) {
  var seen = {};
  return text(raw).split(",").map(normCarrier).filter(function(carrier) {
    if (!carrier || seen[carrier]) return false;
    seen[carrier] = true;
    return true;
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

async function handleGet(pool, req, res) {
  var rawPol = text(req.query && req.query.pol);
  var carriers = parseCarriers(req.query && req.query.carriers);
  if (!rawPol || !carriers.length) {
    return send(res, 400, { ok: false, error: "pol_carriers_required" });
  }

  var warn = "";
  if (carriers.length > 20) {
    carriers = carriers.slice(0, 20);
    warn = "carriers 上限 20 个,已截断";
  }

  var port = await resolvePortCode(pool, rawPol);
  var freeDays = await loadFreeDaysBatch(pool, carriers, port.code, port.name_cn || rawPol);
  var body = {
    ok: true,
    pol: port.name_cn || rawPol,
    pol_code: port.code,
    boxes: BOXES,
    carriers: freeDays,
  };
  if (warn) body._warn = warn;
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
