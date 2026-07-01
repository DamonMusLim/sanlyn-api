// /api/db/customs-declaration-form.js
// Render official-style PRC export customs declaration HTML.
// Data is derived from shipping_plans + orders + order_line_items + products + companies.

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clean(v) {
  return String(v ?? "").trim();
}

function pick() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v !== null && v !== undefined && String(v).trim() !== "") return v;
  }
  return "";
}

function parseRaw(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (_) { return {}; }
}

function fmtM(v, dec) {
  if (v == null || v === "") return "";
  var n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: dec == null ? 2 : dec,
    maximumFractionDigits: dec == null ? 2 : dec,
    useGrouping: false,
  });
}

function fmtInt(v) {
  if (v == null || v === "") return "";
  var n = Number(v);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n));
}

function fmtDate(v) {
  if (!v) return "";
  var s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  try {
    var d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch (_) {}
  return s.slice(0, 10);
}

function blank(v) {
  var s = clean(v);
  return s ? esc(s) : '<span class="empty">—</span>';
}

function countryFromPod(pod) {
  var s = clean(pod).toUpperCase();
  if (!s) return "";
  if (s.includes("MYS") || s.includes("MALAYSIA") || s.includes("马来") || s.includes("KLANG") || s.includes("WESTPORT") || s.includes("PASIR GUDANG") || s.includes("PENANG") || s.includes("巴生")) return "马来西亚(MYS)";
  if (s.includes("THA") || s.includes("THAILAND") || s.includes("泰国")) return "泰国(THA)";
  if (s.includes("VNM") || s.includes("VIETNAM") || s.includes("越南")) return "越南(VNM)";
  if (s.includes("SGP") || s.includes("SINGAPORE") || s.includes("新加坡")) return "新加坡(SGP)";
  if (s.includes("IDN") || s.includes("INDONESIA") || s.includes("印尼") || s.includes("印度尼西亚")) return "印度尼西亚(IDN)";
  if (s.includes("PHL") || s.includes("PHILIPPINES") || s.includes("菲律宾")) return "菲律宾(PHL)";
  return clean(pod);
}

function sellerLabel(name, company) {
  var n = clean(name || company?.name_cn || company?.name_en);
  var uscc = clean(company?.tax_id || company?.registration_no || company?.uscc);
  if (uscc && n) return uscc + " " + n;
  return n;
}

function firstOrderValue(orders, field, rawField) {
  for (var i = 0; i < orders.length; i++) {
    var raw = parseRaw(orders[i].raw);
    var v = pick(orders[i][field], rawField ? raw[rawField] : "");
    if (v) return v;
  }
  return "";
}

async function getColumns(pool, table) {
  try {
    var r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
      [table]
    );
    return new Set(r.rows.map(function (x) { return x.column_name; }));
  } catch (_) {
    return new Set();
  }
}

