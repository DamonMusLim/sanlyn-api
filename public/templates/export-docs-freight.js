(function(){
  var page=String(qp('page')||'').toLowerCase();
  if(page!=='freight'&&page!=='portcharge')return;
  var state=null,oldSealTargets=window.sealTargets;
  window.sealTargets=function(t){
    if(!/^all:/.test(t))return oldSealTargets?oldSealTargets(t):[t];
    var side=t.split(':')[1];
    return ['freight:'+side];
  };
  function money(n,d){return (Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:d==null?2:d,maximumFractionDigits:d==null?2:d});}
  function date(v){return v?String(v).slice(0,10):'—';}
  function h(s){return esc(s==null?'':s);}
  function sid(){return qp('shipment_id')||qp('id')||'';}
  function pdfUrl(){
    var d=state&&state.data,type=d&&d.pdf_type||'fob_invoice';
    return '/api/db/shipping-plan-pdf?type='+encodeURIComponent(type)+'&id='+encodeURIComponent(sid())+'&format=pdf&token='+encodeURIComponent(tok());
  }
  function injectStyle(){
    var s=document.createElement('style');s.textContent='.freight-doc{background:#fff;max-width:200mm;margin:0 auto 22px;padding:11mm 13mm;box-shadow:0 4px 18px rgba(0,0,0,.12);min-height:920px}.freight-doc .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:14px}.freight-doc .co-en{font-size:15px;font-weight:900}.freight-doc .co-cn{font-size:10px;color:#555;margin-top:3px}.freight-doc .tag{font-size:8.5px;color:#888;margin-top:4px}.freight-doc .doc-en{font-size:18px;font-weight:900;letter-spacing:.05em;text-align:right}.freight-doc .doc-cn{font-size:10px;color:#555;text-align:right}.freight-doc .inv-no{display:inline-block;font-size:11px;font-weight:800;font-family:monospace;border:2px solid #111;border-radius:3px;padding:2px 9px;margin-top:4px}.freight-doc .info-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:0 12px;margin-bottom:12px;border:1px solid #e0e0e0;border-radius:4px;overflow:hidden}.freight-doc .info-box{font-size:10px}.freight-doc .row{display:grid;grid-template-columns:118px 1fr;border-bottom:1px solid #efefef;min-height:22px}.freight-doc .row:last-child{border-bottom:none}.freight-doc .lbl{background:#f7f7f7;color:#666;font-weight:700;padding:4px 8px;border-right:1px solid #efefef;display:flex;align-items:center}.freight-doc .val{font-weight:600;padding:4px 8px;display:flex;align-items:center}.freight-doc .big{font-size:12px;font-weight:900;display:block!important}.freight-doc .ctn-box{margin-bottom:12px;border:1px solid #ddd;border-radius:4px;overflow:hidden;font-size:10px}.freight-doc .ctn-title{background:#111;color:#fff;font-weight:800;font-size:9.5px;letter-spacing:.05em;padding:6px 10px;display:flex;justify-content:space-between}.freight-doc table{width:100%;border-collapse:collapse;margin:0;font-size:10px}.freight-doc th{background:#111;color:#fff;padding:7px 9px;text-align:left;font-weight:700;font-size:9.5px}.freight-doc td{padding:7px 9px;border-bottom:1px solid #efefef;font-family:monospace}.freight-doc .c{text-align:center}.freight-doc .r{text-align:right}.freight-doc .section td{background:#333;color:#fff;font-weight:800;letter-spacing:.05em}.freight-doc tfoot td{font-weight:800;background:#f7f7f7;border-top:2px solid #111}.freight-doc .fx-note{text-align:right;font-size:8.5px;color:#666;margin:6px 0 10px;font-style:italic}.freight-doc .pay-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}.freight-doc .pay-box{padding:12px 14px;border-radius:4px;border:2px solid #111;background:#f7f7f7}.freight-doc .pay-box.cny{background:#efefef}.freight-doc .plbl{font-size:8.5px;font-weight:900;letter-spacing:.07em}.freight-doc .pamt{font-size:20px;font-weight:900;font-family:monospace}.freight-doc .psub{font-size:8px;color:#666;margin-top:3px}.freight-doc .bottom{display:grid;grid-template-columns:1.05fr 1fr;gap:10px}.freight-doc .box{padding:9px 11px;background:#f9f9f9;border:1px solid #ddd;border-radius:4px;font-size:9px;line-height:1.8;color:#444}.freight-doc .box-title{font-size:9.5px;font-weight:900;border-bottom:1px solid #ddd;padding-bottom:3px;margin-bottom:4px}.freight-doc .seal-wrap{top:-26px}.freight-doc .warn-card{background:#fff3cd;border:2px solid #c00;border-radius:4px;padding:8px 12px;margin-bottom:12px;font-size:11px;font-weight:800;color:#c00}@media print{.freight-doc{box-shadow:none;margin:0;padding:6mm 10mm;max-width:100%;min-height:unset}.freight-doc th,.freight-doc .section td,.freight-doc .ctn-title{-webkit-print-color-adjust:exact;print-color-adjust:exact}}';
    document.head.appendChild(s);
  }
  function party(d){
    if(page==='portcharge'){
      var f=d.factory||{};
      return {label:'TO (付款方):',name:f.name_cn||'',addr:f.address||'地址 Address: _______________________________'};
    }
    var c=d.customer||{};
    return {label:'TO (客户名称):',name:c.name_en||c.name_cn||'',addr:c.address||'地址 Address: _______________________________'};
  }
  function containerHtml(c){
    var rows=(c.rows||[]).map(function(r,i){return '<tr><td>Container '+(i+1)+'</td><td>'+h(r.no)+'</td><td>'+h(r.seal)+'</td><td>'+h(r.po)+'</td><td class="r">'+(r.ctn?money(r.ctn,0):'—')+'</td><td class="r">'+(r.gw?money(r.gw)+' KGS':'—')+'</td><td class="r">'+(r.cbm?money(r.cbm,3)+' CBM':'—')+'</td></tr>';}).join('');
    return '<div class="ctn-box"><div class="ctn-title"><span>Containers / 集装箱明细 ('+h(c.qty)+' × '+h(c.type)+')</span><span>Freight Term: '+h(c.freight_term)+'</span></div><table><thead><tr><th>Container #</th><th>Container No.</th><th>Seal No.</th><th>PO / 合同号</th><th class="r">CTN</th><th class="r">Gross Weight</th><th class="r">Volume</th></tr></thead><tbody>'+rows+'</tbody><tfoot><tr><td>'+h(c.qty)+' × '+h(c.type)+'</td><td colspan="3"></td><td class="r">'+(c.totals.cartons?money(c.totals.cartons,0):'—')+'</td><td class="r">'+(c.totals.gw?money(c.totals.gw)+' KGS':'—')+'</td><td class="r">'+(c.totals.cbm?money(c.totals.cbm,3)+' CBM':'—')+'</td></tr></tfoot></table></div>';
  }
  function chargeHtml(d){
    var title=page==='portcharge'?'Port Charges | 港杂费':'Ocean Freight | 海运费';
    var rows=(d.charges||[]).map(function(r){return '<tr><td>'+h(r.cost_category||'')+'</td><td>'+h(r.charge_basis||'整票')+'</td><td class="c">'+h(r.currency||'CNY')+'</td><td class="c">'+money(r.qty==null?1:r.qty,0)+'</td><td class="r">'+money(r.unit_price==null?r.amount:r.unit_price)+'</td><td class="r">'+money(r.amount)+'</td></tr>';}).join('');
    var foot=page==='portcharge'?'<tr><td colspan="5" class="r">TOTAL CNY (人民币合计)</td><td class="r">¥ '+money(d.totals.cny)+'</td></tr>':'<tr><td colspan="5" class="r">TOTAL USD (美元合计)</td><td class="r">$ '+money(d.totals.usd)+'</td></tr>';
    return '<table class="charges"><thead><tr><th>Charge Item (费用明细)</th><th>Charge Unit / 计费单位</th><th class="c">Currency / 币种</th><th class="c">Qty / 数量</th><th class="r">Price / 单价</th><th class="r">Amount / 合计</th></tr></thead><tbody><tr class="section"><td colspan="6">'+title+'</td></tr>'+rows+'</tbody><tfoot>'+foot+'</tfoot></table>';
  }
  function payHtml(d){
    if(page==='portcharge')return '<div class="fx-note">* Port charges are payable in CNY only. / 港杂费仅按人民币支付。</div><div class="pay-grid"><div class="pay-box cny" style="grid-column:1/-1"><div class="plbl">TOTAL PAYABLE IN CNY · 人民币应付合计</div><div class="pamt">¥ '+money(d.totals.cny)+'</div><div class="psub">Port charges only · Remit to CNY A/C below</div></div></div>';
    return '<div class="fx-note">* Please remit the full amount in ONE of the following currencies. / 请选择以下一种币种全额支付。</div><div class="fx-note">开票日期汇率 Invoice Date Rate (<strong>'+h(d.shipment.gen_date)+'</strong>): <strong>1 USD = '+money(d.totals.fx_rate,4)+' CNY</strong></div><div class="pay-grid"><div class="pay-box"><div class="plbl">TOTAL PAYABLE IN USD · 如全用美元支付</div><div class="pamt">$ '+money(d.totals.usd)+'</div><div class="psub">Ocean freight only · Remit to USD A/C below</div></div><div class="pay-box cny"><div class="plbl">TOTAL PAYABLE IN CNY · 如全用人民币支付</div><div class="pamt">¥ '+money(d.totals.cny)+'</div><div class="psub">USD '+money(d.totals.usd)+' × '+money(d.totals.fx_rate,4)+' = ¥ '+money(d.totals.cny)+'</div></div></div>';
  }
  function render(d){
    var p=party(d),s=d.shipment,docCn=page==='portcharge'?'港杂费账单':'运费发票';
    document.title=(page==='portcharge'?'Port Charge Statement':'Freight Invoice')+' · '+(s.shipment_no||s.bl_no||sid());
    window._docBaseName=(page==='portcharge'?'PC-':'FI-')+(s.shipment_no||s.bl_no||sid());
    var warn='';  // 2026-07-18 Damon: 正式账单不显示估算警示(报价表才显示);取数已改为 真实账单→计划费用字段→参考卡
    return '<div class="freight-doc" id="freightPage"><div class="hdr"><div><div class="co-en">SHANGHAI OCEAN BABY INT\'L LOGISTICS CO., LTD.</div><div class="co-cn">上海洋宝宝国际物流有限公司</div><div class="tag">Ocean Freight · Air Freight · Express · Integrated Logistics Solutions</div></div><div><div class="doc-en">INVOICE</div><div class="doc-cn">'+docCn+'</div><div class="inv-no">No. '+h(d.doc_no)+'</div></div></div>'+warn+'<div class="info-grid"><div class="info-box"><div class="row"><div class="lbl">'+p.label+'</div><div class="val big">'+h(p.name)+'<div style="font-size:9px;font-weight:400;color:#555;margin-top:2px">'+h(p.addr)+'</div></div></div><div class="row"><div class="lbl">SHPT MODE:</div><div class="val">Sea Export</div></div><div class="row"><div class="lbl">INV/BL NO.:</div><div class="val">'+h(s.bl_no)+'</div></div><div class="row"><div class="lbl">DATE (出单日期):</div><div class="val">'+h(s.gen_date)+'</div></div></div><div class="info-box"><div class="row"><div class="lbl">Vessel/Voyage (船名航次):</div><div class="val">'+h(s.vessel)+'</div></div><div class="row"><div class="lbl">ETD (离港日):</div><div class="val">'+h(date(s.etd))+'</div></div><div class="row"><div class="lbl">P.O.L (起运港):</div><div class="val">'+h(s.pol)+'</div></div><div class="row"><div class="lbl">P.O.D (目的港):</div><div class="val">'+h(s.pod)+'</div></div></div></div>'+containerHtml(d.containers)+chargeHtml(d)+payHtml(d)+'<div class="bottom"><div class="box"><div class="box-title">TERMS &amp; CONDITIONS (法律声明与条款)</div>1. PAYMENT DUE: Please arrange payment strictly within the agreed credit term. Late payment may result in delayed release of the Bill of Lading or cargo.<br>2. EXCHANGE RATE: For USD charges settled in RMB, the exchange rate shall be subject to our company\'s notification.<br>3. LIABILITY: All business is transacted under our Standard Trading Conditions.</div><div class="box"><div class="box-title">BANKING INFORMATION (银行信息)</div>Bank Name: <strong>BANK OF CHINA XIAMEN BRANCH</strong><br>Account Name: <strong>SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.</strong><br>Swift Code: <strong>BKCHCNBJ73A</strong><br>Bank Addr: No. 40 North Hubin Road, Xiamen<br>USD Account (美金账号): <strong>433849630299</strong><br>CNY Account (人民币账号): <strong>433849860868</strong><br><span style="color:#c00;font-size:8px">* Please check the account number carefully before remittance.</span></div></div><div class="sigs"><div class="sig"><div class="sig-t">BUYER AUTHORIZED SIGNATURE<span class="seal-wrap" id="freight-buyer-seal-area" ondragover="event.preventDefault()" ondrop="dropSeal(event,\'freight:buyer\')"><img id="freight-buyer-seal"></span><span class="seal-hint" id="freight-buyer-seal-hint" onclick="openSealPicker(\'freight:buyer\')">click seal</span></div><div class="sig-sub">(Signature / Company Seal)</div></div><div class="sig"><div class="sig-t">SELLER AUTHORIZED SIGNATURE<span class="seal-wrap" id="freight-seller-seal-area" ondragover="event.preventDefault()" ondrop="dropSeal(event,\'freight:seller\')"><img id="freight-seller-seal"></span><span class="seal-hint" id="freight-seller-seal-hint" onclick="openSealPicker(\'freight:seller\')">click seal</span></div><div class="sig-sub">(Signature / Company Seal)</div></div></div></div>';
  }
  window._docUrl=function(fmt){return fmt==='pdf'?pdfUrl():location.href;};
  window.dlDoc=function(fmt){if(fmt==='xlsx')return downloadXlsx();window.open(pdfUrl(),'_blank');};
  window.toggleLang=function(){banner('info','Freight documents are bilingual by default.');setTimeout(function(){banner('','');},1600);};
  window.saveDraft=function(){try{localStorage.setItem('export_docs_draft_'+page+'_'+sid(),document.getElementById('freightRoot').innerHTML);banner('info','✓ 草稿已保存');setTimeout(function(){banner('','');},1500);}catch(e){}};
  window.downloadPng=function(){
    var btn=document.querySelector('.btn-dl');btn.textContent='⏳…';btn.disabled=true;document.querySelector('.toolbar').style.display='none';
    var done=function(){document.querySelector('.toolbar').style.display='';btn.textContent='📥 下载图片';btn.disabled=false;};
    var go=function(){html2canvas(document.getElementById('freightPage'),{scale:2,useCORS:true,backgroundColor:'#fff'}).then(function(c){var a=document.createElement('a');a.download=docBaseName()+'.png';a.href=c.toDataURL('image/png');a.click();done();}).catch(done);};
    if(window.html2canvas)go();else{var s=document.createElement('script');s.src=API+'/templates/vendor/html2canvas.min.js';s.onload=go;document.head.appendChild(s);}
  };
  function downloadXlsx(){
    var d=state&&state.data;if(!d)return;
    var go=function(){
      var wb=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet((d.charges||[]).map(function(r){return {Item:r.cost_category,Basis:r.charge_basis,Currency:r.currency,Qty:r.qty,UnitPrice:r.unit_price,Amount:r.amount};})),'Charges');
      XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet((d.containers.rows||[]).map(function(r,i){return {No:i+1,ContainerNo:r.no,SealNo:r.seal,PO:r.po,CTN:r.ctn,GrossWeight:r.gw,CBM:r.cbm};})),'Containers');
      XLSX.writeFile(wb,docBaseName()+'.xlsx');
    };
    if(window.XLSX)return go();
    var s=document.createElement('script');s.src=API+'/templates/vendor/xlsx.full.min.js';s.onload=go;document.head.appendChild(s);
  }
  window.initFreightDocs=function(){
    injectStyle();
    ['pagePL','pageSC','pageIV'].forEach(function(id){var e=document.getElementById(id);if(e)e.style.display='none';});
    var bm=document.getElementById('btnMode');if(bm)bm.style.display='none';
    var bl=document.getElementById('btnLang');if(bl)bl.textContent='🌐 Bilingual';
    document.getElementById('orderLabel').textContent=sid();
    var root=document.createElement('div');root.id='freightRoot';document.getElementById('sealModal').before(root);
    banner('info','正在拉取海运单据数据…');
    fetch(API+'/api/db/shipping-plan-doc-data?id='+encodeURIComponent(sid())+'&page='+encodeURIComponent(page),{headers:authH()}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j;});}).then(function(j){state=j;root.innerHTML=render(j.data);banner('','');}).catch(function(e){banner('err',e.message);});
  };
  window.initFreightDocs();
})();
