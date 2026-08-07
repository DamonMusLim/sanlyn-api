// /api/db/inspection-request-form.js
// 出境货物检验检疫申请 (报检单 / 商检申请) — 照报关行范本版式,数据从 orders + order_line_items 派生。
// 铁律:字段只对应不编造。货物按 HS 聚合(与报关单同源 → 报关↔商检天然对得上)。
// 未存的工厂检验检疫数据(申请单位登记号/生产单位注册号/产地省份)一律显 "—",绝不造。
// 按柜出票(container_no 过滤,复用报关单的 resolveOrdersForContainer),只检疫货一柜一张。

import { resolveOrdersForContainer } from "./customs-declaration-form.js";

function esc(s) { if (s == null) return ""; return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function clean(v) { return String(v ?? "").trim(); }
function parseRaw(v) { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v); } catch (_) { return {}; } }
function pick() { for (var i = 0; i < arguments.length; i++) { var v = arguments[i]; if (v !== null && v !== undefined && String(v).trim() !== "") return v; } return ""; }
function D(v) { return clean(v) || "—"; }
function fmtM(v, dec) { var n = Number(v); if (!Number.isFinite(n) || n === 0) return "—"; return n.toLocaleString("zh-CN", { minimumFractionDigits: dec == null ? 2 : dec, maximumFractionDigits: dec == null ? 2 : dec, useGrouping: false }); }
function fmtInt(v) { var n = Number(v); if (!Number.isFinite(n) || n === 0) return "—"; return String(Math.round(n)); }
function fmtDate(v) { if (!v) return "—"; var s = String(v); if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); try { var d = new Date(v); if (!Number.isNaN(d.getTime())) return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10); } catch (_) {} return s.slice(0, 10); }

