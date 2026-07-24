export async function renderSoSqFreight(ctx){
  let { type, sp, spraw, raw, cfg3, soNo, html, _xlsCapture, totRow, ap, esc, pick, fmtD } = ctx;

  // type=so 走《出口货物委托单》专用模板(独立文件，防漂移)；sq/freight-quote 保持原样
  if (type === "so") {
    const { renderBookingInstruction } = await import("./booking-instruction.js");
    return await renderBookingInstruction(ctx);
  }

        var isSO = (type==="so");
        var docTitle = isSO ? "海运单" : "海运确认报价";
        var docTitleEN = isSO ? "SHIPPING ORDER" : "OCEAN FREIGHT QUOTATION";
        var docNo = (isSO ? "SO-" : "FQ-") + pick(sp.bl_no, sp.contract_no, soNo);
        var blNoX = pick(sp.bl_no, spraw.blNo, spraw.bl_no, "—");
        var vesselX = pick(sp.vessel, spraw.vessel, "—");
        var voyageX = pick(sp.voyage, spraw.voyage, "—");
        var cntrX = pick(sp.container_no, spraw.containerNo, "—");
        var sealX = pick(sp.seal_no, spraw.sealNo, "—");
        var polX = pick(sp.pol, spraw.pol, "—");
        var podX = pick(sp.pod, spraw.pod, "—");
        var etdX = fmtD(pick(sp.etd, spraw.etd, ""));
        var etaX = fmtD(pick(sp.eta, spraw.eta, ""));
        var atdX = fmtD(pick(sp.atd, spraw.atd, ""));
        var ctnTypeX = pick(sp.container_type, spraw.containerType, "40HQ");
        var carrierX = pick(sp.carrier_code, spraw.carrier, "—");
        var forwarderX = pick(sp.forwarder_cn, spraw.forwarderCN, spraw.freightForwarder, "—");
        var bookingNoX = pick(sp.forwarder_booking_no, spraw.bookingNo, "—");
        // SO/SQ 走 shipping_plan-only 路径，不需要 order.raw
        var _orderRaw = (typeof raw === 'object' && raw) ? raw : {};
        var totalCtnsX = pick(sp.total_cartons, _orderRaw.totalQty, spraw.totalQty, "—");
        var gwX = pick(sp.gross_weight_kg, _orderRaw.grossWeight, spraw.grossWeight, "—");
        var cbmX = pick(sp.total_cbm, _orderRaw.totalCBM, spraw.totalCBM, "—");
        var shipperX = pick(spraw.shipper, cfg3 && cfg3.nameEN, "—");
        var consigneeX = pick(sp.customer_en, sp.customer, _orderRaw.companyNameEN, _orderRaw.companyName, "—");

        // === CSS 来自模板库 templates/freight-quote-enrich-2026-04.html ===
        var CSS_SO=`<style>
          :root{--bg:#0B1120;--panel:#111a2f;--panel2:#0e1628;--line:#1f2a44;--line2:#2a3858;
                --txt:#e2e8f0;--mut:#94a3b8;--dim:#64748b;--blue:#38bdf8;--blue-bg:rgba(56,189,248,.15);
                --emerald:#34d399;--amber:#fbbf24;--mono:'SF Mono','Menlo','Consolas',monospace;}
          *{box-sizing:border-box}
          body{margin:0;padding:32px 18px;background:var(--bg);color:var(--txt);
               font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;font-size:13px;line-height:1.55}
          .wrap{max-width:880px;margin:0 auto}
          .doc{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
          .doc-hdr{padding:22px 26px;border-bottom:1px solid var(--line);
                   background:linear-gradient(180deg,#13203d 0%,#111a2f 100%);
                   display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
          .doc-hdr h1{margin:0 0 4px;font-size:18px;font-weight:800;letter-spacing:.01em}
          .doc-hdr .seller{font-size:11px;color:var(--mut);font-family:var(--mono);line-height:1.5}
          .doc-hdr .seller b{color:var(--txt)}
          .doc-hdr .qno{text-align:right;font-family:var(--mono);font-size:11px;color:var(--mut)}
          .doc-hdr .qno .big{font-size:16px;color:var(--txt);font-weight:700;margin-bottom:2px}
          .meta{padding:16px 26px;border-bottom:1px solid var(--line);background:var(--panel2);
                display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;font-size:12px}
          .meta .k{color:var(--mut);font-size:11px}
          .meta .v{font-family:var(--mono);color:var(--txt);font-weight:600}
          .sec{padding:18px 26px;border-bottom:1px solid var(--line)}
          .sec:last-of-type{border-bottom:none}
          .sec-ttl{font-size:11px;color:var(--blue);text-transform:uppercase;letter-spacing:.06em;
                   font-weight:800;margin-bottom:12px}
          table{width:100%;border-collapse:collapse;font-size:12px}
          th{text-align:left;color:var(--mut);font-weight:700;padding:9px 10px;
             border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
          td{padding:11px 10px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:12px}
          tr:last-child td{border-bottom:none}
          td.r{text-align:right}td.c{text-align:center}td.b{font-weight:700}
          .pill{display:inline-block;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;
                letter-spacing:.05em;text-transform:uppercase}
          .pill-fob{background:rgba(56,189,248,.15);color:var(--blue);border:1px solid rgba(56,189,248,.4)}
          .terms{padding:14px 26px;background:var(--panel2);color:var(--mut);font-size:11px;line-height:1.7}
          .terms .lbl{color:var(--blue);font-weight:700;font-size:10px;text-transform:uppercase;
                      letter-spacing:.05em;margin-bottom:4px;display:block}
          .terms ul{margin:0;padding-left:18px}
          .sig{padding:24px 26px;display:grid;grid-template-columns:1fr 1fr;gap:60px;
               border-top:1px solid var(--line);background:var(--panel2)}
          .sig div{border-top:1px solid var(--line2);padding-top:6px;font-size:10px;color:var(--mut);text-align:center}
          .sig div b{color:var(--txt);display:block;font-size:11px;margin-bottom:2px}
          .foot{padding:10px 26px;font-size:10px;color:var(--dim);text-align:center;
                font-style:italic;border-top:1px solid var(--line)}
          @media print{body{padding:0;background:#fff;color:#000}
            .doc{border:none;background:#fff;color:#000}
            .meta,.terms,.sig,.doc-hdr,.foot{background:#fff !important;color:#000 !important}
            .meta .k,.terms,.foot,.sig div{color:#444 !important}
            .meta .v,td,th,.doc-hdr h1,.doc-hdr .seller b{color:#000 !important}}
        </style>`;

        var issueDate = new Date().toISOString().slice(0,10).toUpperCase().replace(/-/g,' / ');
        var noteText = isSO
          ? "本海运单为运输确认凭证，仅供报关、提货使用。货物金额请参考 Commercial Invoice (IV)。"
          : "本海运报价确认基于上述航次。具体计费见 Freight Debit Note (DN)。Local charges 另行结算。";

        html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${esc(docTitleEN)} — ${esc(docNo)}</title>${CSS_SO}${ap?'<script>window.onload=function(){window.print()}<\/script>':''}</head>
<body><div class="wrap"><div class="doc">

  <div class="doc-hdr">
    <div>
      <h1>${esc(docTitleEN)}</h1>
      <div class="seller">
        <b>${esc(cfg3 && cfg3.nameEN || shipperX)}</b><br>
        ${esc(cfg3 && cfg3.address || "")}<br>
        Tel: ${esc(cfg3 && cfg3.tel || "")} · Email: ${esc(cfg3 && cfg3.email || "")}
      </div>
    </div>
    <div class="qno">
      <div class="big">${esc(docNo)}</div>
      <div>${esc(docTitle)}</div>
      <div>Issue date: ${esc(issueDate)}</div>
    </div>
  </div>

  <div class="meta">
    <div class="k">SHIPPER 发货方</div><div class="k">CONSIGNEE 收货方</div>
    <div class="v">${esc(shipperX)}</div>
    <div class="v">${esc(consigneeX)}</div>
    <div class="k" style="margin-top:6px">CARRIER 船公司</div><div class="k" style="margin-top:6px">FORWARDER 货代</div>
    <div class="v">${esc(carrierX)}</div>
    <div class="v">${esc(forwarderX)}</div>
    <div class="k" style="margin-top:6px">POL 起运港</div><div class="k" style="margin-top:6px">POD 目的港</div>
    <div class="v">${esc(polX)}</div>
    <div class="v">${esc(podX)}</div>
  </div>

  <div class="sec">
    <div class="sec-ttl">SHIPMENT 航次 · ${esc(blNoX)}</div>
    <table>
      <thead><tr>
        <th style="width:36px">NO.</th><th>Detail</th>
        <th class="c" style="width:90px">Container</th>
        <th class="r" style="width:120px">Value</th>
      </tr></thead>
      <tbody>
        <tr><td class="c">01</td><td>Vessel / Voyage</td><td class="c">${esc(ctnTypeX)}</td><td class="r b">${esc(vesselX)} ${esc(voyageX)}</td></tr>
        <tr><td class="c">02</td><td>B/L No.</td><td class="c">—</td><td class="r b">${esc(blNoX)}</td></tr>
        <tr><td class="c">03</td><td>Booking No.</td><td class="c">—</td><td class="r">${esc(bookingNoX)}</td></tr>
        <tr><td class="c">04</td><td>Container No. / Seal</td><td class="c">${esc(ctnTypeX)}</td><td class="r">${esc(cntrX)} / ${esc(sealX)}</td></tr>
        <tr><td class="c">05</td><td>ETD 预计开船 → ETA 预计到港</td><td class="c">—</td><td class="r"><b>${esc(etdX)}</b> → ${esc(etaX)}</td></tr>
        ${atdX !== "-" ? `<tr><td class="c">06</td><td>ATD 实际开船</td><td class="c">—</td><td class="r b" style="color:var(--emerald)">${esc(atdX)}</td></tr>` : ""}
      </tbody>
    </table>
  </div>

  <div class="sec">
    <div class="sec-ttl">CARGO 货物</div>
    <table>
      <thead><tr><th>项目 Item</th><th class="r">数量 Value</th></tr></thead>
      <tbody>
        <tr><td>总箱数 Total Cartons</td><td class="r b">${esc(totalCtnsX)}</td></tr>
        <tr><td>总毛重 Gross Weight</td><td class="r b">${esc(gwX)} KG</td></tr>
        <tr><td>总体积 CBM</td><td class="r b">${esc(cbmX)} m³</td></tr>
      </tbody>
    </table>
  </div>

  <div class="terms">
    <span class="lbl">NOTE</span>
    <ul><li>${esc(noteText)}</li>${isSO?'<li>本单据不含金额；如需查看商业金额请下载 Commercial Invoice (IV)。</li>':'<li>本运价不含金额，仅作运输安排确认；正式账单见 Freight Debit Note (DN)。</li>'}</ul>
  </div>

  <div class="sig">
    <div><b>SHIPPER ACKNOWLEDGED</b>(签字 / 盖章)</div>
    <div><b>CARRIER / AGENT</b>(签字 / 盖章)</div>
  </div>

  <div class="foot">⚡ Generated &amp; Verified by Sanlyn OS Supply Chain Engine · ${esc(issueDate)}</div>
</div></div></body></html>`;

        // 2026-05-19: SO/SQ Excel 导出支持
        _xlsCapture = {
          sheetName: isSO ? "Shipping Order" : "Freight Quote",
          docNo: docNo,
          buyer: consigneeX, date: issueDate, cno: sp.contract_no || "",
          curr: "", pol: polX, pod: podX, incoterm: "",
          poNo: sp.contract_no || "",
          seller: { nameEN: cfg3 && cfg3.nameEN || "", address: cfg3 && cfg3.address || "", tel: cfg3 && cfg3.tel || "", email: cfg3 && cfg3.email || "" },
          headers: ["NO.", "Item", "Detail"],
          rows: [
            { no: "01", item: "Vessel / Voyage",       detail: vesselX + " " + voyageX },
            { no: "02", item: "B/L No.",                detail: blNoX },
            { no: "03", item: "Booking No.",            detail: bookingNoX },
            { no: "04", item: "Container No. / Seal",   detail: cntrX + " / " + sealX },
            { no: "05", item: "ETD",                    detail: etdX },
            { no: "06", item: "ETA",                    detail: etaX },
            { no: "07", item: "ATD",                    detail: atdX },
            { no: "08", item: "Total Cartons",          detail: totalCtnsX },
            { no: "09", item: "Gross Weight (KG)",      detail: gwX },
            { no: "10", item: "CBM",                    detail: cbmX },
          ],
          colKeys: [
            { k: "no",     fn: function(r){return r.no;} },
            { k: "item",   fn: function(r){return r.item;} },
            { k: "detail", fn: function(r){return r.detail;} },
          ],
          totals: [],
        };
      
  return { html, _xlsCapture, totRow };
}
