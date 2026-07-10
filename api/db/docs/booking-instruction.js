// api/db/docs/booking-instruction.js
// 出口货物委托单 / SHIPPING BOOKING INSTRUCTION —— 「托书文档」(documents.js type=so) 生成器。
// 数据驱动、防漂移：发货人=order.issuing_company→companies(name_en)；箱号/铅封=container_bookings；
// 货物/HS/毛重/体积=order_line_items(OLI)；外运编号=shipping_plans.booking_no。可编辑 + 版本号。
// 由 so-sq-freight.js 在 type==="so" 时前置转发调用。所有 DB 调用 try/catch，失败用 ctx 兜底，绝不抛。
import { getPool } from "../db.js";

const TEMPLATE_VERSION = "v1";

function digitsFrom(s) { const m = String(s || "").match(/(\d{6,})/); return m ? m[1] : ""; }
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function fmtNum(x, d) { const n = num(x); return d != null ? n.toFixed(d) : String(n); }
function chk(on) { return on ? "☑" : "☐"; } // ☑ / ☐

export async function renderBookingInstruction(ctx) {
  let { sp, spraw, soNo, ap, esc, pick, fmtD } = ctx;
  sp = sp || {};                          // F2: never deref null sp
  const _raw = spraw || sp.raw || {};
  const pool = getPool();
  const q = async (s, p) => { try { const r = await pool.query(s, p); return r.rows; } catch (e) { return []; } };

  const blNo = pick(sp.bl_no, _raw.blNo, _raw.bl_no, "");
  const planId = sp.id || null;

  // 1) 集装箱（可多柜）—— container_bookings
  const ctrs = await q(
    `select container_no, seal_no, container_type, cargo_weight_kg, tare_weight_kg, vgm_weight_kg
       from container_bookings
      where (bl_no = $1 and $1 <> '') or (shipping_plan_id = $2)
      order by id`,
    [blNo, planId]
  );

  // 2) 本计划的订单号
  const orderNos = Array.isArray(_raw.orderNos) && _raw.orderNos.length
    ? _raw.orderNos
    : (sp.order_no ? [sp.order_no] : []);

  // 3) 发货人 = 开票主体 issuing_company → companies（防漂移单一真源）；同时取 order.id 供 OLI
  let shipper = { nameEN: "", nameCN: "", address: "", taxId: "", phone: "" };
  let issuing = "";
  let orderIds = [];                       // F1/F3: resolve real order ids, no contract_no fallback
  if (orderNos.length) {
    const orows = await q(`select id, order_no, issuing_company from orders where order_no = any($1)`, [orderNos]);
    orderIds = orows.map(r => r.id);
    issuing = (orows.find(r => r.issuing_company) || {}).issuing_company || "";
  }
  if (issuing) {
    const crows = await q(
      `select name_en, name_cn, address, tax_id, contact_phone from companies where name_cn = $1 or name_en = $1 limit 1`,
      [issuing]
    );
    if (crows[0]) {
      shipper = {
        nameEN: crows[0].name_en || "", nameCN: crows[0].name_cn || issuing,
        address: crows[0].address || "", taxId: crows[0].tax_id || "", phone: crows[0].contact_phone || ""
      };
    } else { shipper.nameCN = issuing; }
  }
  const shipperTitle = shipper.nameEN || shipper.nameCN || pick(_raw.shipper, "—");

  // 4) 货物行 —— OLI 聚合（毛重真值=Σ gw_ctn×qty_ctn）
  let cargo = [];
  if (orderIds.length) {
    cargo = await q(
      `select declaration_name_en, bl_description, declaration_name, hs_code,
              sum(qty_ctn) as qty, sum(gw_ctn * qty_ctn) as gw, sum(cbm_ctn * qty_ctn) as cbm
         from order_line_items
        where order_id = any($1)
        group by declaration_name_en, bl_description, declaration_name, hs_code
        order by hs_code`,
      [orderIds]
    );
  }
  const cargoMissing = orderIds.length > 0 && cargo.length === 0; // F1: 有单无行→显式缺料，不吐零
  let totQty = 0, totGw = 0, totCbm = 0;
  cargo.forEach(c => { totQty += num(c.qty); totGw += num(c.gw); totCbm += num(c.cbm); });

  // 5) 标量字段
  // 外运编号：booking_no 常被 BL 污染(bl_no错存订舱号)，只认「纯数字且≠BL」的字段，否则取 _id(sp_oocl_2326621450)里的编号
  const _bnFields = [sp.booking_no, sp.forwarder_booking_no, sp.so_no]
    .map(v => (v == null ? "" : String(v)))
    .filter(v => v && v !== blNo && /^\d{6,}$/.test(v));
  const bookingNo = pick(_bnFields[0], digitsFrom(sp._id), "—");
  const cyNo = pick(sp.shipment_no, soNo, "—");
  const contractNo = pick(sp.contract_no, "");
  const vessel = pick(sp.vessel, _raw.vessel, "—");
  const voyage = pick(sp.voyage, _raw.voyage, "");
  const eta = fmtD(pick(sp.eta, _raw.eta, "")) || "—";
  const cutoff = fmtD(pick(sp.cutoff_date, _raw.cutoff, "")) || "—";
  const pol = pick(sp.pol, _raw.pol, "—");
  const pod = pick(sp.pod, _raw.pod, "—");
  const ctnType = pick(sp.container_type, _raw.containerType, (ctrs[0] && ctrs[0].container_type), "40HQ");
  const ctnQty = ctrs.length || num(sp.container_qty) || 1;
  // F5: 多柜混型时组合汇总（1×40HQ + 1×20GP），不谎报 qty×firstType
  const _typeCounts = {};
  ctrs.forEach(c => { const t = c.container_type || ctnType; _typeCounts[t] = (_typeCounts[t] || 0) + 1; });
  const ctnSummary = Object.keys(_typeCounts).length
    ? Object.keys(_typeCounts).map(t => _typeCounts[t] + " × " + t).join(" + ")
    : (ctnQty + " × " + ctnType);
  const consignee = pick(sp.customer_en, sp.customer, _raw.companyNameEN, _raw.companyName, "—");
  const consContact = pick(_raw.consignee_contact, "");
  const consPhone = pick(_raw.consignee_phone, "");
  const consCountry = pick(_raw.consignee_country, "");
  const notify = pick(_raw.notify, "SAME AS CONSIGNEE");
  const terms = String(pick(_raw.tradeTerms, _raw.incoterm, "FOB")).toUpperCase();
  const releaseRaw = String(pick(_raw.release_type, "")).toLowerCase();
  const isTelex = /电放|swb|telex|sea ?way/.test(releaseRaw);
  const isOriginal = !isTelex && /正本|original/.test(releaseRaw);
  const docNo = "SBI-" + (blNo || cyNo || soNo || "DRAFT");
  const issueDate = new Date().toISOString().slice(0, 10);

  // 货物表体：缺料→显式提示；否则明细行 + 合计
  const cargoBody = cargoMissing
    ? `<tr><td class="c" colspan="6" style="color:#b00;padding:16px">⚠ 货物明细缺失：该计划下订单未匹配到明细行(OLI)，请在订单明细补录后重新生成托书</td></tr>`
    : (cargo.length ? cargo : [{ bl_description: "", declaration_name_en: "", hs_code: "", qty: totQty, gw: totGw, cbm: totCbm }]).map(c => {
        const desc = [esc(c.bl_description || ""), esc(c.declaration_name_en || ""), contractNo ? esc(contractNo) : ""].filter(Boolean).join("<br>");
        return `<tr>
          <td class="ce c">N/M</td>
          <td class="ce c b">${esc(fmtNum(c.qty))} ctns</td>
          <td class="ce">${desc || "&mdash;"}</td>
          <td class="ce c">${esc(c.hs_code || "—")}</td>
          <td class="ce c">${esc(fmtNum(c.gw, 0))}</td>
          <td class="ce c">${esc(fmtNum(c.cbm, 3))}</td>
        </tr>`;
      }).join("")
      + `<tr><td class="c b">合计</td><td class="c b">${esc(fmtNum(totQty))} ctns</td><td></td><td></td><td class="c b">${esc(fmtNum(totGw, 0))}</td><td class="c b">${esc(fmtNum(totCbm, 3))}</td></tr>`;

  // 集装箱行
  const ctnRows = (ctrs.length ? ctrs : [{ container_no: "", seal_no: "", container_type: ctnType }]).map(c =>
    `<span class="ci"><b>${esc(c.container_no || "—")}</b> / ${esc(c.seal_no || "—")} <span class="mut">(${esc(c.container_type || ctnType)})</span></span>`
  ).join("");

  const CSS = `<style>
    :root{--ink:#111;--mut:#666;--line:#999;--hd:#1f3a5f;--warn:#fffbe6}
    *{box-sizing:border-box}
    body{margin:0;background:#e9edf1;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif;font-size:12px;line-height:1.5}
    .bar{position:sticky;top:0;z-index:9;background:#1f3a5f;color:#fff;padding:8px 14px;display:flex;gap:8px;align-items:center}
    .bar b{font-size:13px;margin-right:auto}
    .bar button{background:#2e5a8f;color:#fff;border:1px solid #4a77b0;border-radius:5px;padding:5px 12px;font-size:12px;cursor:pointer}
    .bar button:hover{background:#3d6ba3}
    .bar .on{background:#e0a800;border-color:#e0a800;color:#111}
    .page{max-width:820px;margin:16px auto;background:#fff;padding:26px 30px;box-shadow:0 2px 14px rgba(0,0,0,.12)}
    h1{margin:0;font-size:19px;letter-spacing:2px;text-align:center}
    .sub{text-align:center;font-size:11px;color:var(--mut);letter-spacing:1px;margin-top:2px}
    table{width:100%;border-collapse:collapse}
    td,th{border:1px solid var(--line);padding:6px 8px;vertical-align:top;font-size:11.5px}
    .k{font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:2px}
    .b{font-weight:700}.c{text-align:center}.mut{color:var(--mut)}
    .grid td{width:50%}
    .cargo th{background:var(--hd);color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.03em}
    .opts{margin-top:8px}
    .opts td{font-size:11px}
    .ci{display:inline-block;margin-right:14px}
    .legal{margin-top:12px;font-size:9.5px;color:#555;line-height:1.6;border-top:1px solid #ddd;padding-top:8px}
    .sig{margin-top:20px;display:flex;justify-content:space-between;font-size:11px}
    .sig .box{width:46%;border-top:1px solid var(--ink);padding-top:6px;color:var(--mut)}
    .foot{max-width:820px;margin:6px auto 24px;text-align:center;font-size:10px;color:#8a94a0;font-style:italic}
    [contenteditable=true]{background:var(--warn);outline:1px dashed #e0a800}
    @media print{.bar{display:none}body{background:#fff}.page{box-shadow:none;margin:0;max-width:none}}
  </style>`;

  const SCRIPT = "<script>(function(){var doc=document.getElementById('doc');var editing=false;"
    + "var KEY='tuoshu_'+" + JSON.stringify(docNo) + ";"
    + "function fields(){return doc.querySelectorAll('.ce');}"
    + "function toggle(){editing=!editing;fields().forEach(function(e){e.contentEditable=editing?'true':'false';});"
    + "var be=document.getElementById('btnEdit');be.classList.toggle('on',editing);be.textContent=editing?'✓ 编辑中':'✏️ 编辑';}"
    + "function save(){var m={};fields().forEach(function(e,i){m[i]=e.innerHTML;});localStorage.setItem(KEY,JSON.stringify(m));var b=document.getElementById('btnSave');b.textContent='✓ 已存';setTimeout(function(){b.textContent='💾 存草稿';},1500);}"
    + "function load(){try{var m=JSON.parse(localStorage.getItem(KEY)||'null');if(!m)return;fields().forEach(function(e,i){if(m[i]!=null)e.innerHTML=m[i];});}catch(e){}}"
    + "function reset(){localStorage.removeItem(KEY);location.reload();}"
    + "window.__tsEdit=toggle;window.__tsSave=save;window.__tsReset=reset;load();})();<\/script>";

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>出口货物委托单 ${esc(docNo)}</title>${CSS}
${ap ? '<script>window.onload=function(){window.print()}<\/script>' : ''}</head>
<body>
  <div class="bar">
    <b>出口货物委托单 &middot; ${esc(cyNo)}</b>
    <button id="btnEdit" onclick="__tsEdit()">✏️ 编辑</button>
    <button id="btnSave" onclick="__tsSave()">💾 存草稿</button>
    <button onclick="__tsReset()">↺ 还原</button>
    <button onclick="window.print()">🖨 打印/导出PDF</button>
  </div>
  <div class="page" id="doc">
    <h1>出口货物委托单</h1>
    <div class="sub">SHIPPING BOOKING INSTRUCTION</div>

    <table style="margin-top:14px">
      <tr>
        <td style="width:58%">
          <span class="k">Shipper / 发货人</span>
          <span class="ce b">${esc(shipperTitle)}</span>
          <div class="ce mut" style="margin-top:2px">${esc(shipper.nameCN || "")}${shipper.address ? " &middot; " + esc(shipper.address) : ""}</div>
        </td>
        <td>
          <span class="k">外运编号 / Booking No.</span><span class="ce b">${esc(bookingNo)}</span>
          <div style="margin-top:4px"><span class="k">CY单号 (内部)</span><span class="ce b">${esc(cyNo)}</span></div>
        </td>
      </tr>
      <tr>
        <td>
          <span class="k">Consignee / 收货人</span>
          <span class="ce b">${esc(consignee)}</span>
          <div class="ce mut" style="margin-top:2px">${[esc(consContact), esc(consPhone), esc(consCountry)].filter(Boolean).join(" &middot; ")}</div>
        </td>
        <td>
          <span class="k">订舱详情 / Vessel &amp; ETA</span>
          <span class="ce b">${esc(vessel)}${voyage ? " / " + esc(voyage) : ""}</span>
          <div class="ce" style="margin-top:2px">ETA ${esc(eta)}</div>
        </td>
      </tr>
      <tr>
        <td>
          <span class="k">Notify / 通知人</span>
          <span class="ce b">${esc(notify)}</span>
        </td>
        <td>
          <span class="k">报关地点 / Customs Place</span><span class="ce">${esc(pol)}</span>
          <span style="margin-left:16px"><span class="k" style="display:inline">报关票数</span> <span class="ce">1 票</span></span>
          <div style="margin-top:4px"><span class="k">联系方式</span><span class="ce">${esc(shipper.phone || consPhone || "—")}</span></div>
        </td>
      </tr>
      <tr>
        <td><span class="k">Port of Loading / 装货港</span><span class="ce b">${esc(pol)}</span></td>
        <td><span class="k">Port of Discharge / 卸货港</span><span class="ce b">${esc(pod)}</span></td>
      </tr>
    </table>

    <table class="cargo" style="margin-top:10px">
      <thead><tr>
        <th style="width:10%">唛头<br>Mark</th>
        <th style="width:13%">数量<br>Package</th>
        <th>货物名称<br>Description of goods</th>
        <th style="width:14%">HS 编码<br>HS Code</th>
        <th style="width:12%">毛重(kg)<br>Gross weight</th>
        <th style="width:12%">体积(cbm)<br>Measurement</th>
      </tr></thead>
      <tbody>${cargoBody}</tbody>
    </table>

    <table class="opts" style="margin-top:8px">
      <tr>
        <td style="width:50%">提单方式: ${chk(isOriginal)} 正本 &nbsp; ${chk(isTelex)} 电放/SWB</td>
        <td>条款 TERMS: ${chk(terms === "FOB")} FOB &nbsp; ${chk(terms === "EXW")} EXW &nbsp; ${chk(terms === "FCA")} FCA</td>
      </tr>
      <tr>
        <td>是否有电池/液体货物: ${chk(false)} 是 (需MSDS) &nbsp; ${chk(true)} 否</td>
        <td>是否有实木包装/木架/托盘: ${chk(false)} 是 &nbsp; ${chk(true)} 否 (如有需熏蒸)</td>
      </tr>
      <tr>
        <td>箱型箱量 CONTAINER: <span class="ce b">${esc(ctnSummary)}</span></td>
        <td>截关 Cut-off: <span class="ce">${esc(cutoff)}</span></td>
      </tr>
      <tr>
        <td colspan="2"><span class="k">集装箱号 / 铅封号 &middot; Container No. / Seal No.</span>${ctnRows}</td>
      </tr>
    </table>

    <div class="legal">本托书为格式条款，委托方签字/盖章即视为已充分阅读并接受全部内容；如有与本托书冲突之特别约定，须以双方授权代表签字盖章的书面文件为准；本托书传真件、扫描件与原件具有同等法律效力；因本托书引起或与之相关的任何争议，适用中华人民共和国法律，由厦门海事法院管辖。</div>

    <div class="sig">
      <div class="box">委托方签署 / Principal's Signature &amp; Seal<br><span class="mut">(请盖公章，须与Shipper抬头一致)</span></div>
      <div class="box">日期 / Date</div>
    </div>
  </div>
  <div class="foot">托书模板 ${TEMPLATE_VERSION} &middot; 生成 ${esc(issueDate)} &middot; Sanlyn OS Supply Chain Engine</div>
  ${SCRIPT}
</body></html>`;

  // Excel 导出（沿用 so-sq-freight 的 _xlsCapture 结构，字段换成托书要点）
  const _xlsCapture = {
    sheetName: "Booking Instruction",
    docNo, buyer: consignee, date: issueDate, cno: contractNo,
    curr: "", pol, pod, incoterm: terms, poNo: bookingNo,
    seller: { nameEN: shipperTitle, address: shipper.address, tel: shipper.phone, email: "" },
    headers: ["Item", "Detail"],
    rows: [
      { no: "01", item: "Shipper", detail: shipperTitle },
      { no: "02", item: "Consignee", detail: consignee },
      { no: "03", item: "Vessel / Voyage", detail: vessel + (voyage ? " / " + voyage : "") },
      { no: "04", item: "Booking No.", detail: bookingNo },
      { no: "05", item: "Container / Seal", detail: (ctrs[0] ? (ctrs[0].container_no + " / " + ctrs[0].seal_no) : "—") },
      { no: "06", item: "HS Code", detail: (cargo[0] ? cargo[0].hs_code : "—") },
      { no: "07", item: "Total Cartons", detail: fmtNum(totQty) },
      { no: "08", item: "Gross Weight (KG)", detail: fmtNum(totGw, 0) },
      { no: "09", item: "CBM", detail: fmtNum(totCbm, 3) },
    ],
    colKeys: [
      { k: "item", fn: function (r) { return r.item; } },
      { k: "detail", fn: function (r) { return r.detail; } },
    ],
    totals: [],
  };

  return { html, _xlsCapture, totRow: ctx.totRow };
}
