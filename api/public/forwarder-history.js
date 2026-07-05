import { getPool, setCors } from "../db.js";

function cleanCode(req){
  var p = req.params && req.params.code;
  if (p) return String(p).split("?")[0];
  var parts = String(req.url || "").split("?")[0].split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function send(res, status, body){
  res.status(status).json(body);
}

function money(v){
  var n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function cleanText(v){
  return String(v == null ? "" : v).trim();
}

function uniqPush(list, seen, value){
  var s = cleanText(value);
  if (!s || seen[s]) return;
  seen[s] = true;
  list.push(s);
}

async function loadToken(pool, code){
  if (!code) return { error:404, body:{ ok:false, error:"not_found" } };
  const { rows } = await pool.query(
    "SELECT code, forwarder_co, company_id, expires_at FROM forwarder_portal_tokens WHERE code = $1 LIMIT 1",
    [code]
  );
  if (!rows.length) return { error:404, body:{ ok:false, error:"not_found" } };
  var token = rows[0];
  if (token.expires_at && new Date(token.expires_at) < new Date()) {
    return { error:410, body:{ ok:false, error:"expired", message:"链接已过期" } };
  }
  return { token:token };
}

async function companyName(pool, companyId){
  const { rows } = await pool.query(
    "SELECT name_cn FROM companies WHERE id = $1 LIMIT 1",
    [companyId]
  );
  return rows[0] && rows[0].name_cn ? rows[0].name_cn : "";
}

function makeBucket(blNo){
  return {
    bl_no:blNo,
    months:[],
    containers:[],
    lines:[],
    usd_total:0,
    cny_total:0,
    line_count:0,
    _months:{},
    _containers:{},
    _planIds:{},
    _lastMonth:"",
  };
}

function groupBills(rows){
  var byBl = {};
  (rows || []).forEach(function(row){
    var blNo = cleanText(row.bl_no);
    if (!blNo) return;
    var g = byBl[blNo] || (byBl[blNo] = makeBucket(blNo));
    var month = cleanText(row.bill_month);
    uniqPush(g.months, g._months, month);
    if (month > g._lastMonth) g._lastMonth = month;
    uniqPush(g.containers, g._containers, row.container_no);
    if (row.link_plan_id != null && cleanText(row.link_plan_id)) g._planIds[cleanText(row.link_plan_id)] = true;

    var amount = row.amount == null ? null : money(row.amount);
    var currency = cleanText(row.currency).toUpperCase();
    g.lines.push({
      category:row.cost_category || "",
      amount:amount,
      currency:currency || "",
    });
    if (currency === "USD") g.usd_total = money(g.usd_total + money(row.amount));
    if (currency === "CNY" || currency === "RMB") g.cny_total = money(g.cny_total + money(row.amount));
    g.line_count += 1;
  });
  return byBl;
}

function planPayload(row){
  if (!row) return {};
  return {
    pol:row.pol || "",
    pod:row.pod || "",
    etd:row.etd || null,
    customer_en:row.customer_en || "",
    vessel:row.vessel || "",
    voyage:row.voyage || "",
    container_qty:row.container_qty == null ? null : Number(row.container_qty),
  };
}

async function attachPlans(pool, companyId, byBl){
  var blNos = Object.keys(byBl);
  var planIds = [];
  blNos.forEach(function(bl){
    Object.keys(byBl[bl]._planIds || {}).forEach(function(id){ planIds.push(id); });
  });
  planIds = Array.from(new Set(planIds));
  if (!blNos.length && !planIds.length) return;

  const { rows } = await pool.query(
    `SELECT id::text AS id_text, _id, bl_no, pol, pod, etd, customer_en, vessel, voyage, container_qty
       FROM shipping_plans
      WHERE forwarder_company_id = $3
        AND (
          id::text = ANY($1::text[])
          OR _id = ANY($1::text[])
          OR bl_no = ANY($2::text[])
        )`,
    [planIds, blNos, companyId]
  );
  var byPlanId = {};
  var byPlanBl = {};
  rows.forEach(function(row){
    if (row.id_text) byPlanId[row.id_text] = row;
    if (row._id) byPlanId[row._id] = row;
    if (row.bl_no && !byPlanBl[row.bl_no]) byPlanBl[row.bl_no] = row;
  });
  blNos.forEach(function(bl){
    var g = byBl[bl];
    var hit = null;
    Object.keys(g._planIds || {}).some(function(id){
      if (byPlanId[id]) { hit = byPlanId[id]; return true; }
      return false;
    });
    hit = hit || byPlanBl[bl];
    Object.assign(g, planPayload(hit));
  });
}

function finalize(byBl){
  var history = Object.keys(byBl).map(function(bl){
    var g = byBl[bl];
    g.months.sort().reverse();
    g.containers.sort();
    delete g._months;
    delete g._containers;
    delete g._planIds;
    return g;
  });
  history.sort(function(a, b){
    var m = String(b._lastMonth || "").localeCompare(String(a._lastMonth || ""));
    if (m) return m;
    return String(a.bl_no || "").localeCompare(String(b.bl_no || ""));
  });
  history.forEach(function(g){ delete g._lastMonth; });
  return history;
}

async function handleGet(pool, token, res){
  if (!token.company_id) {
    return send(res, 200, { ok:true, history:[], note:"未桥接公司" });
  }
  var supplierName = await companyName(pool, token.company_id);
  if (!supplierName) return send(res, 404, { ok:false, error:"company_not_found" });

  const bills = await pool.query(
    `SELECT bl_no, container_no, bill_month, cost_category, amount, currency, link_plan_id
       FROM freight_supplier_bills
      WHERE supplier = $1
        AND bl_no IS NOT NULL
        AND bl_no <> ''`,
    [supplierName]
  );
  var byBl = groupBills(bills.rows);
  try {
    await attachPlans(pool, token.company_id, byBl);
  } catch (e) {
    console.warn("[forwarder-history] attach shipping_plans skipped:", e.message);
  }
  var history = finalize(byBl);
  var totals = history.reduce(function(acc, item){
    acc.bl_count += 1;
    acc.usd_total = money(acc.usd_total + item.usd_total);
    acc.cny_total = money(acc.cny_total + item.cny_total);
    return acc;
  }, { bl_count:0, usd_total:0, cny_total:0 });

  return send(res, 200, {
    ok:true,
    forwarder_co:supplierName,
    company_id:token.company_id,
    totals:totals,
    history:history,
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return send(res, 405, { ok:false, error:"method_not_allowed" });
  const pool = getPool();
  const code = cleanCode(req);
  const loaded = await loadToken(pool, code);
  if (loaded.error) return send(res, loaded.error, loaded.body);
  return handleGet(pool, loaded.token, res);
}