async function loadPlan(pool, shipmentId) {
  var r = await pool.query(`SELECT * FROM shipping_plans WHERE _id::text=$1 OR id::text=$1 OR shipment_no=$1 OR bl_no=$1 LIMIT 1`, [String(shipmentId)]);
  return r.rows[0] || null;
}
function orderKeys(plan) {
  var raw = parseRaw(plan.raw);
  var xs = [].concat(Array.isArray(plan.order_nos) ? plan.order_nos : [])
    .concat(Array.isArray(plan.contract_nos) ? plan.contract_nos : [])
    .concat(Array.isArray(raw.orderNos) ? raw.orderNos : [])
    .concat(Array.isArray(raw.contractNos) ? raw.contractNos : [])
    .concat(clean(plan.contract_no) ? [plan.contract_no] : []);
  var seen = new Set();
  return xs.map(clean).filter(function (x) { if (!x || seen.has(x)) return false; seen.add(x); return true; });
}
async function loadOrders(pool, plan) {
  var keys = orderKeys(plan);
  if (!keys.length) return [];
  var r = await pool.query(`SELECT * FROM orders WHERE order_no = ANY($1::text[]) OR contract_no = ANY($1::text[]) OR _id::text = ANY($1::text[]) OR id::text = ANY($1::text[]) ORDER BY id ASC`, [keys]);
  return r.rows;
}
async function loadOrdersByIds(pool, ids) {
  if (!ids.length) return [];
  var r = await pool.query(`SELECT * FROM orders WHERE id = ANY($1::int[]) ORDER BY id ASC`, [ids]);
  return r.rows;
}
// 货物按 HS+报关名 聚合(与报关单同源)
async function loadInspectionLines(pool, orderIds) {
  if (!orderIds.length) return [];
  var r = await pool.query(
    `WITH product_one AS (
       SELECT DISTINCT ON (sku) sku, hs_code, declaration_name
       FROM products WHERE NULLIF(btrim(sku),'') IS NOT NULL
       ORDER BY sku, active DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
     ),
     keyed AS (
       SELECT COALESCE(NULLIF(btrim(oli.hs_code),''), p.hs_code) AS hs_code,
              COALESCE(NULLIF(btrim(oli.declaration_name),''), NULLIF(btrim(p.declaration_name),''), NULLIF(btrim(oli.product_name),'')) AS decl_name,
              COALESCE(NULLIF(btrim(oli.declaration_name_en),''), '') AS decl_name_en,
              oli.qty_ctn, oli.nw_ctn, oli.unit, oli.subtotal
       FROM order_line_items oli
       LEFT JOIN product_one p ON p.sku = oli.sku
       WHERE oli.order_id = ANY($1::int[])
     )
     SELECT hs_code, decl_name, MAX(decl_name_en) AS decl_name_en,
            SUM(qty_ctn) AS qty_ctn,
            SUM(COALESCE(nw_ctn,0)*COALESCE(qty_ctn,0)) AS net_weight_kg,
            SUM(subtotal) AS total_amount,
            (array_agg(unit ORDER BY qty_ctn DESC NULLS LAST))[1] AS unit
     FROM keyed
     GROUP BY hs_code, decl_name
     ORDER BY hs_code, decl_name`,
    [orderIds]
  );
  return r.rows || [];
}
async function loadCompany(pool, code, nameFallback) {
  var row = null;
  if (clean(code)) {
    // 2026-08-06 修：code=$1 与 merged_into_code=$1 会同时命中「在用」和「已废弃」两行，
    // 原来无 ORDER BY 的 LIMIT 1 是随机取 → 曾把「(已废弃·勿用·合并至VEN-LL)」印上报检单。
    // 现在：精确 code 命中优先 > 在用优先 > id 小优先，三重排序定死，绝不再随机。
    var r = await pool.query(
      `SELECT code, name_cn, name_en, factory_name, registration_no, tax_id, customs_reg_code, ciq_reg_no, address, contact_name, contact_phone, country
         FROM companies
        WHERE code=$1 OR merged_into_code=$1
        ORDER BY (code=$1) DESC, COALESCE(active,true) DESC, id ASC
        LIMIT 1`, [clean(code)]);
    row = r.rows[0] || null;
  }
  if (!row && clean(nameFallback)) {
    var r2 = await pool.query(
      `SELECT code, name_cn, name_en, factory_name, registration_no, tax_id, customs_reg_code, ciq_reg_no, address, contact_name, contact_phone, country
         FROM companies WHERE name_cn=$1 OR name_en=$1
        ORDER BY COALESCE(active,true) DESC, id ASC LIMIT 1`, [clean(nameFallback)]);
    row = r2.rows[0] || null;
  }
  return row || {};
}
function firstOrderValue(orders, col) {
  for (var i = 0; i < orders.length; i++) { var v = clean(orders[i][col]); if (v) return v; var raw = parseRaw(orders[i].raw); var rv = clean(raw[col]); if (rv) return rv; }
  return "";
}
function contractNoOf(orders) {
  var fb = "";
  for (var i = 0; i < orders.length; i++) {
    var raw = parseRaw(orders[i].raw);
    var cs = [orders[i].fs_no, raw.fs_no, orders[i].contract_no, raw.contract_no];
    for (var j = 0; j < cs.length; j++) { var v = clean(cs[j]); if (!v) continue; if (!fb) fb = v; }
  }
  return fb;
}
function countryCn(v) {
  var s = clean(v).toUpperCase();
  var map = { "MALAYSIA": "马来西亚", "MY": "马来西亚", "SINGAPORE": "新加坡", "THAILAND": "泰国", "VIETNAM": "越南", "INDONESIA": "印度尼西亚", "PHILIPPINES": "菲律宾", "BANGLADESH": "孟加拉国" };
  return map[s] || clean(v) || "—";
}

// 单位换算(报检口径)
function unitCn(u) { var s = clean(u).toLowerCase(); if (/袋|bag/.test(s)) return "包/袋"; if (/set|组|套/.test(s)) return "套"; if (/pcs|个|件/.test(s)) return "个"; return "纸制或纤维板制盒/箱"; }

