const PORT_ALIASES = {
  QINGDAO:["QINGDAO", "青岛"],
  XIAMEN:["XIAMEN", "厦门"],
  TIANJIN:["TIANJIN", "天津"],
  SHANGHAI:["SHANGHAI", "上海"],
  NINGBO:["NINGBO", "宁波"],
  SHENZHEN:["SHENZHEN", "深圳"],
  DALIAN:["DALIAN", "大连"],
  LIANYUNGANG:["LIANYUNGANG", "连云港"],
};

const FIELD_PRIORITIES = {
  thc:["THC"],
  cfs:["场站费", "CHC", "装箱费"],
  seal:["封签费", "铅封费"],
  eir:["设备交接单", "EIR及铅封"],
  misc:["港杂费", "综合服务费"],
  pick:["提箱费", "套柜费"],
};

const EMPTY = { cfs:"", thc:"", misc:"", pick:"", seal:"", eir:"" };

function norm(v){
  return String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function normContainer(v){
  return norm(v || "40HQ").replace("HC", "HQ");
}

export function normalizePort(v){
  var s = norm(v);
  if (!s) return "";
  var keys = Object.keys(PORT_ALIASES);
  for (var i = 0; i < keys.length; i++) {
    if (PORT_ALIASES[keys[i]].map(norm).indexOf(s) !== -1) return keys[i];
  }
  return s;
}

function aliasList(pol){
  var key = normalizePort(pol);
  return (PORT_ALIASES[key] || [key]).filter(Boolean);
}

function rowToCharges(rows){
  if (!rows || !rows.length) {
    return Object.assign({}, EMPTY, {
      source:"fallback",
      total:0,
      currency:null,
    });
  }
  var out = Object.assign({}, EMPTY);
  var byCategory = {};
  var currencies = {};
  rows.forEach(function(row){
    var cat = String(row.cost_category || "").trim();
    if (!cat || byCategory[cat] != null) return;
    byCategory[cat] = row.rate == null ? "" : Number(row.rate);
    if (row.currency) currencies[row.currency] = true;
  });
  Object.keys(FIELD_PRIORITIES).forEach(function(field){
    var cats = FIELD_PRIORITIES[field];
    for (var i = 0; i < cats.length; i++) {
      if (byCategory[cats[i]] != null && byCategory[cats[i]] !== "") {
        out[field] = byCategory[cats[i]];
        return;
      }
    }
  });
  var total = ["cfs", "thc", "misc", "pick", "seal", "eir"].reduce(function(sum, key){
    return sum + (Number(out[key]) || 0);
  }, 0);
  var currencyKeys = Object.keys(currencies);
  return Object.assign(out, {
    source:"freight_port_rates",
    total:total,
    currency:currencyKeys.length === 1 ? currencyKeys[0] : (currencyKeys[0] || null),
  });
}

function groupRows(rows){
  var grouped = {};
  (rows || []).forEach(function(row){
    var key = norm(row.carrier_code) + "::" + normalizePort(row.pol) + "::" + normContainer(row.container_type);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  });
  return grouped;
}

export async function officialPortCharges(pool, carrier, pol, containerType){
  var aliases = aliasList(pol);
  if (!pool || !carrier || !aliases.length) return rowToCharges([]);
  const { rows } = await pool.query(
    `SELECT carrier_code, pol, container_type, cost_category, rate, currency
       FROM freight_port_rates
      WHERE UPPER(TRIM(carrier_code)) = $1
        AND UPPER(TRIM(pol)) = ANY($2::text[])
        AND REPLACE(UPPER(TRIM(container_type)), 'HC', 'HQ') = $3`,
    [norm(carrier), aliases.map(norm), normContainer(containerType)]
  );
  return rowToCharges(rows);
}

export async function officialPortChargesMap(pool, pairs){
  var list = Array.isArray(pairs) ? pairs : [];
  if (!pool || !list.length) return {};
  var carriers = {};
  var containers = {};
  var ports = {};
  list.forEach(function(p){
    if (p && p.carrier) carriers[norm(p.carrier)] = true;
    if (p && p.containerType) containers[normContainer(p.containerType)] = true;
    aliasList(p && p.pol).forEach(function(x){ ports[norm(x)] = true; });
  });
  var carrierList = Object.keys(carriers);
  var containerList = Object.keys(containers);
  var portList = Object.keys(ports);
  if (!carrierList.length || !containerList.length || !portList.length) return {};
  const { rows } = await pool.query(
    `SELECT carrier_code, pol, container_type, cost_category, rate, currency
       FROM freight_port_rates
      WHERE UPPER(TRIM(carrier_code)) = ANY($1::text[])
        AND UPPER(TRIM(pol)) = ANY($2::text[])
        AND REPLACE(UPPER(TRIM(container_type)), 'HC', 'HQ') = ANY($3::text[])`,
    [carrierList, portList, containerList]
  );
  var grouped = groupRows(rows);
  var out = {};
  list.forEach(function(p){
    var key = norm(p.carrier) + "::" + normalizePort(p.pol) + "::" + normContainer(p.containerType);
    out[key] = rowToCharges(grouped[key] || []);
  });
  return out;
}

export function officialPortChargeKey(carrier, pol, containerType){
  return norm(carrier) + "::" + normalizePort(pol) + "::" + normContainer(containerType);
}