async function loadCompany(pool, name) {
  name = clean(name);
  if (!name) return null;
  var cols = await getColumns(pool, "companies");
  if (!cols.size) return null;

  var select = ["name_cn", "name_en", "tax_id", "registration_no", "uscc"]
    .filter(function (c) { return cols.has(c); });
  if (!select.length) return null;

  var conds = [];
  var args = [name];
  if (cols.has("name_cn")) conds.push("btrim(name_cn) = btrim($1)");
  if (cols.has("name_en")) conds.push("btrim(name_en) = btrim($1)");
  if (!conds.length) return null;

  try {
    var r = await pool.query(
      `SELECT ${select.join(", ")} FROM companies WHERE ${conds.join(" OR ")} LIMIT 1`,
      args
    );
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

async function loadPlan(pool, shipmentId) {
  var r = await pool.query(
    `SELECT * FROM shipping_plans
     WHERE _id::text=$1 OR id::text=$1 OR shipment_no=$1 OR bl_no=$1
     LIMIT 1`,
    [String(shipmentId)]
  );
  return r.rows[0] || null;
}

function orderKeys(plan) {
  var raw = parseRaw(plan.raw);
  var xs = []
    .concat(Array.isArray(plan.order_nos) ? plan.order_nos : [])
    .concat(Array.isArray(plan.contract_nos) ? plan.contract_nos : [])
    .concat(Array.isArray(raw.orderNos) ? raw.orderNos : [])
    .concat(Array.isArray(raw.order_nos) ? raw.order_nos : [])
    .concat(Array.isArray(raw.contractNos) ? raw.contractNos : [])
    .concat(clean(plan.contract_no) ? [plan.contract_no] : []);
  var seen = new Set();
  return xs.map(clean).filter(function (x) {
    if (!x || seen.has(x)) return false;
    seen.add(x);
    return true;
  });
}

async function loadOrders(pool, plan) {
  var keys = orderKeys(plan);
  if (!keys.length) return [];
  var r = await pool.query(
    `SELECT * FROM orders
     WHERE order_no = ANY($1::text[])
        OR contract_no = ANY($1::text[])
        OR _id::text = ANY($1::text[])
        OR id::text = ANY($1::text[])
     ORDER BY id ASC`,
    [keys]
  );
  return r.rows;
}

async function loadLines(pool, orderIds) {
  if (!orderIds.length) return [];
  var r = await pool.query(
    `WITH product_one AS (
       SELECT DISTINCT ON (sku)
              sku, hs_code, declaration_name, declaration_elements
       FROM products
       WHERE NULLIF(btrim(sku), '') IS NOT NULL
       ORDER BY sku, active DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
     ),
     keyed AS (
       SELECT
         NULLIF(btrim(COALESCE(oli.hs_code, p.hs_code, '')), '') AS hs_code,
         COALESCE(NULLIF(btrim(oli.declaration_name), ''), NULLIF(btrim(p.declaration_name), ''), NULLIF(btrim(oli.product_name), '')) AS declaration_name,
         NULLIF(btrim(p.declaration_elements), '') AS declaration_elements,
         oli.qty_ctn,
         oli.nw_ctn,
         oli.unit_price,
         oli.subtotal
       FROM order_line_items oli
       LEFT JOIN product_one p ON p.sku = oli.sku
       WHERE oli.order_id = ANY($1::int[])
     ),
     hs_elements AS (
       SELECT hs_code, MIN(declaration_elements) AS declaration_elements
       FROM keyed
       WHERE declaration_elements IS NOT NULL
       GROUP BY hs_code
     )
     SELECT
       k.hs_code,
       k.declaration_name,
       MAX(h.declaration_elements) AS declaration_elements,
       SUM(k.qty_ctn) AS qty_ctn,
       SUM(CASE WHEN k.nw_ctn IS NOT NULL AND k.qty_ctn IS NOT NULL THEN k.nw_ctn * k.qty_ctn ELSE NULL END) AS net_weight_kg,
       MIN(k.unit_price) AS unit_price,
       SUM(k.subtotal) AS total_amount
     FROM keyed k
     LEFT JOIN hs_elements h ON h.hs_code IS NOT DISTINCT FROM k.hs_code
     GROUP BY k.hs_code, k.declaration_name
     ORDER BY hs_code, declaration_name`,
    [orderIds]
  );
  return r.rows;
}

function cell(label, value, cls) {
  return `<div class="cell ${cls || ""}"><div class="lbl">${esc(label)}</div><div class="val">${blank(value)}</div></div>`;
}

function bigCell(label, value) {
  return `<div class="cell wide"><div class="lbl">${esc(label)}</div><div class="val">${blank(value)}</div></div>`;
}

function cargoRows(lines, destination) {
  if (!lines.length) {
    return `<tr><td colspan="9" class="empty-row">无货物明细</td></tr>`;
  }
  var seenHs = new Set();
  return lines.map(function (l, i) {
    var qty = [
      fmtM(l.net_weight_kg, 0) ? fmtM(l.net_weight_kg, 0) + "千克" : "",
      fmtInt(l.qty_ctn) ? fmtInt(l.qty_ctn) + "箱" : "",
    ].filter(Boolean).join("<br>");
    var money = [
      fmtM(l.unit_price, 2),
      fmtM(l.total_amount, 2),
      "人民币",
    ].filter(Boolean).join("<br>");
    var hs = clean(l.hs_code) || "__row_" + i;
    var elements = seenHs.has(hs) ? "" : clean(l.declaration_elements);
    seenHs.add(hs);
    var name = [clean(l.declaration_name), elements].filter(Boolean).map(esc).join("<br>");
    return `<tr>
      <td>${i + 1}</td>
      <td>${blank(l.hs_code)}</td>
      <td class="goods-name">${name || '<span class="empty">—</span>'}</td>
      <td>${qty || '<span class="empty">—</span>'}</td>
      <td>${money || '<span class="empty">—</span>'}</td>
      <td>中国(CHN)</td>
      <td>${blank(destination)}</td>
      <td><span class="empty">—</span></td>
      <td>照章征税</td>
    </tr>`;
  }).join("");
}

export async function renderCustomsDeclaration(pool, shipmentId, opts) {
  opts = opts || {};
  var plan = await loadPlan(pool, shipmentId);
  if (!plan) return null;

  var praw = parseRaw(plan.raw);
  var orders = await loadOrders(pool, plan);
  var orderIds = orders.map(function (o) { return Number(o.id); }).filter(Boolean);
  var lines = await loadLines(pool, orderIds);

  var issuer = clean(firstOrderValue(orders, "issuing_company", "issuingCompany"));
  var company = await loadCompany(pool, issuer);
  var shipper = sellerLabel(issuer, company);

  var customer = firstOrderValue(orders, "customer", "customer");
  // 合同协议号用我们的 FS 号(内部号),优先取 FS 开头的合同号;都没有才退回原始 contract_no
  var contractNo = (function () {
    for (var i = 0; i < orders.length; i++) {
      var raw = parseRaw(orders[i].raw);
      var v = clean(pick(orders[i].fs_no, raw.fs_no, orders[i].contract_no, orders[i].contractNo, raw.contractNo));
      if (/^FS/i.test(v)) return v;
    }
    return firstOrderValue(orders, "contract_no", "contractNo");
  })();
  var currency = firstOrderValue(orders, "currency", "currency") || "CNY";
  var tradeMode = "0110 一般贸易";
  var levyNature = "101 一般征税";
  var pod = pick(plan.pod, praw.pod, praw.destinationPort, "");
  var destination = countryFromPod(firstOrderValue(orders, "country", "country") || pod);
  var vesselVoyage = [pick(plan.vessel, praw.vessel), pick(plan.voyage, praw.voyage)].filter(Boolean).join(" / ");
  var blNo = pick(plan.bl_no, praw.blNo, praw.bl_no);
  var containerNo = pick(plan.container_no, praw.containerNo, praw.container_no);
  var grossWeight = pick(plan.gross_weight_kg, plan.gross_weight, praw.grossWeight, praw.gross_weight_kg);
  var netWeight = pick(plan.net_weight_kg, plan.net_weight, praw.netWeight, praw.net_weight_kg);
  var totalCtn = lines.reduce(function (s, l) {
    var n = Number(l.qty_ctn);
    return s + (Number.isFinite(n) ? n : 0);
  }, 0);
  var notes = containerNo ? "集装箱号: " + containerNo : "";
  var today = fmtDate(opts.declareDate || new Date());

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>中华人民共和国海关出口货物报关单</title>
<style>
  @page { size: A4 landscape; margin: 8mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #fff;
    color: #111;
    font-family: "SimSun","Songti SC","Microsoft YaHei",Arial,sans-serif;
    font-size: 11px;
    line-height: 1.25;
  }
  .sheet { width: 281mm; min-height: 194mm; margin: 0 auto; padding: 5mm 6mm; }
  .top { position: relative; text-align: center; margin-bottom: 4px; }
  h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 2px; }
  .barcode { position: absolute; right: 0; top: 0; width: 48mm; text-align: center; }
  .bars {
    height: 13mm; border: 1px solid #222;
    background: repeating-linear-gradient(90deg,#111 0,#111 1px,#fff 1px,#fff 3px,#111 3px,#111 5px,#fff 5px,#fff 8px);
    opacity: .75;
  }
  .check-only { margin-top: 2px; font-size: 14px; font-weight: 700; }
  .meta { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin: 2mm 0 1.5mm; font-size: 11px; }
  .grid4 { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr 1fr; border-top: 1px solid #222; border-left: 1px solid #222; }
  .grid4.row2 { grid-template-columns: 1.4fr 1fr 1.4fr 1fr; }
  .grid4.row3 { grid-template-columns: 1.4fr 1fr 1fr 1fr; }
  .grid4.row4 { grid-template-columns: 1.2fr 1fr 1fr 1fr 1fr; }
  .grid4.row5 { grid-template-columns: .8fr .7fr .9fr .9fr .8fr .8fr .8fr .8fr; }
  .cell { min-height: 13mm; padding: 2px 4px; border-right: 1px solid #222; border-bottom: 1px solid #222; }
  .cell.small { min-height: 10mm; }
  .cell.wide { min-height: 12mm; border-left: 1px solid #222; border-right: 1px solid #222; border-bottom: 1px solid #222; padding: 2px 4px; }
  .lbl { color: #222; font-size: 10px; margin-bottom: 2px; }
  .val { font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .empty { color: #aaa; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 0; }
  th, td { border: 1px solid #222; padding: 3px 4px; vertical-align: top; text-align: left; }
  th { text-align: center; font-weight: 700; font-size: 10px; }
  td { height: 19mm; font-size: 11px; }
  .goods th:nth-child(1), .goods td:nth-child(1) { width: 8mm; text-align: center; }
  .goods th:nth-child(2), .goods td:nth-child(2) { width: 24mm; }
  .goods th:nth-child(3), .goods td:nth-child(3) { width: 76mm; }
  .goods th:nth-child(4), .goods td:nth-child(4) { width: 28mm; text-align: center; }
  .goods th:nth-child(5), .goods td:nth-child(5) { width: 27mm; text-align: center; }
  .goods th:nth-child(6), .goods td:nth-child(6) { width: 25mm; text-align: center; }
  .goods th:nth-child(7), .goods td:nth-child(7) { width: 28mm; text-align: center; }
  .goods th:nth-child(8), .goods td:nth-child(8) { width: 28mm; text-align: center; }
  .goods th:nth-child(9), .goods td:nth-child(9) { width: 23mm; text-align: center; }
  .goods-name { line-height: 1.35; }
  .empty-row { text-align: center; color: #aaa; height: 28mm; }
  .confirm-line { display: grid; grid-template-columns: repeat(7, 1fr); border-left: 1px solid #222; font-size: 10px; }
  .confirm-line div { border-right: 1px solid #222; border-bottom: 1px solid #222; padding: 3px 4px; min-height: 7mm; }
  .bottom { display: grid; grid-template-columns: 1.1fr 1.2fr 1.1fr; border-left: 1px solid #222; }
  .bottom .box { min-height: 25mm; border-right: 1px solid #222; border-bottom: 1px solid #222; padding: 4px; }
  .declare { margin-top: 8px; font-size: 12px; line-height: 1.6; }
  .stamp { height: 16mm; margin-top: 4px; display: flex; align-items: flex-end; justify-content: flex-end; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .sheet { width: auto; margin: 0; padding: 0; }
  }
</style>
</head>
<body>
<div class="sheet">
  <div class="top">
    <h1>中华人民共和国海关出口货物报关单</h1>
    <div class="barcode"><div class="bars"></div><div class="check-only">仅供核对用</div></div>
  </div>

  <div class="meta">
    <div>预录入编号: ${blank(opts.preEntryNo || "")}</div>
    <div>海关编号: ${blank(opts.customsNo || "")} ${blank(opts.customsName || "")}</div>
    <div style="text-align:right">页码: 1/1</div>
  </div>

  <div class="grid4">
    ${cell("境内发货人", shipper)}
    ${cell("出境关别", "")}
    ${cell("出口日期", fmtDate(pick(plan.etd, praw.etd)))}
    ${cell("申报日期", today)}
    ${cell("备案号", "")}
  </div>
  <div class="grid4 row2">
    ${cell("境外收货人", customer)}
    ${cell("运输方式", "水路运输")}
    ${cell("运输工具名称及航次号", vesselVoyage)}
    ${cell("提运单号", blNo)}
  </div>
  <div class="grid4 row3">
    ${cell("生产销售单位", shipper)}
    ${cell("监管方式", tradeMode)}
    ${cell("征免性质", levyNature)}
    ${cell("许可证号", "")}
  </div>
  <div class="grid4 row4">
    ${cell("合同协议号", contractNo)}
    ${cell("贸易国(地区)", destination)}
    ${cell("运抵国(地区)", destination)}
    ${cell("指运港", pod)}
    ${cell("离境口岸", "")}
  </div>
  <div class="grid4 row5">
    ${cell("包装种类", "纸箱", "small")}
    ${cell("件数", totalCtn ? fmtInt(totalCtn) : "", "small")}
    ${cell("毛重(千克)", fmtM(grossWeight, 0), "small")}
    ${cell("净重(千克)", fmtM(netWeight, 0), "small")}
    ${cell("成交方式", "FOB", "small")}
    ${cell("运费", "", "small")}
    ${cell("保费", "", "small")}
    ${cell("杂费", "", "small")}
  </div>
  ${bigCell("随附单证及编号", "")}
  ${bigCell("标记唛码及备注", notes)}

  <table class="goods">
    <thead>
      <tr>
        <th>项号</th>
        <th>商品编号</th>
        <th>商品名称及规格型号</th>
        <th>数量及单位</th>
        <th>单价/总价/币制</th>
        <th>原产国(地区)</th>
        <th>最终目的国(地区)</th>
        <th>境内货源地</th>
        <th>征免</th>
      </tr>
    </thead>
    <tbody>${cargoRows(lines, destination)}</tbody>
  </table>

  <div class="confirm-line">
    <div>特殊关系确认: 否</div>
    <div>价格影响确认: 否</div>
    <div>支付特许权使用费确认: 否</div>
    <div>公式定价确认: 否</div>
    <div>暂定价格确认: 否</div>
    <div>自报自缴: 否</div>
    <div>水运中转: 否</div>
  </div>

  <div class="bottom">
    <div class="box">
      <div>报关人员: <span class="empty">—</span></div>
      <div>证号: <span class="empty">—</span></div>
      <div>电话: <span class="empty">—</span></div>
      <div class="declare">兹申明对以上内容承担如实申报、依法纳税之法律责任</div>
      <div class="stamp">申报单位(签章)</div>
    </div>
    <div class="box">
      <div>申报单位: <span class="empty">—</span></div>
    </div>
    <div class="box">
      <div>海关批注及签章</div>
    </div>
  </div>
</div>
</body>
</html>`;
}