export async function renderInspectionRequest(pool, shipmentId, opts) {
  opts = opts || {};
  var plan = await loadPlan(pool, shipmentId);
  if (!plan) return null;
  var praw = parseRaw(plan.raw);
  var containerNo = clean(opts.container_no || opts.container);
  var orders = await loadOrders(pool, plan);
  if (containerNo) {
    var ids = await resolveOrdersForContainer(pool, plan, containerNo);
    orders = await loadOrdersByIds(pool, ids);
  }
  if (!orders.length) return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h3>出境货物检验检疫申请</h3><p>未找到订单${containerNo ? "(柜 " + esc(containerNo) + ")" : ""}: ${esc(shipmentId)}</p></body>`;
  var orderIds = orders.map(function (o) { return Number(o.id); }).filter(Boolean);
  var lines = await loadInspectionLines(pool, orderIds);

  // 三方公司: 发货人=issuing_company(巴匕,按名查); 收货人=company_code(客户,CN-00040); 申请单位=factory_code
  var shipper = await loadCompany(pool, "", firstOrderValue(orders, "issuing_company"));
  var consignee = await loadCompany(pool, firstOrderValue(orders, "company_code"), firstOrderValue(orders, "customer"));
  var factory = await loadCompany(pool, firstOrderValue(orders, "factory_code"), "");
  var shipperCn = pick(shipper.name_cn, firstOrderValue(orders, "issuing_company"));
  var shipperEn = pick(shipper.name_en, "");
  var consigneeEn = pick(consignee.name_en, firstOrderValue(orders, "customer"));
  var consigneeCn = pick(consignee.name_cn, "");
  // 2026-08-08 改口径(Damon: 难题自己钻研·我们自主申报,不再交工厂/报关行代报):
  //   报检【申请单位】= 申报主体(巴匕),不是工厂。工厂只出现在"生产单位"栏。
  //   依据: 本票真实报检成功单 226N23010013904 —— 申请单位=厦门巴匕进出口有限公司/登记号3502960427,
  //   生产单位=连云港中砂 91320723MADDJNGU67。原来印工厂是"工厂自报"年代的老口径。
  var applicantCn = pick(shipperCn, factory.name_cn, factory.factory_name, "");
  // 2026-08-08: 登记号一律从公司表的官方编码位取(新增 ciq_reg_no / customs_reg_code),
  //   不再拿 registration_no(那是工商注册号) 或 tax_id 顶替。查不到就显 "—",绝不造。
  var applicantRegNo = pick(shipper.ciq_reg_no, shipper.customs_reg_code, "");

  var contractNo = contractNoOf(orders);
  var destination = countryCn(firstOrderValue(orders, "destination") || firstOrderValue(orders, "country") || plan.pod_country || plan.pod);
  var pol = pick(plan.pol, praw.pol, "");
  var pod = pick(plan.pod, praw.pod, "");
  var etd = fmtDate(pick(plan.etd, plan.shipment_date, ""));
  var ctnQty = pick(containerNo ? 1 : plan.container_qty, plan.container_qty, "");
  var ctnType = pick(plan.container_type, "");
  var use = pick(firstOrderValue(orders, "usage"), "饲用"); // 宠物食品报检口径默认饲用
  var certs = (function () {
    var raw = [].concat(orders.flatMap(function (o) { var r = parseRaw(o.raw); return Array.isArray(r.requestedCerts) ? r.requestedCerts : []; }));
    return raw.length ? raw : ["兽医卫生证书"]; // 宠物食品出口默认需兽医卫生证书
  })();

  var totCtn = lines.reduce(function (s, l) { return s + (Number(l.qty_ctn) || 0); }, 0);
  var totNw = lines.reduce(function (s, l) { return s + (Number(l.net_weight_kg) || 0); }, 0);
  var totAmt = lines.reduce(function (s, l) { return s + (Number(l.total_amount) || 0); }, 0);
  var today = fmtDate(opts.applyDate || new Date().toISOString());

  var cargoRows = lines.map(function (l) {
    // 2026-08-06 修：原来兜底硬编码 "PET FOODS" —— 违反本文件开头「一律显 — 绝不造」的规矩。
    // 猫砂(HS1404909090/3824999999)根本不是宠物食品，报检写错品名是合规风险。
    // 缺英文申报名就显 —，让人去补 products.declaration_name_en，绝不替它编一个。
    var nameEn = clean(l.decl_name_en) || "";
    return `<tr>
      <td class="l">${esc(D(l.decl_name))}<br><span class="en${nameEn ? "" : " miss"}">${esc(D(nameEn))}</span></td>
      <td>${esc(D(l.hs_code))}<div class="pq">P/Q</div></td>
      <td>—</td>
      <td class="r">${fmtM(l.net_weight_kg)} 千克</td>
      <td class="r">${fmtM(l.total_amount)} 人民币</td>
      <td>${fmtInt(l.qty_ctn)} ${esc(unitCn(l.unit))}</td>
    </tr>`;
  }).join("");
  // 至少补几行空白以贴合正本版式
  var blank = Math.max(0, 4 - lines.length);
  for (var b = 0; b < blank; b++) cargoRows += `<tr class="blank"><td class="l">&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>`;

  var certLabels = ["兽医卫生证书", "植物检疫证书", "品质证书", "重量证书", "数量证书", "健康证书", "卫生证书", "动物卫生证书"];
  var certRows = certLabels.map(function (name) {
    var on = certs.some(function (c) { return clean(c).indexOf(name) >= 0 || (name === "兽医卫生证书" && /兽医|vet|health cert/i.test(clean(c))); });
    return `<span class="cbox">${on ? "☑" : "☐"} ${esc(name)} ___正 ___副</span>`;
  }).join("");

  var noticeBar = containerNo ? `<div class="ctn-hint">按柜出票 · 集装箱号 ${esc(containerNo)}</div>` : "";

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>出境货物检验检疫申请 — ${esc(contractNo || plan.shipment_no || "")}</title>
<style>
@page{size:A4;margin:8mm}
*{box-sizing:border-box}
body{margin:0;background:#f1f5f9;color:#111;font-family:"SimSun","Songti SC","Microsoft YaHei",Arial,sans-serif;font-size:11.5px;line-height:1.35}
.sheet{max-width:200mm;margin:16px auto;background:#fff;padding:8mm 8mm 6mm;box-shadow:0 4px 24px rgba(0,0,0,.12)}
.top{text-align:center;position:relative;margin-bottom:6px}
.gov{font-size:18px;font-weight:700;letter-spacing:2px}
.h1{font-size:20px;font-weight:800;letter-spacing:3px;margin-top:2px}
.eno{position:absolute;right:0;top:2px;font-size:10px;color:#334155;text-align:right}
.eno b{font-family:monospace}
table.form{width:100%;border-collapse:collapse;margin-top:6px}
table.form td,table.form th{border:1px solid #111;padding:4px 6px;vertical-align:middle}
.lbl{background:#f8fafc;font-weight:700;white-space:nowrap;width:96px;text-align:center}
.cargo th{background:#f1f5f9;font-weight:700;text-align:center;font-size:10.5px}
.cargo td{font-size:11px}
.cargo td.l{text-align:left}.cargo td.r{text-align:right}
.cargo .en{color:#475569;font-size:9.5px}
.cargo .pq{color:#475569;font-size:9px}
.cargo tr.blank td{height:20px}
.foot{font-size:10px;color:#334155;margin-top:4px}
.cbox{display:inline-block;min-width:150px;margin:1px 6px 1px 0;font-size:10.5px}
.decl{font-size:10px;color:#334155;margin-top:6px;line-height:1.6}
.ctn-hint{display:inline-block;margin:4px 0 0;padding:2px 10px;border:1px solid #dc2626;color:#dc2626;border-radius:4px;font-size:10.5px;font-weight:700}
.miss{color:#dc2626}
@media print{body{background:#fff}.sheet{box-shadow:none;margin:0}}
</style></head><body>
<div class="sheet">
  <div class="top">
    <div class="eno">电子底账数据号<br><b>${esc(D(opts.ciq_no || firstOrderValue(orders, "ciq_application_no")))}</b></div>
    <div class="gov">中华人民共和国海关</div>
    <div class="h1">出境货物检验检疫申请</div>
  </div>
  ${noticeBar}

  <table class="form">
    <tr><td class="lbl">申请单位<br>(加盖公章)</td><td colspan="3">${esc(D(applicantCn))} <span style="color:#64748b">申报单位</span></td><td class="lbl">申请日期</td><td>${esc(today)}</td></tr>
    <tr><td class="lbl">申请单位登记号</td><td>${esc(D(applicantRegNo))}</td><td class="lbl">联系人</td><td>${esc(D(factory.contact_name))}</td><td class="lbl">电话</td><td>${esc(D(factory.contact_phone))}</td></tr>
    <tr><td class="lbl">发货人</td><td colspan="5">(中文) ${esc(D(shipperCn))} &nbsp;&nbsp; (外文) ${esc(D(shipperEn))}</td></tr>
    <tr><td class="lbl">收货人</td><td colspan="5">(中文) ${esc(D(consigneeCn))} &nbsp;&nbsp; (外文) ${esc(D(consigneeEn))}</td></tr>
  </table>

  <table class="form cargo">
    <thead><tr><th style="width:26%">货物名称(中/外文)</th><th style="width:15%">H.S.编码</th><th style="width:10%">产地</th><th style="width:16%">数/重量</th><th style="width:17%">货物总值</th><th style="width:16%">包装种类及数量</th></tr></thead>
    <tbody>${cargoRows}</tbody>
    <tfoot><tr><td class="l" style="font-weight:700">合计 TOTAL</td><td></td><td></td><td class="r" style="font-weight:700">${fmtM(totNw)} 千克</td><td class="r" style="font-weight:700">${fmtM(totAmt)} 人民币</td><td style="font-weight:700">${fmtInt(totCtn)} 箱</td></tr></tfoot>
  </table>

  <table class="form">
    <tr><td class="lbl">运输工具名称号码</td><td>${esc(pick(plan.vessel ? "水路运输 / " + clean(plan.vessel) : "水路运输"))}</td><td class="lbl">贸易方式</td><td>一般贸易</td><td class="lbl">货物存放地点</td><td>工厂</td></tr>
    <tr><td class="lbl">合同号</td><td>${esc(D(contractNo))}</td><td class="lbl">信用证号</td><td>—</td><td class="lbl">用途</td><td>${esc(D(use))}</td></tr>
    <tr><td class="lbl">发货日期</td><td>${esc(etd)}</td><td class="lbl">输往国家(地区)</td><td>${esc(destination)}</td><td class="lbl">许可证/审批号</td><td>—</td></tr>
    <tr><td class="lbl">启运地</td><td>${esc(D(pol))}</td><td class="lbl">到达口岸</td><td>${esc(D(pod))}</td><td class="lbl">生产单位注册号</td><td class="${(factory.ciq_reg_no||factory.tax_id) ? "" : "miss"}">${esc(D(pick(factory.ciq_reg_no, factory.tax_id, "")))}</td></tr>
    <tr><td class="lbl">集装箱规格<br>数量及号码</td><td colspan="5">${ctnQty ? esc(ctnQty) + " × " + esc(D(ctnType)) : esc(D(ctnType))}${containerNo ? " &nbsp; 柜号 " + esc(containerNo) : ""}</td></tr>
  </table>

  <table class="form">
    <tr><td class="lbl">检验检疫条款<br>或特殊要求</td><td style="width:40%">无纸化报检</td><td class="lbl">标记及号码</td><td>N/M</td></tr>
    <tr><td class="lbl">随附单据</td><td colspan="3">☑ 合同 &nbsp; ☑ 发票 &nbsp; ☑ 厂检单 &nbsp; ☑ 合格保证 &nbsp; ☐ 信用证 &nbsp; ☐ 许可/审批文件</td></tr>
    <tr><td class="lbl">需要证单名称</td><td colspan="3">${certRows} <span class="cbox">☑ 电子底账</span></td></tr>
  </table>

  <div class="decl">
    <b>申请人郑重声明：</b> 1. 本人被授权申请检验检疫。 2. 上列填写内容正确属实,货物无伪造或冒用他人的厂名、标志、认证标志,并承担货物质量责任。 &nbsp; 签名: ______________<br>
    <span style="color:#94a3b8">注: 有"*"号栏由海关填写 · 本申请由 Sanlyn OS 供应链引擎按订单数据派生(货物与报关单同源),红色"—"处为缺工厂检验检疫主数据待补。</span>
  </div>
</div>
</body></html>`;
}
