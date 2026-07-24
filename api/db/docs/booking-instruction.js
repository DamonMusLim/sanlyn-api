// api/db/docs/booking-instruction.js
// 出口货物委托单 / SHIPPING BOOKING INSTRUCTION —— 「托书文档」(documents.js type=so) 生成器。
// v3：复用公司标准委托单模版（archived tuoshu-v1.html 的版式与全字段），把 DB 数据接进去，不重造。
//   - 发货人=order.issuing_company→companies(name_en)；外运编号=shipping_plans(防BL污染)；
//     货物/HS/毛重/体积=order_line_items(OLI)；报关/拖车=协同表(公式化，有值才带出)。
//   - 两版可切换：默认船东版（隐内部字段），📋完整版（洋宝宝内部，全字段）。
//   - 表单原生可编辑 + 打印/PDF。托书=订舱前单据，故无集装箱号（箱号在装船后的 SO）。
// 由 so-sq-freight.js 在 type==="so" 时前置转发调用。DB 调用 try/catch，失败用 ctx 兜底，绝不抛。
import { getPool } from "../db.js";

const TEMPLATE_VERSION = "v3";

function digitsFrom(s) { const m = String(s || "").match(/(\d{6,})/); return m ? m[1] : ""; }
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function fmtNum(x, d) { const n = num(x); return d != null ? n.toFixed(d) : String(n); }
const nz = v => v != null && String(v).trim() !== "";

