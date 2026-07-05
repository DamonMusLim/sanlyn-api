export async function renderCpo(ctx){
  let { pool, raw, ordNo, cno, curr, cfg, cust, caddr, ctel, date, pol, pod, inco, prods, tot, html, _xlsCapture, totRow, audience, ap, esc, pick, fmtM, wrap, docHdr, buyerBlock, portBar, productRows, sigBlock, loadDocColConfig, buildColsFromConfig, resolveUnitPrice, mkTotRow } = ctx;

        var noCPO=cno.split(" / ").map(function(c){return c.replace(/[^A-Z0-9-]/gi,"").slice(0,20);}).join(" / ");
        var _fsCPO=(raw.fs_no||raw.internal_no||(ordNo||noCPO))+"-CPO";
        var _cpoNameFn=function(p){var n=pick(p.productName,p.name,p.description,"-");var sz=p.size||p.spec||"";return sz?n+" ("+sz+")":n;};
        var _cpoFnMap={
          sku:{fn:function(p){return p.sku||p.code||p.item_code||p.product_code||"-";},defaultAlign:"center",defaultWidth:"70px"},
          name:{fn:_cpoNameFn,defaultAlign:""},
          qty:{defaultAlign:"center",defaultWidth:"70px"},
          unit:{fn:function(p){return p.unit||p.unitOfMeasure||"CTN";},defaultAlign:"center",defaultWidth:"50px"},
          price:{fn:function(p){return fmtM(resolveUnitPrice(p));},defaultAlign:"right",defaultWidth:"95px"},
          amt:{fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},defaultAlign:"right",defaultWidth:"110px"},
        };
        var _fbColsCPO=[
          {k:"name",al:"",fn:_cpoNameFn,lbl:"Description &amp; Size"},
          {k:"qty",al:"center",w:"70px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:_cpoFnMap.price.fn,lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"110px",fn:_cpoFnMap.amt.fn,lbl:"Amount ("+curr+")"},
        ];
        var colsCPO=buildColsFromConfig(await loadDocColConfig(pool,"cpo"),_cpoFnMap,_fbColsCPO);
        var _ncpo=colsCPO.length+1, _lcpo=Math.max(1,_ncpo-1);
        totRow=mkTotRow(_ncpo);
        // Payment schedule: 30% deposit + 70% balance (standard terms)
        var _cpoDeposit=tot*0.30, _cpoBalance=tot*0.70;
        // Payment condition text from terms_po[2] (Payment Terms entry), Chinese part only
        var _cpoPayTerms=(cfg.termsPO||[]).find(function(t){return (t.heading||"").indexOf("付款")>=0||(t.heading||"").toLowerCase().indexOf("payment")>=0;});
        var _cpoPayCN=_cpoPayTerms?((_cpoPayTerms.body||"").split("\n")[0]):"";
        // Seller info block (Sanlyn side)
        var _cpoSellerBlock=`<div class="meta-grid" style="margin-top:0;border-top:none">
          <div></div>
          <div><div class="section-label">SELLER (SOLD BY)</div>
            <p style="font-size:12px;font-weight:bold;margin:0">${esc(cfg.nameEN)}</p>
            <p style="margin:4px 0;font-size:10px;color:#555">${esc(cfg.address)}</p>
            ${cfg.tel?`<p style="margin:2px 0;font-size:10px;color:#555">Tel: ${esc(cfg.tel)}</p>`:""}
          </div></div>`;
        html=wrap(noCPO+"_CPO",`
          ${docHdr(cfg,"","PURCHASE ORDER",audience)}
          ${buyerBlock(cust,caddr,ctel,_fsCPO,"PO No.",ordNo,date,curr)}
          ${_cpoSellerBlock}
          ${portBar(pol,pod,inco)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsCPO.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsCPO,curr)}${totRow}
          <tr><td colspan="${_ncpo}" style="padding:0;border:none"></td></tr>
          <tr style="background:#fafafa">
            <td colspan="${_lcpo}" class="text-right" style="font-size:10px;color:#555">T/T 30% Deposit — upon order confirmation:</td>
            <td class="text-right" style="font-weight:700">${fmtM(_cpoDeposit)}</td>
          </tr>
          <tr style="background:#fafafa">
            <td colspan="${_lcpo}" class="text-right" style="font-size:10px;color:#555">T/T 70% Balance — before loading date:</td>
            <td class="text-right" style="font-weight:700">${fmtM(_cpoBalance)}</td>
          </tr>
          ${_cpoPayCN?`<tr><td colspan="${_ncpo}" style="font-size:10px;color:#777;padding:6px 8px;border-top:1px dashed #ddd">${esc(_cpoPayCN)}</td></tr>`:""}
          </tbody></table>
          ${sigBlock(cfg.seal_url)}
        `,ap,{docNo:_fsCPO,date:date});
      
  return { html, _xlsCapture, totRow };
}
