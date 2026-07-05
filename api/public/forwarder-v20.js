import { getPool, setCors } from "../db.js";
import { officialPortChargeKey, officialPortChargesMap, normalizePort } from "../db/_official-port-charges.js";

const CARRIER_OPTIONS = ["OOCL", "EMC", "COSCO", "MSC", "KMTC", "ESL", "HAPAG", "MSK", "CMA", "ONE"];

function cleanCode(req){
  var p = req.params && req.params.code;
  if (p) return String(p).split("?")[0];
  var parts = String(req.url || "").split("?")[0].split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function send(res, status, body){
  res.status(status).json(body);
}

async function ensureColumns(pool){
  await pool.query(`
    ALTER TABLE freight_rfq_items
      ADD COLUMN IF NOT EXISTS port_charges_json jsonb,
      ADD COLUMN IF NOT EXISTS free_pol_days     int,
      ADD COLUMN IF NOT EXISTS free_pod_days     int,
      ADD COLUMN IF NOT EXISTS dnd_usd           numeric,
      ADD COLUMN IF NOT EXISTS container_type    text,
      ADD COLUMN IF NOT EXISTS carrier           text,
      ADD COLUMN IF NOT EXISTS trucking_included boolean DEFAULT false,
      ADD COLUMN IF NOT EXISTS trucking_fee      numeric
  `);
}

async function loadToken(pool, code){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forwarder_portal_tokens (
      code text PRIMARY KEY,
      forwarder_co text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz DEFAULT now()
    )
  `);
  if (!code) return { error:404, body:{ ok:false, error:"not_found" } };
  const { rows } = await pool.query(
    "SELECT code, forwarder_co, expires_at FROM forwarder_portal_tokens WHERE code = $1",
    [code]
  );
  if (!rows.length) return { error:404, body:{ ok:false, error:"not_found" } };
  if (new Date(rows[0].expires_at) < new Date()) {
    return { error:410, body:{ ok:false, error:"expired", message:"链接已过期" } };
  }
  return { token:rows[0] };
}

function normPort(v){
  return String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function publicRfq(row){
  var ct = String(row.ctnr_type || "40HQ").toUpperCase().replace("HC", "HQ");
  return {
    id:row.id,
    _rfqId:row.id,
    service_type:"ocean",
    pol:row.pol || "",
    pod:row.pod || "",
    ctnr_type:ct,
    status:row.status,
    etd:row.etd,
    product_summary:row.product_summary || "",
    order_carrier:row.order_carrier || null,
    from:{ port:row.pol || "", code:row.pol || "", flag:"" },
    to:{ port:row.pod || "", code:row.pod || "", flag:"" },
    cargoInfo:{
      ctnr_count:row.ctnr_count || null,
      ctnr_type:ct,
      gross_weight_kg:row.gross_weight_kg || null,
      product_summary:row.product_summary || null,
    },
  };
}

function groupRows(rows){
  var groups = {};
  rows.forEach(function(row){
    var key = normalizePort(row.pol) + "::" + normalizePort(row.pod); // 别名归一(青岛=Qingdao) 合并同航线
    if (key === "::") return;
    if (!groups[key]) {
      groups[key] = {
        key:key,
        pol:row.pol || "",
        pod:row.pod || "",
        carrier_options:[],
        _orderCarriers:{},
        rfqs:[],
      };
    }
    groups[key].rfqs.push(publicRfq(row));
    if (row.order_carrier) groups[key]._orderCarriers[String(row.order_carrier).trim().toUpperCase()] = 1;
  });
  return Object.keys(groups).map(function(k){ return groups[k]; });
}

async function resolveCarriers(pool, forwarderCo, lanes){
  // 定义(Damon 2026-07-03 "只看自己相关的"): 船司 = ①本货代该航线级协议(精确 pol+pod) ②客户订单指定 ③本货代已报价。
  // 去掉"起运港级协议全铺"(byPol)——那会把该港所有 open 单冒出来(89单→太多)。0船司的航线由上层过滤隐藏。
  var agMap = {};        // 航线级协议 pol::pod -> {carrier}
  var quotedByRfq = {};  // rfq_id -> {carrier}
  try {
    var r = await pool.query(
      "SELECT UPPER(TRIM(carrier_code)) AS code, UPPER(TRIM(COALESCE(pol,''))) AS pol, UPPER(TRIM(COALESCE(pod,''))) AS pod FROM forwarder_carrier_agreements WHERE forwarder_co=$1 AND active IS TRUE AND pod IS NOT NULL AND TRIM(pod) <> ''",
      [forwarderCo]);
    r.rows.forEach(function(row){
      var k = normalizePort(row.pol) + "::" + normalizePort(row.pod);
      (agMap[k] = agMap[k] || {})[row.code] = 1;
    });
  } catch(e){}
  try {
    var q = await pool.query(
      "SELECT rfq_id, UPPER(TRIM(carrier)) AS carrier FROM freight_rfq_items WHERE forwarder_co=$1 AND carrier IS NOT NULL AND TRIM(carrier) <> ''",
      [forwarderCo]);
    q.rows.forEach(function(row){
      if (!row.rfq_id) return;
      (quotedByRfq[String(row.rfq_id)] = quotedByRfq[String(row.rfq_id)] || {})[row.carrier] = 1;
    });
  } catch(e){}
  (lanes || []).forEach(function(lane){
    var key = normalizePort(lane.pol) + "::" + normalizePort(lane.pod);
    var set = {};
    Object.keys(agMap[key] || {}).forEach(function(c){ set[c] = 1; });                  // ①航线级协议(精确)
    Object.keys(lane._orderCarriers || {}).forEach(function(c){ if (c) set[c] = 1; });   // ②客户订单指定
    (lane.rfqs || []).forEach(function(rfq){                                             // ③本货代已报价
      var qc = quotedByRfq[String(rfq.id || rfq._rfqId || "")];
      if (qc) Object.keys(qc).forEach(function(c){ set[c] = 1; });
    });
    lane.carrier_options = Object.keys(set);
    delete lane._orderCarriers;
  });
  return lanes;
}

async function attachOfficialPortCharges(pool, lanes){
  var pairs = [];
  (lanes || []).forEach(function(lane){
    var ctypes = {};
    (lane.rfqs || []).forEach(function(rfq){
      ctypes[rfq.ctnr_type || "40HQ"] = true;
    });
    Object.keys(ctypes).forEach(function(ct){
      (lane.carrier_options || []).forEach(function(carrier){
        pairs.push({ carrier:carrier, pol:lane.pol, containerType:ct });
      });
    });
  });
  var rateMap = await officialPortChargesMap(pool, pairs);
  (lanes || []).forEach(function(lane){
    var official = {};
    (lane.carrier_options || []).forEach(function(carrier){
      official[carrier] = {};
      (lane.rfqs || []).forEach(function(rfq){
        var ct = rfq.ctnr_type || "40HQ";
        official[carrier][ct] = rateMap[officialPortChargeKey(carrier, lane.pol, ct)];
      });
    });
    lane.official_port_charges = official;
    (lane.rfqs || []).forEach(function(rfq){
      rfq.official_port_charges = official;
    });
  });
  return lanes;
}

async function handleGet(pool, token, res){
  const { rows } = await pool.query(`
    SELECT r.id, r.pol, r.pod, r.ctnr_type, r.status, r.etd,
           COALESCE(r.service_type, 'ocean') AS service_type,
           sp.container_qty AS ctnr_count,
           sp.gross_weight_kg AS gross_weight_kg,
           sp.order_carrier AS order_carrier,
           (SELECT string_agg(t.label, ' / ')
              FROM (
                SELECT (COALESCE(oi.product_name, '') || '×' || oi.qty_ctn || '箱') AS label
                  FROM order_line_items oi
                 WHERE oi.order_id = r.order_id
                 ORDER BY oi.sort_order NULLS LAST
                 LIMIT 3
              ) t
           ) AS product_summary
      FROM freight_rfqs r
      LEFT JOIN LATERAL (
        SELECT container_qty, gross_weight_kg, carrier_code AS order_carrier
          FROM shipping_plans
         WHERE order_id = r.order_id
         ORDER BY id DESC LIMIT 1
      ) sp ON TRUE
     WHERE r.status = 'open'
       AND COALESCE(r.service_type, 'ocean') = 'ocean'
       AND r.pol IS NOT NULL AND r.pod IS NOT NULL
     ORDER BY r.etd NULLS LAST, r.created_at DESC
     LIMIT 300
  `);
  var lanes = groupRows(rows);
  lanes = await resolveCarriers(pool, token.forwarder_co, lanes);
  lanes = lanes.filter(function(l){ return (l.carrier_options||[]).length > 0; }); // 其他不显示:无协议无订单指定船司的航线整条隐藏
  lanes = await attachOfficialPortCharges(pool, lanes);
  return send(res, 200, {
    ok:true,
    forwarder_co:token.forwarder_co,
    expires_at:token.expires_at,
    lanes:lanes,
  });
}

function asNumber(v){
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isUuid(v){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));
}

function cleanLine(line){
  var out = line || {};
  return {
    rfq_id:out.rfq_id,
    carrier:out.carrier || out.vessel || null,
    vessel:out.vessel || out.carrier || null,
    container_type:out.container_type || null,
    etd:out.etd || null,
    usd_rate:asNumber(out.usd_rate),
    port_charges_json:out.port_charges_json || null,
    free_pol_days:asNumber(out.free_pol_days),
    free_pod_days:asNumber(out.free_pod_days),
    dnd_usd:asNumber(out.dnd_usd),
    customs_included:!!out.customs_included,
    customs_fee:out.customs_fee == null || out.customs_fee === "" ? null : asNumber(out.customs_fee),
    trucking_included:!!out.trucking_included,
    trucking_fee:out.trucking_fee == null || out.trucking_fee === "" ? null : asNumber(out.trucking_fee),
  };
}

async function upsertLine(client, forwarder, line){
  const upd = await client.query(`
    UPDATE freight_rfq_items
       SET vessel = $5, usd_rate = $6, currency = 'USD',
           port_charges_json = $7::jsonb,
           free_pol_days = $8, free_pod_days = $9, dnd_usd = $10,
           customs_included = $11, customs_fee = $12,
           trucking_included = $13, trucking_fee = $14,
           submitted_at = COALESCE(submitted_at, now())
     WHERE rfq_id = $1
       AND forwarder_co = $2
       AND COALESCE(carrier, '') = COALESCE($3, '')
       AND COALESCE(container_type, '') = COALESCE($4, '')
       AND COALESCE(etd::date::text, '') = COALESCE($15, '')
     RETURNING id
  `, [
    line.rfq_id, forwarder, line.carrier, line.container_type, line.vessel,
    line.usd_rate, line.port_charges_json ? JSON.stringify(line.port_charges_json) : null,
    line.free_pol_days, line.free_pod_days, line.dnd_usd,
    line.customs_included, line.customs_fee,
    line.trucking_included, line.trucking_fee, line.etd,
  ]);
  if (upd.rows.length) return upd.rows[0].id;
  const ins = await client.query(`
    INSERT INTO freight_rfq_items
      (rfq_id, forwarder_co, vessel, etd, usd_rate, currency,
       port_charges_json, free_pol_days, free_pod_days, dnd_usd,
       container_type, carrier, customs_included, customs_fee,
       trucking_included, trucking_fee, submitted_at)
    VALUES ($1,$2,$3,$4,$5,'USD',$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
    RETURNING id
  `, [
    line.rfq_id, forwarder, line.vessel, line.etd, line.usd_rate,
    line.port_charges_json ? JSON.stringify(line.port_charges_json) : null,
    line.free_pol_days, line.free_pod_days, line.dnd_usd,
    line.container_type, line.carrier, line.customs_included, line.customs_fee,
    line.trucking_included, line.trucking_fee,
  ]);
  return ins.rows[0].id;
}

async function handlePost(pool, token, req, res){
  await ensureColumns(pool);
  var body = req.body || {};
  var rfqId = body.rfq_id || body.rfqId || null;
  var rawLines = Array.isArray(body) ? body : Array.isArray(body.lines) ? body.lines : [];
  var lines = rawLines.map(function(line){
    return cleanLine(Object.assign({}, line, { rfq_id:line.rfq_id || rfqId }));
  }).filter(function(line){ return line.rfq_id && line.usd_rate && line.usd_rate > 0; });
  if (!lines.length) return send(res, 400, { ok:false, error:"lines_required" });
  if (lines.some(function(line){ return !isUuid(line.rfq_id); })) {
    return send(res, 400, { ok:false, error:"invalid_rfq_id" });
  }
  const rfqIds = Array.from(new Set(lines.map(function(line){ return line.rfq_id; })));
  const open = await pool.query(
    `SELECT id FROM freight_rfqs
      WHERE id = ANY($1::uuid[])
        AND status = 'open'
        AND COALESCE(service_type, 'ocean') = 'ocean'`,
    [rfqIds]
  );
  const allowed = {};
  open.rows.forEach(function(row){ allowed[row.id] = true; });
  if (rfqIds.some(function(id){ return !allowed[id]; })) {
    return send(res, 403, { ok:false, error:"rfq_not_available" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    var ids = [];
    for (var i = 0; i < lines.length; i++) {
      ids.push(await upsertLine(client, token.forwarder_co, lines[i]));
    }
    await client.query("COMMIT");
    return send(res, 200, { ok:true, success:true, count:ids.length, item_ids:ids });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const code = cleanCode(req);
  const loaded = await loadToken(pool, code);
  if (loaded.error) return send(res, loaded.error, loaded.body);
  if (req.method === "GET") return handleGet(pool, loaded.token, res);
  if (req.method === "POST") return handlePost(pool, loaded.token, req, res);
  return send(res, 405, { ok:false, error:"method_not_allowed" });
}
