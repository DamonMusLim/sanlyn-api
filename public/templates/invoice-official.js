(function(){
  const STYLE_ID="invoice-official-style";
  const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
  const num=v=>Number.isFinite(Number(String(v??"").replace(/,/g,"")))?Number(String(v).replace(/,/g,"")):0;
  const money=n=>num(n).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2});
  const qty=n=>num(n).toLocaleString("zh-CN",{maximumFractionDigits:3});
  const rate=n=>num(n)>0?`${(num(n)*100).toLocaleString("zh-CN",{maximumFractionDigits:2})}%`:"免税";
  const currency=c=>c==="USD"?"$":"¥";
  const upperMoney=n=>{
    let s=(Math.round(num(n)*100)/100).toFixed(2),[i,d]=s.split("."),u="零壹贰叁肆伍陆柒捌玖",a=["","拾","佰","仟"],b=["","万","亿"],out="";
    if(i==="0")out="零";else{let g=[];while(i){g.unshift(i.slice(-4));i=i.slice(0,-4)}g.forEach((x,gi)=>{let p="",z=false;x.padStart(4,"0").split("").forEach((c,ci)=>{let n=Number(c),pos=3-ci;if(n){if(z){p+="零";z=false}p+=u[n]+a[pos]}else if(p)z=true});if(p)out+=p+b[g.length-1-gi]})}
    const j=Number(d[0]),f=Number(d[1]);return out+"元"+(j?u[j]+"角":"")+(f?u[f]+"分":j?"":"整");
  };
  function ensureStyle(){
    if(document.getElementById(STYLE_ID))return;
    const css=`.invoiceOfficial{position:relative;border:2px solid #b91c1c;padding:16px 16px 14px;color:#621313;background:#fffdfb;margin-top:10px}
.invoiceOfficial+.invoiceOfficial{margin-top:12px}.ioTitle{text-align:center;font-size:26px;font-weight:800;color:#b91c1c;letter-spacing:0;margin:2px 0 12px}
.ioTop{display:grid;grid-template-columns:1fr 230px;gap:12px;align-items:start;margin-bottom:10px}
.ioSeal{justify-self:center;width:118px;height:58px;border:2px solid rgba(185,28,28,.35);border-radius:50%;display:flex;align-items:center;justify-content:center;color:rgba(185,28,28,.42);font-size:14px;font-weight:800;transform:rotate(-8deg);margin-top:8px;text-align:center;line-height:1.25}
.ioMeta{display:grid;gap:8px;color:#7f1d1d;font-size:13px;line-height:1.45}.ioMetaLine{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #f3caca;padding-bottom:4px}.ioPh{color:#9ca3af}
.ioInput{font:inherit;color:#621313;background:#fff;border:1px solid #f0c2c2;border-radius:4px;padding:2px 6px;min-width:0;max-width:150px;text-align:right}
.ioPartyWrap{display:grid;grid-template-columns:1fr 1fr;border:1px solid #efb5b5;border-bottom:0}.ioParty{display:grid;grid-template-columns:34px 1fr;min-height:92px}.ioParty+.ioParty{border-left:1px solid #efb5b5}
.ioPLabel{display:flex;align-items:center;justify-content:center;border-right:1px solid #efb5b5;color:#9f1239;font-weight:800;writing-mode:vertical-rl;letter-spacing:2px}.ioPGrid{display:grid;gap:8px;padding:10px 12px}
.ioField{font-size:13px;line-height:1.45}.ioField b{font-weight:700;color:#4b1111}.ioTableBox{overflow:auto;border-left:1px solid #efb5b5;border-right:1px solid #efb5b5}
.ioTable{width:100%;border-collapse:collapse;min-width:0;table-layout:fixed}.ioTable th,.ioTable td{border-bottom:1px solid #efb5b5;border-right:1px solid #f3caca;padding:6px 5px;font-size:12px;text-align:left;vertical-align:middle;word-break:break-word}
.ioTable th:last-child,.ioTable td:last-child{border-right:0}.ioTable th{color:#9f1239;background:#fff7f7;text-align:center;font-weight:800}.ioNum{text-align:right;font-variant-numeric:tabular-nums}.ioCenter{text-align:center}
.ioNameCol{width:24%}.ioSpecCol{width:13%}.ioUnitCol{width:8%}.ioQtyCol{width:10%}.ioPriceCol,.ioAmountCol,.ioTaxCol{width:12%}.ioRateCol{width:9%}.ioSumLabel{text-align:center;font-weight:800;color:#9f1239;background:#fffdfb}
.ioGrand{display:grid;grid-template-columns:1fr 260px;border:1px solid #efb5b5;border-top:0;font-size:15px}.ioGrand>div{padding:10px 12px}.ioGrandSmall{border-left:1px solid #efb5b5}.ioMoney{font-size:20px;font-weight:900;color:#991b1b}
.ioRemark{display:grid;grid-template-columns:54px 1fr;border:1px solid #efb5b5;border-top:0;min-height:58px}.ioRemarkLabel{display:flex;align-items:center;justify-content:center;border-right:1px solid #efb5b5;color:#9f1239;font-weight:800}.ioRemarkBody{padding:9px 12px;font-size:12px;color:#6b7280}
.ioIssuer{display:flex;justify-content:flex-end;border:1px solid #efb5b5;border-top:0;padding:9px 12px;color:#621313}.ioEdit{border-bottom:1px dashed #0d7d74;cursor:text;padding:0 2px;color:#621313;background:transparent;min-width:18px;display:inline-block}
.ioSelect{font:inherit;font-weight:800;color:#b91c1c;border:1px solid #f0c2c2;border-radius:5px;padding:2px 6px;background:#fff7f7}.ioHint{font-size:10px;color:#0d7d74;font-weight:700;margin-left:4px}
.ioFooter{margin-top:12px;color:#18212f}.ioFooter .btn{color:inherit}
@media(max-width:760px){.ioTop{grid-template-columns:1fr}.ioSeal{display:none}.ioMeta{grid-column:1/3}.ioPartyWrap{grid-template-columns:1fr}.ioParty+.ioParty{border-left:0;border-top:1px solid #efb5b5}.ioGrand{grid-template-columns:1fr}.ioGrandSmall{border-left:0;border-top:1px solid #efb5b5}}`;
    const el=document.createElement("style");el.id=STYLE_ID;el.textContent=css;document.head.appendChild(el);
  }
  function editable(value,path,editable){
    return editable?`<span class="ioEdit" contenteditable="true" data-io-field="${esc(path)}">${esc(value||"")}</span><span class="ioHint">可改</span>`:`<span>${esc(value||"—")}</span>`;
  }
  function metaField(meta,key,placeholder,editable,type){
    const v=meta&&meta[key];
    return editable?`<input class="ioInput" ${type?`type="${esc(type)}"`:""} value="${esc(v||"")}" placeholder="${esc(placeholder)}" data-io-field="meta.${esc(key)}">`:`<span class="ioPh">${esc(v||placeholder)}</span>`;
  }
  function party(label,p,path,canEdit){
    return `<div class="ioParty"><div class="ioPLabel">${label}</div><div class="ioPGrid">
      <div class="ioField"><b>名称：</b>${editable(p.name,`${path}.name`,canEdit)}</div>
      <div class="ioField"><b>统一社会信用代码/纳税人识别号：</b>${editable(p.tax_id,`${path}.tax_id`,canEdit)}</div>
    </div></div>`;
  }
  function render(d){
    ensureStyle();
    const cur=d.currency||"CNY", items=Array.isArray(d.items)?d.items:[], canEdit=d.editable!==false;
    const meta=d.meta||{}, editableMeta=!!meta.editable_meta, sellerEditable=d.seller_editable===true&&canEdit;
    const buyerEditable=d.buyer_editable===true?true:canEdit; // 买方抬头可独立于发票行可编辑(我方代开时行只读但抬头仍可订正)
    const rows=items.map((it,i)=>`<tr>
      <td>${editable(it.name||"",`items.${i}.name`,canEdit)}</td><td>${editable(it.spec||"",`items.${i}.spec`,canEdit)}</td><td class="ioCenter">${editable(it.unit||"",`items.${i}.unit`,canEdit)}</td>
      <td class="ioNum">${editable(qty(it.qty||1),`items.${i}.qty`,canEdit)}</td><td class="ioNum">${editable(money(it.price),`items.${i}.price`,canEdit)}</td>
      <td class="ioNum">${currency(cur)}${editable(money(it.amount),`items.${i}.amount`,canEdit)}</td><td class="ioNum">${editable(rate(it.rate),`items.${i}.rate`,canEdit)}</td><td class="ioNum">${currency(cur)}${money(it.tax)}</td>
    </tr>`).join("");
    const title=d.title||"普通发票";
    const titleHtml=canEdit?`<select class="ioSelect" data-io-field="title"><option value="普通发票" ${title==="普通发票"?"selected":""}>普通发票</option><option value="专用发票" ${title==="专用发票"?"selected":""}>专用发票</option><option value="增值税普通发票" ${title==="增值税普通发票"?"selected":""}>增值税普通发票</option><option value="增值税专用发票" ${title==="增值税专用发票"?"selected":""}>增值税专用发票</option></select>`:esc(title);
    const docTitle=d.docTitle||"电子发票";
    return `<div class="invoiceOfficial" data-io-index="${esc(d.index??0)}">
      <div class="ioTitle">${esc(docTitle)}（${titleHtml}）</div>
      <div class="ioTop"><div class="ioSeal">国家税务总局<br>监制</div><div class="ioMeta"><div class="ioMetaLine"><span>发票号码：</span>${metaField(meta,"invoice_no","开票时生成",editableMeta)}</div><div class="ioMetaLine"><span>开票日期：</span>${metaField(meta,"issue_date","开票时生成",editableMeta,"date")}</div></div></div>
      <div class="ioPartyWrap">${party("购买方信息",d.buyer||{},"buyer",buyerEditable)}${party("销售方信息",d.seller||{},"seller",sellerEditable)}</div>
      <div class="ioTableBox"><table class="ioTable"><thead><tr><th class="ioNameCol">项目名称</th><th class="ioSpecCol">规格型号</th><th class="ioUnitCol">单位</th><th class="ioQtyCol">数量</th><th class="ioPriceCol">单价</th><th class="ioAmountCol">金额</th><th class="ioRateCol">税率/征收率</th><th class="ioTaxCol">税额</th></tr></thead><tbody>${rows||'<tr><td colspan="8" class="ioCenter">费用尚未录入</td></tr>'}</tbody><tfoot><tr><td colspan="5" class="ioSumLabel">合计</td><td class="ioNum">${currency(cur)}${money(d.total_ex)}</td><td></td><td class="ioNum">${currency(cur)}${money(d.total_tax)}</td></tr></tfoot></table></div>
      <div class="ioGrand"><div><b>价税合计（大写）</b> <span>${upperMoney(d.total)}</span></div><div class="ioGrandSmall"><b>（小写）</b> <span class="ioMoney">${currency(cur)}${money(d.total)}</span></div></div>
      <div class="ioRemark"><div class="ioRemarkLabel">备注</div><div class="ioRemarkBody">${editable(d.remark||"", "remark", canEdit)||'<span class="ioPh">无</span>'}</div></div>
      <div class="ioIssuer">开票人：${metaField(meta,"issuer","开票时填写",editableMeta)}</div>
      ${d.footerHtml?`<div class="ioFooter">${d.footerHtml}</div>`:""}
    </div>`;
  }
  window.InvoiceOfficial={render,upperMoney};
})();
