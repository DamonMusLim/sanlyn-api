(function(){
  const API="/api/db/invoice-collab-confirm";
  const token=new URLSearchParams(location.search).get("token")||"";
  const app=document.getElementById("app");
  const CNTR_TYPES=["20GP","40GP","40HC","40HQ","45HQ","20ST","20RF","40RF"];
  let state=null, dirtyPrice=false, contactOpen=false, invoiceOpen=false, sheetOpen=false, _lang="zh";
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const num=v=>Number.isFinite(Number(String(v).replace(/,/g,"")))?Number(String(v).replace(/,/g,"")):0;
  const round=v=>Math.round(num(v)*100)/100;
  const money=v=>num(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  const sym=c=>c==="USD"?"$":"¥";
  const isPer=b=>String(b||"").includes("每柜");
  const totalLines=()=>Array.isArray(state.bill_lines)?state.bill_lines.reduce((s,l)=>s+num(l.amount),0):0;
  const isConfirmed=()=>state?.status==="external_confirmed"||Boolean(state?.confirmed_at);
  const fmtTime=v=>v?new Date(v).toLocaleString("zh-CN",{hour12:false}):"";
  const docTitle=()=>{
    if(state.line_side==="receivable") return "港杂费账单";
    if(state.line_side==="payable"&&state.shipment?.billing_segment==="ocean") return "海运费账单";
    return state.line_side==="payable"?"供应商费用账单":"费用账单";
  };
  const recalcInvoice=()=>{
    if(!Array.isArray(state.invoices)) return;
    state.invoices.forEach(inv=>{
      const ex=round(inv.amount_ex_tax), rate=num(inv.tax_rate);
      inv.amount_ex_tax=ex; inv.tax_amount=rate>0?round(ex*rate):0; inv.total_with_tax=round(ex+inv.tax_amount);
    });
  };
  function cntrTypes(){ const s=new Set(CNTR_TYPES); (state.shipment.containers||[]).forEach(c=>c.type&&s.add(c.type)); return [...s]; }
  function primaryType(){ return (state.shipment.containers||[]).find(c=>c.type)?.type || cntrTypes()[0] || "40HC"; }
  function cntrSummary(){ return (state.shipment.containers||[]).filter(c=>c.type&&num(c.count)).map(c=>`${num(c.count)}×${c.type}`).join(" + "); }
  function initContainers(){
    const sh=state.shipment;
    if(Array.isArray(sh.containers)&&sh.containers.length) return;
    const cs=[];
    String(sh.container_summary||"").split("+").forEach(seg=>{
      const m=seg.trim().match(/(\d+)\s*[×xX]\s*(\S+)/); if(m) cs.push({type:m[2],count:num(m[1])});
    });
    sh.containers=cs;
  }
  function containerEditor(){
    const cs=state.shipment.containers||[], types=cntrTypes();
    return `<div class="cntr-edit"><span class="ce-lab">柜量</span>
      ${cs.map((c,i)=>`<span class="ce-item"><select class="ce-type" data-cntr="${i}" data-cf="type">${types.map(t=>`<option ${t===c.type?"selected":""}>${esc(t)}</option>`).join("")}</select>×<input class="ce-qty" data-cntr="${i}" data-cf="count" value="${num(c.count)}"><button class="ce-del" data-cntr-del="${i}" title="删除柜型">✕</button></span>`).join("")}
      <button class="ce-add" id="cntrAdd">＋ 加柜型</button></div>`;
  }
  function billRows(){
    const types=cntrTypes();
    return (state.bill_lines||[]).map((l,i)=>{
      const per=isPer(l.basis), ct=l.container_type||primaryType();
      return `<tr>
        <td><input class="edit bl-name" data-bl="${i}" data-f="name" value="${esc(l.name)}" placeholder="费用项"></td>
        <td><select class="bl-sel" data-bl="${i}" data-f="basis"><option ${!per?"selected":""}>整票</option><option ${per?"selected":""}>每柜</option></select></td>
        <td>${per?`<select class="bl-sel" data-bl="${i}" data-f="container_type">${types.map(t=>`<option ${t===ct?"selected":""}>${esc(t)}</option>`).join("")}</select>`:`<span class="faintdash">—</span>`}</td>
        <td class="r"><input class="edit money" data-bl="${i}" data-f="unit_price" value="${money(l.unit_price)}"></td>
        <td class="r">${per?`<input class="edit money" style="width:52px" data-bl="${i}" data-f="qty" value="${money(l.qty).replace(".00","")}">`:`<span>1</span>`}</td>
        <td class="r">${money(l.amount)}</td>
        <td class="r"><button class="bl-del" data-bl-del="${i}" title="删除此行">✕</button></td>
      </tr>`;
    }).join("");
  }
  function settlementToggle(){
    const m=state.settlement_mode||"monthly";
    return `<div class="settle"><span class="mlab">结算方式</span><button class="mopt ${m==="monthly"?"on":""}" data-settle="monthly">月结</button><button class="mopt ${m==="single"?"on":""}" data-settle="single">单票</button></div>`;
  }
  function billSection(currency){
    const has=(state.bill_lines||[]).length;
    const notice=has?"":`<div class="bill-empty">${esc(state.bill_line_notice||"该票暂无港杂账单，可手动加行")}</div>`;
    return `<div class="sec"><div class="sec-t">① 账单明细 — 请核对</div>
      ${containerEditor()}
      ${settlementToggle()}
      <table class="billgrid"><thead><tr><th>费用项</th><th>计费</th><th>柜型</th><th class="r">单价 <span class="edithint">可改</span></th><th class="r">数量</th><th class="r">合计 (${esc(currency)})</th><th></th></tr></thead>
      <tbody>${billRows()}<tr class="foot"><td colspan="5">应付合计 · ${esc(currency)} <span style="font-weight:400;color:var(--faint);font-size:11px">（改单价/增删后自动重算）</span></td><td class="r">${money(totalLines())}</td><td></td></tr></tbody></table>
      ${notice}
      <button class="addline" id="addLine">＋ 加一行</button>
      <div class="note"><i>ⓘ</i><span>金额可议价，<b>改价 / 增删行需我方确认后生效</b>。本确认只保存外部确认草稿，不代表已开票或已付款。</span></div></div>`;
  }
  function invoiceRows(){
    const editable=(state.invoices[0]?.mode||"self")==="other";
    return state.invoices.map((inv,i)=>`<tr>
      <td>${editable?`<input class="edit inv-name" data-inv="${i}" data-if="item_name" value="${esc(inv.item_name)}">`:`<span data-en="Brokerage Agency Service Port Charges">${esc(inv.item_name)}</span>`}</td><td>${esc(inv.unit)}</td><td class="r">${inv.qty}</td>
      <td class="r">${money(inv.amount_ex_tax)}</td><td class="r">${editable?`<input class="edit money" data-inv="${i}" data-if="amount_ex_tax" value="${money(inv.amount_ex_tax)}">`:money(inv.amount_ex_tax)}</td>
      <td class="r">${Number(inv.tax_rate)>0?String(money(inv.tax_rate*100)).replace(".00","")+"%":"免税"}</td><td class="r">${money(inv.tax_amount)}</td>
    </tr>`).join("");
  }
  function applyLang(){
    document.querySelectorAll("[data-en]").forEach(el=>{
      if(!el.hasAttribute("data-zh")) el.setAttribute("data-zh", el.textContent);
      el.textContent=_lang==="en"?el.getAttribute("data-en"):el.getAttribute("data-zh");
    });
    const b=document.getElementById("langBtn");
    if(b) b.textContent=_lang==="en"?"中文":"EN";
  }
  function toggleLang(){ _lang=_lang==="en"?"zh":"en"; applyLang(); }
  function contactSummary(){
    const c=state.contacts||{}, f=(c.finance||[]).filter(Boolean).length;
    return `收起中 · 财务邮箱 ${f?`<b>${f} 个</b>`:`<span class="miss">未填（必填）</span>`} · 操作 ${(c.ops||[]).filter(Boolean).length||"—"} · 业务 ${(c.business||[]).filter(Boolean).length||"—"}`;
  }
  function confirmedSummary(currency){
    return `<button class="collapse-hd confirmed-line" id="sheetToggle"><span>✓ 已确认 · ${sym(currency)}${money(totalLines())} · ${state.settlement_mode==="single"?"单票":"月结"} · ${esc(fmtTime(state.confirmed_at)||"已确认")}</span><span class="chev">展开 ▾</span></button>`;
  }
  function render(){
    recalcInvoice();
    const sp=state.shipment, inv=state.invoices[0], currency=inv.currency||"CNY", cntr=cntrSummary();
    if(isConfirmed()&&!sheetOpen){
      app.innerHTML=`<div class="finance-title">财务 · 开票</div><div class="sec">${confirmedSummary(currency)}</div>`;
      document.getElementById("sheetToggle").onclick=()=>{sheetOpen=true;render()};
      return;
    }
    const sellerEn=state.seller.name_en?`<div>${esc(state.seller.name_en)}</div>`:"";
    app.innerHTML=`<div class="finance-title">财务 · 开票</div><div class="sheet-hd"><div><div class="brand">${sellerEn}
      <div class="cn">${esc(state.seller.name||"")}　致：${esc(state.buyer.name||"")}</div></div></div>
      <div class="docmeta"><div class="doctag">${docTitle()}</div><div class="docno">${esc(sp.shipment_no||sp.bl_no||"")}</div>
      <div class="badge ${state.status==="external_confirmed"?"done":""}">${state.status==="pending_our_review"?"待我方确认":state.status==="external_confirmed"?"已收到确认":"待你确认"}</div></div></div>
      <div class="shipbar"><span>提单号 <b>${esc(sp.bl_no||"—")}</b></span><span>船名航次 <b>${esc([sp.vessel,sp.voyage].filter(Boolean).join(" / ")||"—")}</b></span>
      <span><b>${esc([sp.pol,sp.pod].filter(Boolean).join(" → ")||"—")}</b></span><span>柜量 <b>${esc(cntr||"—")}</b></span></div>
      ${billSection(currency)}
      <div class="sec invoice-sec"><button class="collapse-hd" id="invToggle"><span class="sec-t" style="margin:0">② 开票 <span style="text-transform:none;font-weight:600;color:var(--sub)">点开票展开</span></span><span class="chev">${invoiceOpen?"收起":"展开"} ▾</span></button>
      <div id="invBody" style="${invoiceOpen?"":"display:none"};margin-top:10px"><div class="modebar"><span class="mlab">开票方式</span>
      <button class="mopt ${inv.mode!=="other"?"on":""}" data-mode="self">我方代开</button><button class="mopt ${inv.mode==="other"?"on":""}" data-mode="other">对方自开</button>
      <span class="mtip" id="modeTip">${inv.mode==="other"?"对方自开信息提交后需我方确认":"我方按当前信息开票"}</span><button class="mopt inv-tool" id="langBtn" type="button">EN</button><button class="mopt inv-tool" id="printBtn" type="button">下载PDF/打印</button></div>
      <div class="plaininv" id="invoicePrintArea"><div class="invtop"><div class="pt"><span data-en="e-Invoice">电子发票</span>（<select class="tsel" id="title"><option data-en="VAT Ordinary e-Invoice">增值税普通发票</option><option data-en="VAT Special e-Invoice">增值税专用发票</option></select>）</div></div>
      <div class="pparty"><div class="pp"><div class="plab" data-en="Buyer">购 买 方</div><div class="prow"><b data-en="Name:">名称：</b><input class="edit" id="buyerName" value="${esc(state.buyer.name)}"><span class="edithint">可改</span></div>
      <div class="prow"><b data-en="Unified Social Credit Code / Tax ID:">统一社会信用代码/纳税人识别号：</b><input class="edit" id="buyerTax" value="${esc(state.buyer.tax_id)}"></div><div class="tip">数电票只打印名称 + 税号</div></div>
      <div class="pp"><div class="plab" data-en="Seller">销 售 方</div><div class="prow"><b data-en="Name:">名称：</b>${esc(state.seller.name)}</div><div class="prow"><b data-en="Unified Social Credit Code / Tax ID:">统一社会信用代码/纳税人识别号：</b>${esc(state.seller.tax_id||"—")}</div></div></div>
      <table class="invline"><thead><tr><th data-en="Item">项目名称</th><th data-en="Unit">单位</th><th class="r" data-en="Qty">数量</th><th class="r" data-en="Unit Price">单价</th><th class="r" data-en="Amount Excl. Tax">金额(不含税)</th><th class="r" data-en="Tax Rate">税率/征收率</th><th class="r" data-en="Tax Amount">税额</th></tr></thead><tbody>${invoiceRows()}</tbody>
      <tfoot><tr><td colspan="4"></td><td class="r" data-en="Total Incl. Tax">价税合计</td><td colspan="2" class="r">${sym(currency)} ${money(state.invoices.reduce((s,i)=>s+num(i.total_with_tax),0))}</td></tr></tfoot></table>
      <div class="remarkline"><span data-en="Remarks:">备注：</span>${esc(inv.remark)}</div></div>
      <label class="savedef"><input type="checkbox" id="saveDefault" ${state.save_as_default?"checked":""}> <span>存为该客户默认开票模版，以后固定这样开。</span></label></div></div>
      <div class="sec"><button class="collapse-hd" id="ctToggle"><span class="sec-t" style="margin:0">③ 联系人邮箱 <span style="text-transform:none;font-weight:600;color:var(--sub)">· 财务/操作/业务，各可多个</span></span><span class="chev">${contactOpen?"收起":"展开填写"} ▾</span></button>
      <div class="sumline" style="${contactOpen?"display:none":""}">${contactSummary()}</div><div id="ctBody" style="${contactOpen?"":"display:none"};margin-top:6px">${contactEditor("finance","财务邮箱","必填 ★","发票发这里")}${contactEditor("ops","操作邮箱","","账单/确认通知")}${contactEditor("business","业务邮箱","","报价 / 砍价")}</div></div>
      <div class="actions"><button class="btn ghost" id="msgBtn">有疑问 · 留言给我</button><button class="btn primary" id="submitBtn">确认账单 + 开票信息</button></div>`;
    bind();
  }
  function contactEditor(key,label,req,sub){
    const vals=(state.contacts[key]||[""]).concat([""]).slice(0,5);
    return `<div class="emrole"><div class="emlabel ${key==="finance"?"fin":key==="ops"?"ops":"buy"}">${label} ${req?`<span class="req">${req}</span>`:""}<em>${sub}</em></div>
      <div class="emlist">${vals.map(v=>`<input class="email" data-contact="${key}" value="${esc(v)}" placeholder="${key==="finance"?"name@example.com":"选填"}">`).join("")}</div></div>`;
  }
  function collect(){
    state.buyer.name=document.getElementById("buyerName")?.value.trim()||"";
    state.buyer.tax_id=document.getElementById("buyerTax")?.value.trim()||"";
    state.save_as_default=document.getElementById("saveDefault")?.checked!==false;
    state.contacts={finance:[],ops:[],business:[]};
    document.querySelectorAll("[data-contact]").forEach(el=>{const v=el.value.trim();if(v)state.contacts[el.dataset.contact].push(v)});
    document.querySelectorAll("[data-inv]").forEach(el=>invoiceChanged(Number(el.dataset.inv),el.dataset.if,el.value,false));
  }
  function lineChanged(i,f,val){
    const l=state.bill_lines[i]; if(!l) return;
    if(f==="name") l.name=val;
    else if(f==="basis"){ l.basis=val; if(!isPer(val)){ l.qty=1; l.container_type=""; } else if(!l.container_type) l.container_type=primaryType(); }
    else if(f==="container_type") l.container_type=val;
    else if(f==="unit_price") l.unit_price=num(val);
    else if(f==="qty") l.qty=num(val)||1;
    l.amount=Math.round(num(l.unit_price)*num(l.qty)*100)/100; dirtyPrice=true; render();
  }
  function invoiceChanged(i,f,val,rerender=true){
    const inv=state.invoices[i]; if(!inv) return;
    if(f==="item_name") inv.item_name=val;
    else if(f==="amount_ex_tax") inv.amount_ex_tax=round(val);
    recalcInvoice(); if(rerender) render();
  }
  function setInvoiceMode(mode){
    const m=mode==="other"?"other":"self";
    state.invoices.forEach(inv=>{inv.mode=m}); state.invoice_mode=m; render();
  }
  function bind(){
    document.querySelectorAll("[data-bl]").forEach(el=>el.addEventListener("change",e=>lineChanged(Number(e.target.dataset.bl),e.target.dataset.f,e.target.value)));
    document.querySelectorAll("[data-inv]").forEach(el=>el.addEventListener("change",e=>invoiceChanged(Number(e.target.dataset.inv),e.target.dataset.if,e.target.value)));
    document.querySelectorAll("[data-bl-del]").forEach(b=>b.addEventListener("click",()=>{
      const i=Number(b.dataset.blDel), l=state.bill_lines[i];
      if(!confirm(`确定删除「${l?.name||"这一行"}」吗？删除后需我方确认才生效。`)) return;
      state.bill_lines.splice(i,1); dirtyPrice=true; render();
    }));
    document.getElementById("addLine").onclick=()=>{
      const cur=state.invoices[0]?.currency||"CNY";
      state.bill_lines.push({bl_no:state.shipment.bl_no||"",name:"",basis:"每柜",container_type:primaryType(),unit_price:0,qty:1,amount:0,currency:cur});
      dirtyPrice=true; render();
    };
    document.querySelectorAll("[data-cntr]").forEach(el=>el.addEventListener("change",e=>{
      const c=state.shipment.containers[Number(e.target.dataset.cntr)]; if(!c) return;
      if(e.target.dataset.cf==="type") c.type=e.target.value; else c.count=num(e.target.value);
      dirtyPrice=true; render();
    }));
    document.querySelectorAll("[data-cntr-del]").forEach(b=>b.addEventListener("click",()=>{
      state.shipment.containers.splice(Number(b.dataset.cntrDel),1); dirtyPrice=true; render();
    }));
    document.getElementById("cntrAdd").onclick=()=>{
      (state.shipment.containers=state.shipment.containers||[]).push({type:primaryType(),count:1}); dirtyPrice=true; render();
    };
    document.querySelectorAll("[data-mode]").forEach(b=>b.addEventListener("click",()=>{collect();setInvoiceMode(b.dataset.mode)}));
    document.querySelectorAll("[data-settle]").forEach(b=>b.addEventListener("click",()=>{state.settlement_mode=b.dataset.settle;render()}));
    document.getElementById("invToggle").onclick=()=>{invoiceOpen=!invoiceOpen;collect();render()};
    document.getElementById("ctToggle").onclick=()=>{contactOpen=!contactOpen;collect();render()};
    document.getElementById("langBtn")&&(document.getElementById("langBtn").onclick=toggleLang);
    document.getElementById("printBtn")&&(document.getElementById("printBtn").onclick=()=>window.print());
    document.getElementById("msgBtn").onclick=()=>alert("如有疑问，请联系对接人员。");
    document.getElementById("submitBtn").onclick=submit;
    applyLang();
  }
  async function submit(){
    collect();
    if(!state.buyer.name||!state.buyer.tax_id){alert("请填写购买方名称和税号");return}
    if(!(state.contacts.finance||[]).length){contactOpen=true;render();alert("请至少填写一个财务邮箱");return}
    const body={token,draft:{...state,price_changed:dirtyPrice,invoice_mode:state.invoices[0].mode,settlement_mode:state.settlement_mode||"monthly",shipment_containers:state.shipment.containers||[]}};
    const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok){alert("保存失败："+(d.error||r.status));return}
    state.status=d.draft.status; state.confirmed_at=d.draft.confirmed_at||state.confirmed_at; dirtyPrice=false; render(); alert(state.status==="pending_our_review"?"已提交改动，待我方确认":"已保存确认草稿");
  }
  async function boot(){
    if(!token){app.innerHTML='<div class="err">缺少 token</div>';return}
    try{
      const r=await fetch(API+"?token="+encodeURIComponent(token));
      const d=await r.json();
      if(!r.ok||!d.ok){app.innerHTML='<div class="err">港杂费开票确认暂不可用</div>';return}
      state=d.data; initContainers(); render();
    }catch(e){app.innerHTML='<div class="err">网络错误，暂无法加载港杂费开票确认</div>'}
  }
  boot();
})();
