export function renderDebit(ctx){
  const { sp, spraw, cust, _fmtVariant, soNo, cqty, cfg3, consignee, consAddr, fmtD, etd, vessel, voyage, polSp, podSp, fmtM, esc, ap, pick } = ctx;
  var html;
        // ⚠ Real fields only — never fabricate values (memory: feedback_never_invent_fields)
        var freightTerm = pick(sp.freight_term, "");           // 2026-05-18 new column
        var quoteRef    = pick(sp.quote_ref, "");              // 2026-05-18 new column
        var buyerUscc   = pick(cust && cust.uscc, "");         // 2026-05-18 new customers.uscc
        // W0-6: NO hardcoded 7.2 fallback. exr resolves to 0 when no rate is
        // available; downstream USD→CNY conversion must guard against 0.
        var exr=Number(pick(sp.exchange_rate,spraw.exchangeRate,0));
        var fUSD=Number(pick(sp.freight_sale_usd,0));
        var fCNY=Number(pick(sp.freight_cost,0));
        var thcF=Number(pick(sp.thc_fee,0));
        var docF=Number(pick(sp.doc_fee,0));
        var sealF=Number(pick(sp.seal_fee,0));
        var blF=Number(pick(sp.tlx_fee,0));
        var eirF=Number(pick(sp.eir_fee,0));
        var vgmF=Number(pick(sp.info_trans_fee,0));
        var bkgF=Number(pick(sp.bkg_fee,0));
        var truck=Number(pick(sp.trucking_cost_total,0));
        var customs=Number(pick(sp.customs_cost_total,0));
        var ins=Number(pick(sp.insurance_cost,0));
        var blNo=pick(sp.bl_no,spraw.blNo,spraw.bl_no,"");
        var _isFob = ['FOB','FCA'].indexOf(String(freightTerm||'').toUpperCase().trim())>=0;
        var _portMisc = ['THC','DOCUMENTATION FEE','SEAL FEE','B/L FEE','EIR','VGM','BOOKING FEE'];
        var _portMiscCNY = thcF+docF+sealF+blF+eirF+vgmF+bkgF;
        var totCNY=(_isFob ? 0 : _portMiscCNY)+fCNY+truck+customs;
        var totUSD=fUSD+ins;
        // 2026-05-19: DN 默认 "DB-" 前缀；fmt=iv 时改 "INV-" + 标题切 INVOICE
        var _isIvFmt = (_fmtVariant === "iv");
        var dbNo = (_isIvFmt ? "INV-" : "DB-") + soNo;
        var _dnTitleCN = _isIvFmt ? "海运费发票" : "借记通知单";
        var _dnTitleEN = _isIvFmt ? "FREIGHT INVOICE" : "DEBIT NOTE";

        // Build fee rows: [label_en, label_cn, qty, currency, amount]
        var feeList=[
          ["OCEAN FREIGHT","海运费",cqty,"USD",fUSD],
          ["THC","码头操作费",1,"CNY",thcF],
          ["DOCUMENTATION FEE","文件费",1,"CNY",docF],
          ["SEAL FEE","铅封费",cqty,"CNY",sealF],
          ["B/L FEE","提单/电放费",1,"CNY",blF],
          ["EIR","设备交接费",cqty,"CNY",eirF],
          ["VGM","信息代输费",1,"CNY",vgmF],
          ["BOOKING FEE","订舱费",1,"CNY",bkgF],
          ["TRUCKING","拖车费",1,"CNY",truck],
          ["CUSTOMS","报关费",1,"CNY",customs],
          ["INSURANCE","保险费",1,"USD",ins],
        ].filter(function(r){
          if(r[4]<=0) return false;
          if(_isFob && _portMisc.indexOf(r[0])>=0) return false; // FOB: 港杂归工厂, 不上客户账单
          return true;
        });

        var CSS2=`<style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{font-family:'Helvetica','Arial','PingFang SC',sans-serif;color:#000;padding:30px;font-size:11px;line-height:1.4;background:#f0f0f0;}
          .container{max-width:800px;margin:auto;background:#fff;padding:30px;}
          .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:15px;margin-bottom:25px;}
          .seller-name{font-size:18px;font-weight:900;text-transform:uppercase;margin-bottom:4px;}
          .seller-sub{font-size:10px;color:#666;}
          .doc-type h1{margin:0;font-size:28px;font-weight:900;letter-spacing:1px;text-align:right;}
          .doc-type p{font-size:13px;font-weight:700;margin:3px 0;text-align:right;color:#444;}
          .meta-grid{display:grid;grid-template-columns:1.2fr 0.8fr;gap:40px;margin-bottom:20px;}
          .section-label{font-size:10px;font-weight:700;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:3px;margin-bottom:8px;color:#444;}
          .meta-list{list-style:none;padding:0;margin:0;}
          .meta-list li{margin-bottom:5px;display:flex;gap:6px;}
          .meta-list b{min-width:110px;font-weight:700;}
          .shipping-bar{border:2px solid #000;padding:10px;display:flex;justify-content:space-between;margin-bottom:25px;font-weight:700;font-size:11px;}
          table{width:100%;border-collapse:collapse;margin-bottom:25px;}
          th{background:#000;color:#fff;padding:10px;text-align:left;font-size:10px;text-transform:uppercase;}
          td{padding:10px;border-bottom:1px solid #ccc;vertical-align:top;}
          .tc{text-align:center;} .tr{text-align:right;}
          tfoot td{font-size:13px;font-weight:900;border-top:2px solid #000;border-bottom:none;}
          .details-grid{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:10px;page-break-inside:avoid;break-inside:avoid;}
          .details-box{border:1px solid #000;padding:12px;page-break-inside:avoid;break-inside:avoid;}
          .details-box h4{margin:0 0 10px 0;font-size:11px;text-transform:uppercase;text-decoration:underline;}
          .sig-row{display:flex;justify-content:space-between;margin-top:50px;page-break-inside:avoid;break-inside:avoid;}
          .sig-b{width:45%;border-top:2px solid #000;padding-top:10px;text-align:center;height:80px;font-weight:700;display:flex;flex-direction:column;justify-content:space-between;page-break-inside:avoid;break-inside:avoid;}
          tr,thead,tfoot,tfoot td{page-break-inside:avoid;break-inside:avoid;}
          .sig-note{font-weight:400;font-size:9px;}
          .footer-slogan{text-align:center;margin-top:30px;font-size:9px;color:#888;border-top:1px dashed #ccc;padding-top:12px;letter-spacing:1px;}
          @media print{body{background:#fff;padding:0;}.container{max-width:100%;}}
        </style>`;

        html=`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Debit Note — ${esc(dbNo)}</title>${CSS2}${ap?'<script>window.onload=function(){window.print()}<\/script>':""}</head><body><div class="container">
          <div class="header">
            <div class="seller-info">
              <div class="seller-name">${esc(cfg3.nameEN)}</div>
              <div class="seller-sub">${esc(cfg3.address)}</div>
              <div class="seller-sub">Tel: ${esc(cfg3.tel)} | Email: ${esc(cfg3.email)}</div>
            </div>
            <div class="doc-type"><h1>${esc(_dnTitleCN)}</h1><p>${esc(_dnTitleEN)}</p></div>
          </div>
          <div class="meta-grid">
            <div>
              <div class="section-label">付款方 / BILL TO</div>
              <p style="font-size:13px;font-weight:700;margin:0 0 5px 0">${esc(consignee)}</p>
              <p style="color:#555">${esc(consAddr)}</p>
              ${buyerUscc?`<p style="color:#555;font-family:monospace;font-size:10px;margin-top:3px">USCC 统一社会信用代码: <b>${esc(buyerUscc)}</b></p>`:""}
            </div>
            <div>
              <div class="section-label">单据详情 / DETAILS</div>
              <ul class="meta-list">
                <li><b>账单编号 DB No.:</b>${esc(dbNo)}</li>
                ${blNo?`<li><b>提单号 B/L No.:</b>${esc(blNo)}</li>`:""}
                <li><b>日期 Date:</b>${fmtD(new Date())}</li>
                <li><b>ETD:</b>${esc(etd)}</li>
                ${freightTerm?`<li><b>付款方式 Freight Term:</b>${esc(freightTerm)}</li>`:""}
                ${quoteRef?`<li><b>报价单号 Quote Ref:</b>${esc(quoteRef)}</li>`:""}
              </ul>
            </div>
          </div>
          <div class="shipping-bar">
            <span>船名航次 VSL/VOY: ${esc(vessel)} / ${esc(voyage)}</span>
            <span>起运港 POL: ${esc(polSp)}</span>
            <span>目的港 POD: ${esc(podSp)}</span>
          </div>
          <table>
            <thead><tr>
              <th style="width:40px">No.</th>
              <th>费用项目 Description</th>
              <th class="tc" style="width:55px">数量 Qty</th>
              <th class="tc" style="width:55px">币种 Cur</th>
              <th class="tr" style="width:100px">金额 Amount</th>
            </tr></thead>
            <tbody>
              ${feeList.map(function(r,i){return`<tr><td>${String(i+1).padStart(2,"0")}</td><td>${esc(r[0])} / <span style="color:#555">${esc(r[1])}</span></td><td class="tc">${r[2]}</td><td class="tc">${r[3]}</td><td class="tr">${fmtM(r[4])}</td></tr>`;}).join("")||`<tr><td colspan="5" style="text-align:center;color:#ccc;font-style:italic;padding:20px">— 费用明细将从海运计划自动填入 —</td></tr>`}
            </tbody>
            <tfoot>
              ${totCNY>0?`<tr><td colspan="4" class="tr">小计 CNY:</td><td class="tr">CNY ${fmtM(totCNY)}</td></tr>`:""}
              ${totUSD>0?`<tr><td colspan="4" class="tr">小计 USD:</td><td class="tr">USD ${fmtM(totUSD)}</td></tr>`:""}
              <tr><td colspan="4" class="tr">总计应付 TOTAL DUE (CNY equiv):</td><td class="tr">${exr>0?`CNY ${fmtM(totCNY+totUSD*exr)}`:`<span style="color:#c00">汇率缺失 / FX rate required</span>`}</td></tr>
            </tfoot>
          </table>
          <div class="details-grid">
            <div style="border:none;padding:0">
              <h4 style="border-bottom:1px solid #000;padding-bottom:5px;text-decoration:none;font-size:11px;text-transform:uppercase">备注 / REMARKS</h4>
              <p style="color:#555;margin-top:5px;font-size:10.5px">请在收到账单后 7 个工作日内安排付款。如有疑问，请及时联系我司财务部。<br>Please arrange payment within 7 working days upon receipt of this debit note.</p>
            </div>
            <div class="details-box">
              <h4>汇款账户 Banking Information</h4>
              <div style="font-size:10.5px;line-height:1.9">
                受益人: ${esc(cfg3.bank.beneficiary)}<br>
                银行: ${esc(cfg3.bank.bankName)}<br>
                SWIFT: ${esc(cfg3.bank.swift)}<br>
                账号 USD: ${esc(cfg3.bank.usdAccount)}<br>
                账号 RMB: ${esc(cfg3.bank.rmbAccount)}<br>
                <span style="color:red;font-size:9.5px;font-weight:700">* 汇款时请备注账单号 DB No. / Please remark DB No. when remitting.</span>
              </div>
            </div>
          </div>
          <div class="sig-row">
            <div class="sig-b"><span>CLIENT CONFIRMATION</span><span class="sig-note">(客户确认签署 / 盖章)</span></div>
            <div class="sig-b"><span>AUTHORIZED SIGNATURE</span><span class="sig-note">(开票方授权签署 / 盖章)</span></div>
          </div>
          <div class="footer-slogan">⚡ Generated &amp; Verified by <b>Sanlyn OS Supply Chain Engine</b></div>
        </div></body></html>`;
      
  return html;
}
