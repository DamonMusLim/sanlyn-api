(function(){
  const API="/api/db/invoice-collab-confirm";
  const token=new URLSearchParams(location.search).get("token")||"";
  const DOCBILL=new URLSearchParams(location.search).get("doc")==="bill"; // 盖章账单明细PDF模式:只读账单+盖章位,给puppeteer出PDF
  const app=document.getElementById("app");
  const CNTR_TYPES=["20GP","40GP","40HC","40HQ","45HQ","20ST","20RF","40RF"];
  let state=null, dirtyPrice=false, contactOpen=false, invoiceOpen=false, sheetOpen=false, _lang="zh", invEdited=false;
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const num=v=>Number.isFinite(Number(String(v).replace(/,/g,"")))?Number(String(v).replace(/,/g,"")):0;
  const hasNum=v=>v!==null&&v!==undefined&&String(v).trim()!==""&&Number.isFinite(Number(String(v).replace(/,/g,"")));
  const round=v=>Math.round(num(v)*100)/100;
  const money=v=>num(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  const moneyVal=v=>hasNum(v)?money(v):"";
  const sym=c=>c==="USD"?"$":"¥";
  const isPer=b=>/每柜|per_container/i.test(String(b||""));
  const totalLines=()=>Array.isArray(state.bill_lines)?state.bill_lines.reduce((s,l)=>s+num(l.amount),0):0;
  const isConfirmed=()=>state?.status==="external_confirmed"||Boolean(state?.confirmed_at);
  const fmtTime=v=>v?new Date(v).toLocaleString("zh-CN",{hour12:false}):"";
  const isOcean=()=>state.bill_kind==="ocean";
  const docTitle=()=>{
    if(isOcean()) return "海运费账单";
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
        <td class="r"><input class="edit money" data-bl="${i}" data-f="unit_price" value="${moneyVal(l.unit_price)}" placeholder="待补"></td>
        <td class="r">${per?`<input class="edit money" style="width:52px" data-bl="${i}" data-f="qty" value="${moneyVal(l.qty).replace(".00","")}" placeholder="待补">`:`<span>1</span>`}</td>
        <td class="r">${money(l.amount)}</td>
        <td class="r"><button class="bl-del" data-bl-del="${i}" title="删除此行">✕</button></td>
      </tr>`;
    }).join("");
  }
  function settlementToggle(){
    const m=state.settlement_mode||"monthly";
    return `<div class="settle"><span class="mlab">结算方式</span><button class="mopt ${m==="monthly"?"on":""}" data-settle="monthly">月结</button></div>`;
  }
  function billSection(currency){
    const has=(state.bill_lines||[]).length;
    const notice=has?"":`<div class="bill-empty">${esc(state.bill_line_notice||"该票暂无港杂账单，可手动加行")}</div>`;
    const lines=totalLines(), target=num(state.port_charge_invoice_total);
    const discounted=target>0&&target<lines-0.01;                       // 打折:应付合计取目标价,补一行优惠(仅展示,不进bill_lines)
    const payable=discounted?target:lines;
    const discountRow=discounted?`<tr class="foot"><td colspan="5">优惠</td><td class="r" style="color:var(--warn)">-${money(lines-target)}</td><td></td></tr>`:"";
    return `<div class="sec"><div class="sec-t">① 账单明细 — 请核对</div>
      ${containerEditor()}
      ${settlementToggle()}
      <table class="billgrid"><thead><tr><th>费用项</th><th>计费</th><th>柜型</th><th class="r">单价 <span class="edithint">可改</span></th><th class="r">数量</th><th class="r">合计 (${esc(currency)})</th><th></th></tr></thead>
      <tbody>${billRows()}${discountRow}<tr class="foot"><td colspan="5">应付合计 · ${esc(currency)} <span style="font-weight:400;color:var(--faint);font-size:11px">（改单价/增删后自动重算）</span></td><td class="r">${money(payable)}</td><td></td></tr></tbody></table>
      ${notice}
      <button class="addline" id="addLine">＋ 加一行</button></div>`;
  }
  // 只读账单明细(doc=bill出PDF用):纯文本,无input/select/删除列
  function billRowsRO(){
    return (state.bill_lines||[]).map(l=>{
      const per=isPer(l.basis);
      return `<tr><td>${esc(l.name)}</td><td>${per?"每柜":"整票"}</td><td>${per?esc(l.container_type||primaryType()):"—"}</td>`
        +`<td class="r">${moneyVal(l.unit_price)||"—"}</td><td class="r">${per?(moneyVal(l.qty).replace(".00","")||"—"):"1"}</td><td class="r">${money(l.amount)}</td></tr>`;
    }).join("");
  }
  function billSectionRO(currency){
    const lines=totalLines(), target=num(state.port_charge_invoice_total);
    const discounted=target>0&&target<lines-0.01, payable=discounted?target:lines;
    const discountRow=discounted?`<tr class="foot"><td colspan="5">优惠</td><td class="r">-${money(lines-target)}</td></tr>`:"";
    return `<div class="sec"><div class="sec-t">港杂费账单明细</div>
      <table class="billgrid ro"><thead><tr><th>费用项</th><th>计费</th><th>柜型</th><th class="r">单价</th><th class="r">数量</th><th class="r">合计 (${esc(currency)})</th></tr></thead>
      <tbody>${billRowsRO()}${discountRow}<tr class="foot"><td colspan="5">应付合计 · ${esc(currency)}</td><td class="r">${money(payable)}</td></tr></tbody></table></div>`;
  }
  function renderBillDoc(){
    const sp=state.shipment, currency=(state.invoices[0]||{}).currency||(state.bill_lines[0]||{}).currency||"CNY", cntr=cntrSummary();
    const sellerEn=state.seller.name_en?`<div>${esc(state.seller.name_en)}</div>`:"";
    app.innerHTML=`<div class="sheet-hd"><div><div class="brand">${sellerEn}
      <div class="cn">${esc(state.seller.name||"")}　致：${esc(state.buyer.name||"")}</div></div></div>
      <div class="docmeta"><div class="doctag">${docTitle()}</div><div class="docno">${esc(sp.shipment_no||sp.bl_no||"")}</div></div></div>
      <div class="shipbar"><span>提单号 <b>${esc(sp.bl_no||"—")}</b></span><span>船名航次 <b>${esc([sp.vessel,sp.voyage].filter(Boolean).join(" / ")||"—")}</b></span>
      <span><b>${esc([sp.pol,sp.pod].filter(Boolean).join(" → ")||"—")}</b></span><span>柜量 <b>${esc(cntr||"—")}</b></span></div>
      ${billSectionRO(currency)}
      <div class="billseal"><div class="billseal-co">${esc(state.seller.name||"")}</div><div class="billseal-lab">（盖章）</div><div class="billseal-date">日期：＿＿＿年＿＿月＿＿日</div></div>`;
  }
  function invoiceRows(){
    const editable=(state.invoices[0]?.mode||"self")==="other";
    return state.invoices.map((inv,i)=>`<tr>
      <td>${editable?`<input class="edit inv-name" data-inv="${i}" data-if="item_name" value="${esc(inv.item_name)}">`:`<span data-en="Brokerage Agency Service Port Charges">${esc(inv.item_name)}</span>`}</td><td>${esc(inv.unit)}</td><td class="r">${inv.qty}</td>
      <td class="r">${money(inv.amount_ex_tax)}</td><td class="r">${editable?`<input class="edit money" data-inv="${i}" data-if="amount_ex_tax" value="${money(inv.amount_ex_tax)}">`:money(inv.amount_ex_tax)}</td>
      <td class="r">${Number(inv.tax_rate)>0?String(money(inv.tax_rate*100)).replace(".00","")+"%":"免税"}</td><td class="r">${money(inv.tax_amount)}</td>
    </tr>`).join("");
  }
  function invoiceOfficialHtml(currency){
    const editable=(state.invoices[0]?.mode||"self")==="other"; // 我方代开=只读, 对方自开=可编辑
    return state.invoices.map((inv,i)=>InvoiceOfficial.render({
      index:i,
      docTitle:isOcean()?"商业发票":"电子发票",
      title:isOcean()?"COMMERCIAL INVOICE":(inv.title||"增值税普通发票"),
      currency,
      buyer:state.buyer,
      seller:state.seller,
      seller_editable:false,
      buyer_editable:true,
      editable,
      items:[{name:inv.item_name,unit:inv.unit,qty:inv.qty||1,price:inv.amount_ex_tax,amount:inv.amount_ex_tax,rate:inv.tax_rate||0,tax:inv.tax_amount||0}],
      total_ex:inv.amount_ex_tax,
      total_tax:inv.tax_amount,
      total:inv.total_with_tax,
      remark:inv.remark||"",
      footerHtml:i===0?`<label class="savedef"><input type="checkbox" id="saveDefault" ${state.save_as_default?"checked":""}> <span>存为该客户默认开票模版，以后固定这样开。</span></label>`:""
    })).join("");
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
    if(DOCBILL){ renderBillDoc(); return; } // 盖章账单明细PDF:只出账单,不出发票/联系人/控件
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
      <div class="sec invoice-sec"><button class="collapse-hd" id="invToggle"><span class="sec-t" style="margin:0">② 开票 <span style="text-transform:none;font-weight:600;color:var(--sub)">${isOcean()?"· 如需发票再展开":"点开票展开"}</span></span><span class="chev">${invoiceOpen?"收起":"展开"} ▾</span></button>
      <div id="invBody" style="${invoiceOpen?"":"display:none"};margin-top:10px"><div class="modebar"><span class="mlab">开票方式</span>
      <button class="mopt ${inv.mode!=="other"?"on":""}" data-mode="self">自动开</button><button class="mopt ${inv.mode==="other"?"on":""}" data-mode="other" style="border:1.5px solid #b91c1c;color:${inv.mode==="other"?"#fff":"#b91c1c"};background:${inv.mode==="other"?"#b91c1c":"#fff7f7"};font-weight:800">自定义开票</button>
      <button class="mopt inv-tool" id="fwdBtn" type="button">转发</button></div>
      <div id="invoicePrintArea">${invoiceOfficialHtml(currency)}</div></div></div>
      <div class="sec"><button class="collapse-hd" id="ctToggle"><span class="sec-t" style="margin:0">③ 联系人邮箱 <span style="text-transform:none;font-weight:600;color:var(--sub)">· 财务/操作/业务，各可多个</span></span><span class="chev">${contactOpen?"收起":"展开填写"} ▾</span></button>
      <div class="sumline" style="${contactOpen?"display:none":""}">${contactSummary()}</div><div id="ctBody" style="${contactOpen?"":"display:none"};margin-top:6px">${contactEditor("finance","财务邮箱","必填 ★","发票发这里")}${contactEditor("ops","操作邮箱","","账单/确认通知")}${contactEditor("business","业务邮箱","","报价 / 砍价")}</div></div>
      <div class="actions" style="justify-content:flex-end"><button class="btn ghost" id="msgBtn" style="flex:0 0 auto;padding:10px 16px;font-size:13px">有疑问 · 留言给我</button>${inv.mode==="other"?`<button class="btn ghost" id="saveBtn" style="flex:0 0 auto;padding:10px 18px;font-size:13px">保存</button>`:""}<button class="btn primary" id="submitBtn" style="flex:0 0 auto;padding:10px 22px;font-size:13px">${inv.mode==="other"?"提交":"确认"}</button></div>`;
    bind();
  }
  function contactEditor(key,label,req,sub){
    const vals=(state.contacts[key]||[""]).concat([""]).slice(0,5);
    return `<div class="emrole"><div class="emlabel ${key==="finance"?"fin":key==="ops"?"ops":"buy"}">${label} ${req?`<span class="req">${req}</span>`:""}<em>${sub}</em></div>
      <div class="emlist">${vals.map(v=>`<input class="email" data-contact="${key}" value="${esc(v)}" placeholder="${key==="finance"?"name@example.com":"选填"}">`).join("")}</div></div>`;
  }
  function collect(){
    state.buyer.name=document.querySelector('[data-io-field="buyer.name"]')?.textContent.trim()||state.buyer.name||"";
    state.buyer.tax_id=document.querySelector('[data-io-field="buyer.tax_id"]')?.textContent.trim()||state.buyer.tax_id||"";
    state.save_as_default=document.getElementById("saveDefault")?.checked!==false;
    state.contacts={finance:[],ops:[],business:[]};
    document.querySelectorAll("[data-contact]").forEach(el=>{const v=el.value.trim();if(v)state.contacts[el.dataset.contact].push(v)});
    document.querySelectorAll("[data-inv]").forEach(el=>invoiceChanged(Number(el.dataset.inv),el.dataset.if,el.value,false));
    document.querySelectorAll(".invoiceOfficial [data-io-field]").forEach(el=>{
      const invIndex=Number(el.closest(".invoiceOfficial")?.dataset.ioIndex)||0;
      const field=el.dataset.ioField, value=(el.value??el.textContent).trim();
      if(field==="title") invoiceChanged(invIndex,"title",value,false);
      else if(field==="remark") invoiceChanged(invIndex,"remark",value,false);
      else {
        const m=field.match(/^items\.0\.(name|amount)$/);if(!m)return;
        invoiceChanged(invIndex,m[1]==="name"?"item_name":"amount_ex_tax",value,false);
      }
    });
  }
  function lineChanged(i,f,val){
    const l=state.bill_lines[i]; if(!l) return;
    if(f==="name") l.name=val;
    else if(f==="basis"){ l.basis=val; if(!isPer(val)){ l.qty=1; l.container_type=""; } else if(!l.container_type) l.container_type=primaryType(); }
    else if(f==="container_type") l.container_type=val;
    else if(f==="unit_price") l.unit_price=hasNum(val)?num(val):null;
    else if(f==="qty") l.qty=hasNum(val)?num(val):null;
    if(hasNum(l.unit_price)&&hasNum(l.qty)) l.amount=Math.round(num(l.unit_price)*num(l.qty)*100)/100;
    dirtyPrice=true; render();
  }
  function invoiceChanged(i,f,val,rerender=true){
    const inv=state.invoices[i]; if(!inv) return;
    if(f==="item_name") inv.item_name=val;
    else if(f==="amount_ex_tax") inv.amount_ex_tax=round(val);
    else if(f==="title") inv.title=val;
    else if(f==="remark") inv.remark=val;
    if(inv.mode==="other") invEdited=true; // 自定义有改动
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
      state.bill_lines.push({bl_no:state.shipment.bl_no||"",name:"",basis:"每柜",container_type:primaryType(),unit_price:null,qty:null,amount:0,currency:cur});
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
    document.querySelectorAll("[data-mode]").forEach(b=>b.addEventListener("click",()=>{
      const cur=state.invoices[0]?.mode||"self", next=b.dataset.mode;
      if(cur==="other"&&next!=="other"&&invEdited&&!confirm("发票有改动未保存，切换会丢失，确定切换？")) return;
      collect(); if(next!=="other") invEdited=false; setInvoiceMode(next);
    }));
    document.getElementById("saveBtn")&&(document.getElementById("saveBtn").onclick=save);
    document.querySelectorAll("[data-settle]").forEach(b=>b.addEventListener("click",()=>{state.settlement_mode=b.dataset.settle;render()}));
    document.getElementById("invToggle").onclick=()=>{invoiceOpen=!invoiceOpen;collect();render()};
    document.getElementById("ctToggle").onclick=()=>{contactOpen=!contactOpen;collect();render()};
    document.getElementById("fwdBtn")&&(document.getElementById("fwdBtn").onclick=fwd);
    document.getElementById("msgBtn").onclick=()=>alert("如有疑问，请联系对接人员。");
    document.getElementById("submitBtn").onclick=submit;
    applyLang();
  }
  function fwd(){
    const u=location.href;
    (navigator.clipboard?.writeText(u)||Promise.reject()).then(()=>alert("链接已复制，可转发给对方")).catch(()=>prompt("复制此链接转发：",u));
  }
  async function postDraft(){
    collect();
    const body={token,draft:{...state,price_changed:dirtyPrice,invoice_mode:state.invoices[0].mode,settlement_mode:state.settlement_mode||"monthly",shipment_containers:state.shipment.containers||[]}};
    const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok){alert("保存失败："+(d.error||r.status));return null}
    state.status=d.draft.status; state.confirmed_at=d.draft.confirmed_at||state.confirmed_at; dirtyPrice=false; invEdited=false;
    return d;
  }
  async function save(){ if(await postDraft()){ render(); alert("已保存草稿（未提交，可继续编辑）"); } }
  async function submit(){
    collect();
    if(!state.buyer.name||!state.buyer.tax_id){alert("请填写购买方名称和税号");return}
    if(!(state.contacts.finance||[]).length){contactOpen=true;render();alert("请至少填写一个财务邮箱");return}
    const d=await postDraft(); if(!d) return;
    render(); alert(state.status==="pending_our_review"?"已提交，待我方确认":"已确认");
  }
  async function boot(){
    if(!token){app.innerHTML='<div class="err">缺少 token</div>';return}
    try{
      const r=await fetch(API+"?token="+encodeURIComponent(token));
      const d=await r.json();
      if(!r.ok||!d.ok){app.innerHTML='<div class="err">港杂费开票确认暂不可用</div>';return}
      state=d.data; initContainers(); invoiceOpen=state.bill_kind!=="ocean"; render(); // 港杂默认展开开票,海运默认收起(如需发票再展开)
    }catch(e){app.innerHTML='<div class="err">网络错误，暂无法加载港杂费开票确认</div>'}
  }
  boot();
})();
