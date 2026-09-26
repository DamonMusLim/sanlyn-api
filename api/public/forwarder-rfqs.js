import { getPool, setCors } from "../db.js";
import { resolveForwarder } from "./_forwarder-portal-auth.js";
import { normalizePort } from "../db/_official-port-charges.js";

function send(res, status, body) {
  return res.status(status).json(body);
}

function text(v) {
  return String(v == null ? "" : v).trim();
}

function rowItem(row) {
  return {
    id: row.item_id,
    rfq_id: row.rfq_id,
    carrier: row.carrier || "",
    container_type: row.item_container_type || row.ctnr_type || "",
    vessel: row.vessel || "",
    voyage: row.voyage || "",
    etd: row.item_etd || null,
    usd_rate: row.usd_rate == null ? null : Number(row.usd_rate),
    currency: row.currency || "USD",
    submitted_at: row.submitted_at || null,
    quote_detail_json: row.quote_detail_json || null,
  };
}

function rowRfq(row) {
  return {
    id: row.rfq_id,
    pol: row.pol || "",
    pod: row.pod || "",
    pol_norm: normalizePort(row.pol),
    pod_norm: normalizePort(row.pod),
    ctnr_type: row.ctnr_type || "",
    status: row.status || "",
    service_type: row.service_type || "ocean",
    etd: row.rfq_etd || null,
    route: row.route || "",
    created_at: row.created_at || null,
    items: [],
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "method_not_allowed" });

  const pool = getPool();
  const auth = await resolveForwarder(pool, req);
  if (auth.error || !auth.token) {
    return send(res, 200, { ok: true, data: [], count: 0 });
  }
  const companyId = auth.token.company_id || null;
  const forwarderCo = text(auth.token.forwarder_co);
  if (!companyId && !forwarderCo) {
    return send(res, 200, { ok: true, data: [], count: 0 });
  }

  const { rows } = await pool.query(
    `SELECT r.id AS rfq_id, r.pol, r.pod, r.ctnr_type, r.status,
            COALESCE(r.service_type, 'ocean') AS service_type,
            r.etd AS rfq_etd, r.route, r.created_at,
            i.id AS item_id, i.carrier, i.container_type AS item_container_type,
            i.vessel, i.voyage, i.etd AS item_etd, i.usd_rate, i.currency,
            i.submitted_at, i.quote_detail_json
       FROM freight_rfqs r
       JOIN freight_rfq_items i ON i.rfq_id = r.id
      WHERE r.status = 'open'
        AND COALESCE(r.service_type, 'ocean') = 'ocean'
        AND (($1::int IS NOT NULL AND i.forwarder_company_id = $1)
          OR ($1::int IS NULL AND $2::text <> '' AND i.forwarder_co = $2))
      ORDER BY r.created_at DESC, i.submitted_at DESC NULLS LAST, i.id`,
    [companyId, forwarderCo]
  );

  var byId = {};
  var data = [];
  rows.forEach(function(row) {
    var id = row.rfq_id;
    if (!byId[id]) {
      byId[id] = rowRfq(row);
      data.push(byId[id]);
    }
    byId[id].items.push(rowItem(row));
  });
  return send(res, 200, { ok: true, data: data, count: data.length });
}