export async function renderBookingInstruction(ctx) {
  let { sp, spraw, soNo, ap, esc, pick, fmtD } = ctx;
  sp = sp || {};
  const _raw = spraw || sp.raw || {};
  const pool = getPool();
  const q = async (s, p) => { try { const r = await pool.query(s, p); return r.rows; } catch (e) { return []; } };
  // attribute-safe escape (value="..."): shared esc only does &<>, so we MUST also escape "  ' \n here
  const a = v => esc(String(v == null ? "" : v)).replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\n/g, "&#10;");
  const ck = cond => (cond ? "checked" : "");
  const dt = rawv => { const s = fmtD(rawv); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; }; // shared fmtD returns "-" for empty

  const blNo = pick(sp.bl_no, _raw.blNo, _raw.bl_no, "");
  const planId = sp.id || null;

  // 1) 订单 → 开票主体(发货人) + order ids
  // ⚠️2026-07-24 根治：原来只认 _raw.orderNos 和 sp.order_no（后者 shipping_plans 根本没这列），
  //   多柜/新建计划的订单挂在 order_nos[] / contract_nos[] / orders.shipping_plan_id 上 → orderIds 永远空
  //   → 货物段/发货人整段空白（CY00406 实锤，全库 46 票同症）。四路取号 + plan_id 兜底。
  const orderNos = [];
  const _pushNos = v => {
    (Array.isArray(v) ? v : (nz(v) ? String(v).split(/[,;、\s]+/) : []))
      .forEach(x => { const s = String(x == null ? "" : x).trim(); if (s && !orderNos.includes(s)) orderNos.push(s); });
  };
  _pushNos(_raw.orderNos); _pushNos(sp.order_nos); _pushNos(sp.contract_nos); _pushNos(sp.order_contract_nos);
  let shipper = { nameEN: "", nameCN: "", address: "", phone: "", contactName: "", email: "" };
  let issuing = "", orderIds = [], orow0 = {};
  const ORD_COLS = `id, order_no, issuing_company, customer, consignee, customer_address, pol, destination_port, trade_terms, freight_term, raw`;
  let orows = [];
  if (orderNos.length) {
    orows = await q(`select ${ORD_COLS} from orders where order_no = any($1) or contract_no = any($1)`, [orderNos]);
  }
  if (!orows.length && planId) { // 兜底：订单反向挂 plan（新建计划常见）
    orows = await q(`select ${ORD_COLS} from orders where shipping_plan_id = $1`, [planId]);
  }
  if (orows.length) {
    orderIds = orows.map(r => r.id);
    orow0 = orows.find(r => nz(r.consignee) || nz(r.customer)) || orows[0] || {};
    issuing = (orows.find(r => r.issuing_company) || {}).issuing_company || "";
  }
  if (!issuing) issuing = pick(sp.issuing_company, "") || ""; // 计划自带开票主体也算数
  const _oraw = (function () { let r = orow0.raw || {}; if (typeof r === "string") { try { r = JSON.parse(r); } catch (e) { r = {}; } } return r || {}; })();
  if (issuing) {
    const crows = await q(`select name_en, name_cn, address, contact_phone, contact_name, einvoice_email from companies where name_cn = $1 or name_en = $1 limit 1`, [issuing]);
    if (crows[0]) shipper = { nameEN: crows[0].name_en || "", nameCN: crows[0].name_cn || issuing, address: crows[0].address || "", phone: crows[0].contact_phone || "", contactName: crows[0].contact_name || "", email: crows[0].einvoice_email || "" };
    else shipper.nameCN = issuing;
  }
  const shipperTitle = shipper.nameEN || shipper.nameCN || pick(_raw.shipper, "");
  // 中国发货(有中文抬头)→中文优先；补邮箱/联系人字段（空则留待填）
  const cnFirst = !!shipper.nameCN;
  const shipperText = [
    cnFirst ? shipper.nameCN : (shipper.nameEN || shipper.nameCN),
    cnFirst ? shipper.nameEN : "",
    shipper.address,
    shipper.phone ? "电话 Tel: " + shipper.phone : "",
    "邮箱 Email: " + (shipper.email || ""),
    "联系人 Attn: " + (shipper.contactName || "")
  ].filter(x => x != null && x !== "").join("\n");

  // 2) 货物行 —— OLI 聚合（毛重真值=Σ gw_ctn×qty_ctn）
  let cargo = [];
  if (orderIds.length) {
    cargo = await q(
      `select declaration_name_en, bl_description, declaration_name, hs_code,
              sum(qty_ctn) as qty, sum(gw_ctn * qty_ctn) as gw, sum(cbm_ctn * qty_ctn) as cbm
         from order_line_items where order_id = any($1)
        group by declaration_name_en, bl_description, declaration_name, hs_code order by hs_code`, [orderIds]);
  }
  // 2b) 纯货代票（source_system=freight_agency，没有我方出口订单→天生无 OLI）：
  //     退到计划自身的真值字段（货描/箱数/毛重/体积），只用库里有的，缺的留空给人工填，绝不编。
  if (!cargo.length) {
    const spDesc = pick(sp.cargo_description, _raw.cargoDescription, sp.product_notes, "");
    const spQty = num(sp.total_cartons), spGw = num(sp.gross_weight_kg), spCbm = num(sp.total_cbm);
    if (nz(spDesc) || spQty || spGw || spCbm) {
      cargo = [{
        bl_description: String(spDesc || ""), declaration_name_en: "", declaration_name: "", hs_code: "",
        qty: spQty || null, gw: spGw || null, cbm: spCbm || null,
      }];
    }
  }
  let totQty = 0, totGw = 0, totCbm = 0;
  cargo.forEach(c => { totQty += num(c.qty); totGw += num(c.gw); totCbm += num(c.cbm); });

  // 3) 集装箱：托书只需柜型/柜量（无箱号/车牌——那是装船后执行数据）
  const ctrs = await q(
    `select container_type from container_bookings where (bl_no = $1 and $1 <> '') or (shipping_plan_id = $2) order by id`, [blNo, planId]);

  // 4) 委托方式（自理/代办）——托书上只是"要不要委托我们"的意向勾选，不带车牌/车队执行数据
  let svc = {};
  if (planId) {
    const srows = await q(`select customs_arrange, trucking_arrange from shipping_plans where id = $1`, [planId]);
    svc = srows[0] || {};
  }
  const isAgentTow = /agent|代/.test(String(svc.trucking_arrange || "") + String(svc.customs_arrange || ""));
  const isSelfTow = !isAgentTow && /self|自/.test(String(svc.trucking_arrange || "") + String(svc.customs_arrange || ""));
  const towDetail = ""; // 客户委托我们代理拖车报关时自行填写（留空可填），系统不回填执行数据

  // 5) 标量字段
  const _bnFields = [sp.booking_no, sp.forwarder_booking_no, sp.so_no].map(v => (v == null ? "" : String(v))).filter(v => v && v !== blNo && /^\d{6,}$/.test(v));
  const bookingNo = pick(_bnFields[0], digitsFrom(sp._id), "");
  const cyNo = pick(sp.shipment_no, soNo, "");
  const contractNo = pick(sp.contract_no, "");
  const vessel = pick(sp.vessel, _raw.vessel, "");
  const voyage = pick(sp.voyage, _raw.voyage, "");
  const eta = dt(pick(sp.eta, _raw.eta, ""));
  const bookingConfirm = [vessel && voyage ? vessel + " / " + voyage : vessel, eta ? "ETA " + eta : ""].filter(Boolean).join("  ");
  // ⚠️2026-07-24：以下标量原来全是 plan-only，新建/多柜绑定的 plan 是空壳 → 整页留白。
  //   一律 plan → order 列 → order.raw 三级兜底（订单是录单真源，plan 只是船务执行层）。
  const pol = pick(sp.pol, _raw.pol, orow0.pol, _oraw.pol, "");
  const pod = pick(sp.pod, _raw.pod, orow0.destination_port, _oraw.destinationPort, _oraw.pod, "");
  const ctnType = pick(sp.container_type, _raw.containerType, (ctrs[0] && ctrs[0].container_type), "40HC");
  const ctnQty = ctrs.length || num(sp.container_qty) || 1;
  const consignee = pick(sp.customer_en, sp.customer, _raw.companyNameEN, _raw.companyName, orow0.customer, _oraw.companyNameEN, "");
  // 真实收货人抬头/地址在 orders.consignee（多行文本），plan 上只有客户简称
  const consFull = pick(orow0.consignee, _oraw.consignee, orow0.customer_address, _oraw.customerAddress, "");
  const consText = nz(consFull)
    ? String(consFull)
    : [consignee, [pick(_raw.consignee_contact, ""), pick(_raw.consignee_phone, ""), pick(_raw.consignee_country, "")].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
  const notify = pick(_raw.notify, "SAME AS CONSIGNEE");
  const terms = String(pick(_raw.tradeTerms, _raw.incoterm, sp.freight_term, orow0.trade_terms, orow0.freight_term, _oraw.tradeTerms, "FOB")).toUpperCase();
  const releaseRaw = String(pick(sp.release_type, _raw.release_type, "")).toLowerCase();
  const isTelex = /电放|swb|telex|sea ?way/.test(releaseRaw);
  const isOriginal = /正本|original/.test(releaseRaw);
  // R1: mutually exclusive on pre-fill (syncChk2 only fires on user change, not load) — telex is default
  const showOrig = isOriginal && !isTelex;
  const showTelex = isTelex || !isOriginal;
  const cargoReady = dt(pick(sp.cargo_ready_date, _raw.cargo_ready, ""));
  const docNo = "SBI-" + (blNo || cyNo || soNo || "DRAFT");

  // 货物表行（textarea/input 预填，原生可编辑）
  const cargoRowsHtml = (cargo.length ? cargo : [{}]).map(c => {
    // declaration_name(中文报关品名) 原来查了却没用 → 只有中文品名的行会退化成光秃秃一行 HS
    const nameLine = [c.bl_description || c.declaration_name || "", c.declaration_name_en || ""].filter(Boolean).join(" ");
    const descLines = [nameLine, c.hs_code ? "HS: " + c.hs_code : ""].filter(Boolean).join("\n");
    return `<tr>
      <td><input type="text" value="${a(cargo.length ? "N/M" : "")}" /></td>
      <td><input type="text" value="${a(c.qty != null ? fmtNum(c.qty) + " ctns" : "")}" /></td>
      <td><textarea rows="2">${esc(descLines)}</textarea></td>
      <td><input type="text" value="${a(c.gw != null ? fmtNum(c.gw, 0) + " kgs" : "")}" /></td>
      <td><input type="text" value="${a(c.cbm != null ? fmtNum(c.cbm, 3) + " cbm" : "")}" /></td>
    </tr>`;
  }).join("") + (cargo.length ? `<tr class="total-row"><td></td><td><input type="text" value="${a(totQty ? fmtNum(totQty) + " ctns" : "")}" /></td><td style="text-align:right;font-weight:700">合计 TOTAL</td><td><input type="text" value="${a(totGw ? fmtNum(totGw, 0) + " kgs" : "")}" /></td><td><input type="text" value="${a(totCbm ? fmtNum(totCbm, 3) + " cbm" : "")}" /></td></tr>` : "");

  const ctnOptions = ["40HC", "40GP", "20GP", "45HC", "LCL"].map(o => `<option ${o === ctnType ? "selected" : ""}>${o}</option>`).join("") + (["40HC", "40GP", "20GP", "45HC", "LCL"].includes(ctnType) ? "" : `<option selected>${esc(ctnType)}</option>`);

  const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>出口货物委托单 ${esc(docNo)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Arial','Microsoft YaHei',sans-serif; font-size: 11px; color: #111; background: #e5e7eb; padding: 6px; }
.page { width: 210mm; margin: 0 auto 10px; background: #fff; padding: 5mm 9mm; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
.doc-title { text-align: center; font-size: 15px; font-weight: 900; letter-spacing: .15em; border-bottom: 2px solid #111; padding-bottom: 3px; }
.doc-en { text-align: center; font-size: 9.5px; color: #555; padding: 1px 0 3px; border-bottom: 1px solid #ccc; }
.main-grid { display: grid; grid-template-columns: 1fr 38%; border: 1px solid #999; border-top: none; }
.left-col { border-right: 1px solid #999; }
.party-block { padding: 2px 6px; border-bottom: 1px solid #999; min-height: 26px; }
.party-block.no-border { border-bottom: none; }
.party-label { font-size: 9.5px; font-weight: 700; margin-bottom: 1px; }
.party-label span { font-weight: 400; font-style: italic; }
textarea, input[type=text], input[type=date] { width: 100%; border: none; outline: none; font-family: inherit; background: transparent; color: #111; resize: none; }
textarea { font-size: 10px; line-height: 1.25; }
input[type=text], input[type=date] { font-size: 10px; border-bottom: 1px dotted #bbb; padding: 0 2px; }
.rp-row { padding: 1px 6px; border-bottom: 1px solid #999; min-height: 14px; }
.rp-row:last-child { border-bottom: none; }
.rp-label { font-size: 9px; color: #555; margin-bottom: 1px; }
.rp-ops { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2px; }
.rp-ops span { font-size: 9px; color: #555; }
.port-row { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #999; border-top: none; }
.port-cell { padding: 4px 8px; border-right: 1px solid #999; }
.port-cell:last-child { border-right: none; }
.port-label { font-size: 9.5px; font-weight: 700; color: #c00; margin-bottom: 2px; }
.port-en { font-size: 8.5px; color: #555; font-style: italic; }
.cargo-wrap { border: 1px solid #999; border-top: none; }
.cargo-table { width: 100%; border-collapse: collapse; }
.cargo-table th { font-size: 8.5px; font-weight: 700; padding: 2px 4px; border: 1px solid #ccc; text-align: center; background: #f5f5f5; line-height: 1.1; }
.cargo-table td { border: 1px solid #ccc; padding: 1px 4px; vertical-align: top; }
.cargo-table td input, .cargo-table td textarea { font-size: 10px; }
.cargo-table .total-row td { background: #f9f9f9; font-weight: 700; }
.decl-row { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #999; border-top: none; }
.decl-left { padding: 3px 6px; border-right: 1px solid #999; }
.decl-right { padding: 3px 6px; }
.cargo-ready, .terms-row, .container-row { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; font-size: 10px; font-weight: 700; flex-wrap: wrap; }
.cargo-ready input { width: 130px; }
.terms-row .term-item { display: flex; align-items: center; gap: 3px; font-weight: 400; }
.terms-row input.other-input { width: 60px; border-bottom: 1px solid #999; }
.check-row { display: flex; align-items: flex-start; margin-bottom: 2px; font-size: 10px; line-height: 1.15; }
.check-row .q { flex: 1; }
.check-row .yn { display: flex; gap: 10px; white-space: nowrap; margin-left: 8px; }
.check-row .yn label, .tow-row label, .bl-type-line label { display: flex; align-items: center; gap: 3px; cursor: pointer; }
.check-row .yn input, .tow-row input, .bl-type-line input, .container-row input.ct-qty { width: auto; }
.container-row input.ct-qty { width: 36px; }
.container-row select.ct-type { width: 66px; font-size: 10px; border: 1px solid #ccc; border-radius: 2px; background: #fff; }
.msds-note { font-size: 8.5px; color: #555; font-style: italic; margin-left: 14px; margin-bottom: 2px; line-height: 1.15; }
.tow-row { display: flex; gap: 16px; margin-top: 2px; font-size: 10px; }
.bl-type-line { display: flex; align-items: center; gap: 12px; margin-top: 2px; font-size: 10px; font-weight: 700; }
.bl-type-line label { font-weight: 400; }
input:focus, textarea:focus, select:focus { background: #fffde7 !important; }
.btn-bar { text-align: center; margin: 6px 0 4px; }
.btn { display: inline-flex; align-items: center; gap: 5px; padding: 7px 18px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; margin: 0 5px; }
.btn-print { background: #111; color: #fff; }
.btn-clear { background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; }
.btn-ver { background: #1f3a5f; color: #fff; }
.btn-ver.on { background: #e0a800; color: #111; }
.foot { text-align:center; font-size:8.5px; color:#8a94a0; font-style:italic; margin:3px 0 8px; }
body.mode-carrier .vfull { display: none !important; }
@media print { body { background: #fff; padding: 0; } .page { box-shadow: none; margin: 0; padding: 5mm 8mm; } .no-print { display: none !important; } input:focus, textarea:focus { background: transparent !important; } }
</style></head>
<body class="mode-carrier">
<div class="btn-bar no-print">
  <button class="btn btn-ver" id="btnVer" onclick="tsVer()">🚢 船东版</button>
  <button class="btn btn-clear" onclick="tsClear()">🗑 清空</button>
  <button class="btn btn-print" onclick="window.print()">🖨 打印 / PDF</button>
</div>
<div class="page">
  <div class="doc-title">出口货物委托单</div>
  <div class="doc-en">SHIPPING BOOKING INSTRUCTION</div>
  <div class="main-grid">
    <div class="left-col">
      <div class="party-block"><div class="party-label">发货人：<span>Shipper:</span></div><textarea id="shipper" rows="6" placeholder="公司名称&#10;地址&#10;电话 / 邮箱 / 联系人">${esc(shipperText)}</textarea></div>
      <div class="party-block"><div class="party-label">收货人：<span>Consignee</span></div><textarea id="consignee" rows="4" placeholder="公司名称&#10;地址&#10;联系人 / 电话">${esc(consText)}</textarea></div>
      <div class="party-block no-border"><div class="party-label">通知人：<span>Notify</span></div><textarea id="notify" rows="3" placeholder="如与收货人相同可留空">${esc(notify)}</textarea></div>
    </div>
    <div class="right-col">
      <div class="rp-row"><div class="rp-label">外运编号：</div><input type="text" id="ref_no" value="${a(bookingNo)}" placeholder="Reference No." /></div>
      <div class="rp-row vfull"><div class="rp-label">CY单号（内部）：</div><input type="text" id="cy_no" value="${a(cyNo)}" placeholder="SHP-CY00___" /></div>
      <div class="rp-row"><div class="rp-label">订舱详细信息确认：</div><textarea rows="2" id="booking_confirm" placeholder="订舱确认信息">${esc(bookingConfirm)}</textarea></div>
      <div class="rp-row"><div class="rp-label">装货港 / Port of loading：</div><input type="text" id="pol" value="${a(pol)}" placeholder="如：Qingdao / Xiamen" /></div>
      <div class="rp-row"><div class="rp-label">卸货港 / Port of discharge：</div><input type="text" id="pod" value="${a(pod)}" placeholder="如：PORT KLANG, WEST" /></div>
      <div class="rp-row vfull"><div class="rp-label">报关地点：</div><input type="text" id="customs_place" value="${a(pol)}" placeholder="如：厦门 / 青岛" /></div>
      <div class="rp-row vfull"><div class="rp-label">报关票数：</div><input type="text" id="customs_tickets" value="${a("1票")}" placeholder="如：1票" /></div>
      <div class="rp-row vfull"><div class="rp-ops">
        <div><span>联系方式：</span><br><input type="text" id="contact" value="${a(shipper.phone)}" placeholder="电话/微信" /></div>
        <div><span>操作：</span><br><input type="text" id="operator" /></div>
        <div><span>单证：</span><br><input type="text" id="doc_clerk" /></div>
      </div></div>
      <div class="rp-row no-border vfull" style="min-height:30px;"><div class="rp-label">委托我们代理拖车报关请填写：</div><textarea rows="2" id="tow_detail" placeholder="拖车联系人/电话 · 装货地址 · 货好时间">${esc(towDetail)}</textarea></div>
    </div>
  </div>
  <div class="cargo-wrap"><table class="cargo-table">
    <thead><tr>
      <th style="width:12%">唛头<br>Mark&amp;number</th><th style="width:12%">数量<br>Number of package</th>
      <th style="width:44%">货物名称 / HS编码<br>Description of goods</th><th style="width:16%">毛重<br>Gross weight</th><th style="width:16%">体积<br>Measurement</th>
    </tr></thead>
    <tbody>${cargoRowsHtml}</tbody>
  </table></div>
  <div class="decl-row">
    <div class="decl-left">
      <div class="cargo-ready"><span>货好时间 (CARGO READY DATE)：</span><input type="date" id="cargo_ready" value="${a(cargoReady)}" /></div>
      <div class="terms-row"><span>条款 (TERMS)：</span>
        <label class="term-item"><input type="checkbox" id="t_fob" ${ck(terms === "FOB")} /> FOB</label>
        <label class="term-item"><input type="checkbox" id="t_exw" ${ck(terms === "EXW")} /> EXW</label>
        <label class="term-item"><input type="checkbox" id="t_fca" ${ck(terms === "FCA")} /> FCA</label>
        <span class="other-label">其他：<input class="other-input" type="text" id="t_other" placeholder="______" /></span>
      </div>
      <div class="check-row"><span class="q">是否有电池/液体货物？Product with Battery：</span><span class="yn">
        <label><input type="checkbox" id="battery_yes" onchange="syncChk(this,'battery_no')" /> YES</label>
        <label><input type="checkbox" id="battery_no" onchange="syncChk(this,'battery_yes')" checked /> NO</label></span></div>
      <div class="msds-note">如果是，请提供MSDS<br><em>If YES, Pls provide the MSDS Test report of Batteries</em></div>
      <div class="check-row"><span class="q">是否有实木包装 / 木架 / 托盘？</span><span class="yn">
        <label><input type="checkbox" id="wood_yes" onchange="syncChk(this,'wood_no')" /> YES</label>
        <label><input type="checkbox" id="wood_no" onchange="syncChk(this,'wood_yes')" checked /> NO</label></span></div>
      <div class="check-row"><span class="q">如有实木包装，是否已做熏蒸？</span><span class="yn">
        <label><input type="checkbox" id="fumig_yes" onchange="syncChk(this,'fumig_no')" /> YES</label>
        <label><input type="checkbox" id="fumig_no" onchange="syncChk(this,'fumig_yes')" checked /> NO</label></span></div>
      <div class="container-row"><span>箱型箱量 (CONTAINER)：</span><div class="ct-inputs" style="display:flex;align-items:center;gap:6px;font-weight:400">
        <input class="ct-qty" type="text" id="ct_qty" value="${a(ctnQty)}" placeholder="1" /><span>×</span>
        <select class="ct-type" id="ct_type">${ctnOptions}</select></div></div>
      <div class="tow-row vfull">
        <label><input type="checkbox" id="self_tow" onchange="syncChk(this,'agent_tow')" ${ck(isSelfTow)} /> 自拖自报</label>
        <label><input type="checkbox" id="agent_tow" onchange="syncChk(this,'self_tow')" ${ck(isAgentTow)} /> 代拖代报</label>
      </div>
    </div>
    <div class="decl-right">
      <div class="bl-type-line" style="margin-top:4px;"><span style="font-size:9.5px;font-weight:700;margin-right:8px;">提单方式：</span>
        <label><input type="checkbox" id="bl_orig" onchange="syncChk2(this,['bl_telex','bl_other_chk'])" ${ck(showOrig)} /> 正本</label>
        <label><input type="checkbox" id="bl_telex" onchange="syncChk2(this,['bl_orig','bl_other_chk'])" ${ck(showTelex)} /> 电放</label>
        <label><input type="checkbox" id="bl_other_chk" onchange="syncChk2(this,['bl_orig','bl_telex'])" /> 其他：</label>
        <input type="text" id="bl_other_txt" placeholder="___________" style="width:80px;border-bottom:1px solid #999;" /></div>
      <div style="margin-top:10px;"><div style="font-size:9px;color:#555;margin-bottom:3px;">备注 Remarks</div>
        <textarea rows="6" id="remarks" placeholder="特殊要求 / 换单 / 报检等" style="border:1px solid #ddd;border-radius:2px;padding:3px;background:#fff;width:100%;">${esc(pick(sp.remarks, _raw.remarks, ""))}</textarea></div>
    </div>
  </div>
  <div style="border:1px solid #999;border-top:none;padding:3px 10px;background:#f9f9f9;"><p style="font-size:7.5px;color:#666;line-height:1.4;">本托书为格式条款，委托方签字/盖章即视为已充分阅读并接受全部内容；如有与本托书冲突之特别约定，须以双方授权代表签字盖章的书面文件为准；本托书传真件、扫描件与原件具有同等法律效力；因本托书引起或与之相关的任何争议，适用中华人民共和国法律，由厦门海事法院管辖。</p></div>
  <div style="border:1px solid #999;border-top:none;padding:4px 10px;"><div style="font-size:9px;color:#555;">委托方签署 / Principal's Signature &amp; Seal（请盖公章，须与Shipper抬头一致）<span style="float:right;color:#aaa;font-size:8px;">签字 / 公章 / 日期</span></div><div style="border-bottom:1px solid #ccc;margin-top:16px;"></div></div>
</div>
<div class="foot">托书模板 ${TEMPLATE_VERSION}（复用公司标准委托单） · ${esc(cyNo || docNo)} · Sanlyn OS</div>
<script>
function syncChk(el,o){ if(el.checked) document.getElementById(o).checked=false; }
function syncChk2(el,os){ if(el.checked) os.forEach(function(id){document.getElementById(id).checked=false;}); }
var CARRIER=true;
function tsVer(){ CARRIER=!CARRIER; document.body.classList.toggle('mode-carrier',CARRIER); var b=document.getElementById('btnVer'); b.textContent=CARRIER?'🚢 船东版':'📋 完整版'; b.classList.toggle('on',!CARRIER); }
function tsClear(){ if(!confirm('确定清空？')) return; document.querySelectorAll('textarea,input[type=text],input[type=date]').forEach(function(e){e.value='';}); document.querySelectorAll('input[type=checkbox]').forEach(function(e){e.checked=false;}); }
${ap ? "window.onload=function(){window.print()};" : ""}
</script>
</body></html>`;

  const _xlsCapture = {
    sheetName: "Booking Instruction", docNo, buyer: consignee, date: eta, cno: contractNo,
    curr: "", pol, pod, incoterm: terms, poNo: bookingNo,
    seller: { nameEN: shipperTitle, address: shipper.address, tel: shipper.phone, email: "" },
    headers: ["Item", "Detail"],
    rows: [
      { no: "01", item: "Shipper", detail: shipperTitle }, { no: "02", item: "Consignee", detail: consignee },
      { no: "03", item: "Vessel / Voyage", detail: vessel + (voyage ? " / " + voyage : "") },
      { no: "04", item: "Booking No.", detail: bookingNo }, { no: "05", item: "POL / POD", detail: pol + " / " + pod },
      { no: "06", item: "HS Code", detail: (cargo[0] ? cargo[0].hs_code : "") },
      { no: "07", item: "Total Cartons", detail: fmtNum(totQty) }, { no: "08", item: "Gross Weight (KG)", detail: fmtNum(totGw, 0) }, { no: "09", item: "CBM", detail: fmtNum(totCbm, 3) },
    ],
    colKeys: [{ k: "item", fn: function (r) { return r.item; } }, { k: "detail", fn: function (r) { return r.detail; } }],
    totals: [],
  };
  return { html, _xlsCapture, totRow: ctx.totRow };
}
