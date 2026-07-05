export async function renderSo(ctx){
  let { sp, spraw, cfg3, fwd, shipper, consignee, consAddr, vessel, voyage, polSp, podSp, etd, cutoff, ctype, cqty, tgwSp, tcbm, soNo, cargoByOrder, cargoLines, _cargoHTML, html, _xlsCapture, totRow, ap, esc, pick, fmtD, wrap } = ctx;

        var carrier=pick(sp.shipping_line,spraw.shippingLine,"-");
        var eta=pick(sp.eta,spraw.eta,"-"); if(eta&&eta!=="-")eta=fmtD(eta);
        var conNo=pick(sp.container_no,spraw.containerNo,"");
        var sealNo=pick(sp.seal_no,spraw.sealNo,"");
        var cargoDescHTML=_cargoHTML(cargoLines);

        html=wrap("Booking Note — "+soNo,`
          <table style="width:100%;border-collapse:collapse;margin-bottom:0">
            <tr>
              <td style="padding:10px 0 6px 0;border-bottom:2px solid #111">
                <div style="font-size:17px;font-weight:800">${esc(fwd.nameCN)}</div>
                <div style="font-size:10px;color:#666;margin-top:1px">${esc(fwd.nameEN)}</div>
              </td>
              <td style="padding:10px 0 6px 0;border-bottom:2px solid #111;text-align:right;vertical-align:bottom">
                <div style="font-size:15px;font-weight:800;letter-spacing:2px">出口货物委托书</div>
                <div style="font-size:11px;font-weight:600;color:#555;letter-spacing:1px">SHIPPING ORDER</div>
                <div style="font-size:11px;margin-top:4px"><b>D/R No.:</b> ${esc(soNo)} &nbsp;&nbsp; <b>日期:</b> ${esc(fmtD(sp.created_at))}</div>
              </td>
            </tr>
          </table>

          <table style="width:100%;border-collapse:collapse;margin-top:10px;margin-bottom:0">
            <tr>
              <td style="border:1px solid #aaa;padding:8px 10px;font-size:11px;vertical-align:top;width:60%">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:4px">Shipper / 发货人</div>
                <div style="font-weight:700;font-size:12px">${esc(shipper)}</div>
                <div style="font-size:10px;color:#666;margin-top:2px">${esc(cfg3.address||"")}</div>
              </td>
              <td style="border:1px solid #aaa;padding:8px 10px;font-size:11px;vertical-align:top;width:40%;color:#c00" rowspan="3">
                <div style="font-size:9px;font-weight:700;margin-bottom:6px">请在提单待确认样上注明：</div>
                <div style="font-size:11px;font-weight:600">申请目的港最长免箱时间，至少申请目的港免箱混 <u>21 天</u></div>
              </td>
            </tr>
            <tr>
              <td style="border:1px solid #aaa;padding:8px 10px;font-size:11px;vertical-align:top">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:4px">Consignee / 收货人</div>
                <div style="font-weight:700;font-size:12px">${esc(consignee)}</div>
                ${consAddr?`<div style="font-size:10px;color:#666;margin-top:2px">${esc(consAddr)}</div>`:""}
              </td>
            </tr>
            <tr>
              <td style="border:1px solid #aaa;padding:8px 10px;font-size:11px;vertical-align:top">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:4px">Notify Party / 通知人</div>
                <div style="font-weight:700;font-size:12px">${esc(consignee)}</div>
                ${consAddr?`<div style="font-size:10px;color:#666;margin-top:2px">${esc(consAddr)}</div>`:""}
              </td>
            </tr>
          </table>

          <table style="width:100%;border-collapse:collapse;margin-top:8px">
            <tr>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px;width:40%">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">Ocean Vessel &amp; Voyage / 船名航次</div>
                <b>${esc(vessel)}</b> / ${esc(voyage)}
              </td>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px;width:30%">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">Port of Loading / 装货港</div>
                <b>${esc(polSp)}</b>
              </td>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px;width:30%">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">Carrier / 船公司</div>
                <b>${esc(carrier)}</b>
              </td>
            </tr>
            <tr>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">Port of Discharge / 卸货港</div>
                <b>${esc(podSp)}</b>
              </td>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">ETD / 开船日</div>
                <b>${esc(etd)}</b>
              </td>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">ETA / 预计到港</div>
                <b>${esc(eta)}</b>
              </td>
            </tr>
          </table>

          <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:11px">
            <thead><tr style="background:#111;color:#fff">
              <th style="padding:7px 8px;font-size:10px;text-align:center;width:16%">Container No.<br>集装箱号</th>
              <th style="padding:7px 8px;font-size:10px;text-align:center;width:12%">Seal No.<br>封志号</th>
              <th style="padding:7px 8px;font-size:10px;text-align:center;width:9%">Type<br>柜型</th>
              <th style="padding:7px 8px;font-size:10px;text-align:left">Description of Goods &amp; HS Code<br>货物描述 &amp; HS编码</th>
              <th style="padding:7px 8px;font-size:10px;text-align:center;width:10%">G.W.(KG)<br>毛重</th>
              <th style="padding:7px 8px;font-size:10px;text-align:center;width:9%">CBM<br>方数</th>
            </tr></thead>
            <tbody>${(function(){
              var ctrs=spraw.containers||[];
              if(ctrs.length){
                return ctrs.map(function(c){
                  var okey=c.order_no||c.contract_no||"";
                  var cLines=(okey&&cargoByOrder[okey])?cargoByOrder[okey]:cargoLines;
                  return "<tr>"
                    +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:middle'>"+esc(c.container_no||"—")+"</td>"
                    +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:middle'>"+esc(c.seal_no||"—")+"</td>"
                    +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:middle'>"+esc(c.type||ctype)+"</td>"
                    +"<td style='border:1px solid #ddd;padding:8px;vertical-align:top'>"+_cargoHTML(cLines)+"</td>"
                    +"<td style='border:1px solid #ddd;padding:8px;text-align:center;font-weight:700;vertical-align:middle'>"+esc(String(c.gw||"—"))+"</td>"
                    +"<td style='border:1px solid #ddd;padding:8px;text-align:center;font-weight:700;vertical-align:middle'>"+esc(String(c.cbm||"—"))+"</td>"
                    +"</tr>";
                }).join("");
              }
              return "<tr>"
                +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:top'>"+esc(conNo)||"—"+"</td>"
                +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:top'>"+esc(sealNo)||"—"+"</td>"
                +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:top'>"+esc(ctype)+"</td>"
                +"<td style='border:1px solid #ddd;padding:8px;vertical-align:top'>"+cargoDescHTML+"</td>"
                +"<td style='border:1px solid #ddd;padding:8px;text-align:center;font-weight:700;vertical-align:top'>"+esc(String(tgwSp))+"</td>"
                +"<td style='border:1px solid #ddd;padding:8px;text-align:center;font-weight:700;vertical-align:top'>"+esc(String(tcbm))+"</td>"
                +"</tr>";
            })()}</tbody>
          </table>

          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px;font-size:11px">
            ${[["截关日 Cut-off",cutoff||"-"],["运费 Freight","FREIGHT PREPAID"],["柜型 Container",ctype],["柜量 Qty",String(cqty)]].map(function(b){return`<div style="border:1px solid #ddd;padding:6px 10px;border-radius:2px"><div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase">${b[0]}</div><div style="font-weight:600;font-size:12px;margin-top:2px">${esc(b[1])}</div></div>`;}).join("")}
          </div>
          <div style="margin-top:12px;font-size:10px;padding-top:8px;border-top:1px solid #eee;display:flex;justify-content:space-between;color:#555">
            <div><b>制单:</b> ${esc(cfg3.nameEN)}</div><div><b>联系人:</b> ${esc(fwd.contact)} &nbsp; <b>Email:</b> ${esc(fwd.email)}</div>
          </div>
        `,ap);
      
  return { html, _xlsCapture, totRow };
}
