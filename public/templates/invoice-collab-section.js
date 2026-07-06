(function(){
  const API="/api/db/invoice-collab-confirm";
  const INBOUND_API="/api/db/factory-portal";
  const token=new URLSearchParams(location.search).get("token")||"";
  const app=document.getElementById("app");
  let state=null, inbound=null, inboundOpen=false, inboundInput=null, dirtyPrice=false, contactOpen=false;
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const num=v=>Number.isFinite(Number(v))?Number(v):0;
  const money=v=>num(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  const sym=c=>c==="USD"?"$":"¥";
  const rmb=v=>{const n=Number(v||0);return n?"¥"+n.toLocaleString(undefined,{maximumFractionDigits:2}):"—"};
  const totalLines=()=>state.bill_lines.reduce((s,l)=>s+num(l.amount),0);
  const recalcInvoice=()=>{
    const inv=state.invoices[0], total=Math.round(totalLines()*100)/100, ex=Math.round(total/1.01*100)/100;
    inv.total_with_tax=total; inv.amount_ex_tax=ex; inv.tax_amount=Math.round((total-ex)*100)/100;
  };
  function billRows(){
    return state.bill_lines.map((l,i)=>`<tr>
      <td>${esc(l.name)}</td><td><span class="unit">${esc(l.basis||"整票")}</span></td>
      <td class="r"><input class="edit money" data-line="${i}" value="${money(l.unit_price)}"></td>
      <td class="r">${money(l.qty).replace(".00","")}</td><td class="r">${money(l.amount)}</td>
    </tr>`).join("");
  }
  function invoiceRows(){
    return state.invoices.map(inv=>`<tr>
      <td>${esc(inv.item_name)}</td><td>${esc(inv.unit)}</td><td class="r">${inv.qty}</td>
      <td class="r">${money(inv.amount_ex_tax)}</td><td class="r">${money(inv.amount_ex_tax)}</td>
      <td class="r">1%</td><td class="r">${money(inv.tax_amount)}</td>
    </tr>`).join("");
  }
  function contactSummary(){
    const c=state.contacts||{}, f=(c.finance||[]).filter(Boolean).length;
    return `收起中 · 财务邮箱 ${f?`<b>${f} 个</b>`:`<span class="miss">未填（必填）</span>`} · 操作 ${(c.ops||[]).filter(Boolean).length||"—"} · 业务 ${(c.business||[]).filter(Boolean).length||"—"}`;
  }
  const inboundGaps=()=>Array.isArray(inbound?.gaps)?inbound.gaps:[];
  const inboundUploaded=()=>Array.isArray(inbound?.uploaded)?inbound.uploaded:[];
  const isDeclared=g=>!!(g&&g.customs_no&&String(g.customs_no).trim());
  function inboundBadge(){
    if(!inbound) return '<span class="badge mini">加载中</span>';
    const gaps=inboundGaps(), openable=gaps.filter(isDeclared).length, pending=gaps.length-openable;
    const text=gaps.length?(openable?`可开 ${openable} 单`:"待报关")+(pending?` · 待报关 ${pending}`:""):"已齐";
    return `<span class="badge mini ${openable?"hot":gaps.length?"gray":"done"}">${text}</span>`;
  }
  function inboundSection(){
    return `<div class="sec inbound">
      <button class="collapse-hd" id="inboundToggle"><span class="sec-t" style="margin:0">你开给我们的 · 进项票上传 <span style="text-transform:none;font-weight:600;color:var(--sub)">· 工厂开给厦门巴匕</span></span><span class="inbound-head">${inboundBadge()} <span class="chev">${inboundOpen?"收起":"展开"} ▾</span></span></button>
      <div class="sumline" style="${inboundOpen?"display:none":""}">${inboundSummary()}</div>
      <div id="inboundBody" style="${inboundOpen?"":"display:none"};margin-top:10px">${inboundBody()}</div>
    </div>`;
  }
  function inboundSummary(){
    if(!inbound) return "正在读取待开进项票缺口…";
    const gaps=inboundGaps(), up=inboundUploaded();
    if(!gaps.length) return up.length?`本厂进项票已齐 · 已上传 ${up.length} 张待财务核对`:"本厂进项票已齐，无待开。";
    const openable=gaps.filter(isDeclared).length;
    return `待开 ${gaps.length} 单 · 可上传 ${openable} 单 · 已上传 ${up.length} 张`;
  }
  function inboundBody(){
    if(!inbound) return '<div class="in-note">正在加载进项票状态…</div>';
    if(!inbound.factory) return '<div class="in-note warn">进项票上传暂不可用，请联系 Sanlyn 操作。</div>';
    const gaps=inboundGaps(), up=inboundUploaded();
    let h="";
    if(!gaps.length) h='<div class="in-ok">本厂进项票已齐，无待开。</div>';
    gaps.forEach((g,i)=>{ h+=inboundGapCard(g,i); });
    if(up.length){
      h+='<div class="uploaded-title">已上传（待财务核对 / OCR 回读）</div>';
      up.forEach(u=>{
        h+=`<div class="uploaded-row"><span>${esc(u.invoice_no||"—")}</span><span>${esc(u.review_status||"pending")}</span></div>`;
      });
    }
    return h;
  }
  function inboundGapCard(g,i){
    const goods=(g.goods||[]).map(x=>`${esc(x.name_cn||"")}${x.qty2_ctn?` ${esc(x.qty2_ctn)}箱`:""}`).join("、")||"—";
    if(!isDeclared(g)){
      return `<div class="gap-card disabled"><div class="gap-top"><b>${esc(g.contract_no||"—")}</b><span>待报关</span></div>
        <div class="gap-goods">${goods}</div><div class="wait">待报关后开票 · 报关完成后此处会亮出开票</div></div>`;
    }
    return `<div class="gap-card"><div class="gap-top"><b>${esc(g.contract_no||"—")}</b><span>待开</span></div>
      <div class="gap-goods">${goods}</div><div class="amount-box"><span>请开含税金额</span><b>${rmb(g.amount_incl_tax)}</b></div>
      <div class="tax-tip">${esc(g.tax_rate_label||"")} · 不含税/税额由贵司开票系统自动拆分</div>
      <div class="gap-actions"><button class="btn small" data-inbound-apply="${i}">开票申请</button><button class="btn small green" data-inbound-upload="${i}">上传发票</button></div>
      <div class="in-msg" id="inboundMsg${i}"></div></div>`;
  }
  function render(){
    recalcInvoice();
    const sp=state.shipment, inv=state.invoices[0], currency=inv.currency||"CNY";
    app.innerHTML=`<div class="finance-title">财务 · 开票</div><div class="sheet-hd"><div><div class="brand">SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS
      <div class="cn">上海洋宝宝国际物流有限公司　致：${esc(state.buyer.name||"")}</div></div></div>
      <div class="docmeta"><div class="doctag">港杂费账单</div><div class="docno">${esc(sp.shipment_no||sp.bl_no||"")}</div>
      <div class="badge ${state.status==="external_confirmed"?"done":""}">${state.status==="pending_our_review"?"待我方确认":state.status==="external_confirmed"?"已收到确认":"待你确认"}</div></div></div>
      <div class="shipbar"><span>提单号 <b>${esc(sp.bl_no||"—")}</b></span><span>船名航次 <b>${esc([sp.vessel,sp.voyage].filter(Boolean).join(" / ")||"—")}</b></span>
      <span><b>${esc([sp.pol,sp.pod].filter(Boolean).join(" → ")||"—")}</b></span><span>柜量 <b>${esc(sp.container_summary||"—")}</b></span></div>
      <div class="sec"><div class="sec-t">① 账单明细 — 请核对</div><table><thead><tr><th>费用项</th><th>计费</th><th class="r">单价 <span class="edithint">可改</span></th><th class="r">数量</th><th class="r">合计 (${esc(currency)})</th></tr></thead>
      <tbody>${billRows()}<tr class="foot"><td colspan="4">应付合计 · ${esc(currency)} <span style="font-weight:400;color:var(--faint);font-size:11px">（改单价后自动重算）</span></td><td class="r">${money(totalLines())}</td></tr></tbody></table>
      <div class="note"><i>ⓘ</i><span>金额可议价，<b>改价需我方确认后生效</b>。本确认只保存外部确认草稿，不代表已开票或已付款。</span></div></div>
      <div class="sec"><div class="sec-t">② 开票 · 港杂费</div><div class="modebar"><span class="mlab">开票方式</span>
      <button class="mopt ${inv.mode!=="other"?"on":""}" data-mode="self">我方代开</button><button class="mopt ${inv.mode==="other"?"on":""}" data-mode="other">对方自开</button>
      <span class="mtip" id="modeTip">${inv.mode==="other"?"对方自开后回传，我们 OCR 核对":"我们开好后发送到财务邮箱"}</span></div>
      <div class="plaininv"><div class="invtop"><div class="pt">电子发票（<select class="tsel" id="title"><option>增值税普通发票</option><option>增值税专用发票</option></select>）</div></div>
      <div class="pparty"><div class="pp"><div class="plab">购 买 方</div><div class="prow"><b>名称：</b><input class="edit" id="buyerName" value="${esc(state.buyer.name)}"><span class="edithint">可改</span></div>
      <div class="prow"><b>统一社会信用代码/纳税人识别号：</b><input class="edit" id="buyerTax" value="${esc(state.buyer.tax_id)}"></div><div class="tip">数电票只打印名称 + 税号</div></div>
      <div class="pp"><div class="plab">销 售 方</div><div class="prow"><b>名称：</b>${esc(state.seller.name)}</div><div class="prow"><b>统一社会信用代码/纳税人识别号：</b>${esc(state.seller.tax_id||"—")}</div></div></div>
      <table class="invline"><thead><tr><th>项目名称</th><th>单位</th><th class="r">数量</th><th class="r">单价</th><th class="r">金额(不含税)</th><th class="r">税率/征收率</th><th class="r">税额</th></tr></thead><tbody>${invoiceRows()}</tbody>
      <tfoot><tr><td colspan="4"></td><td class="r">价税合计</td><td colspan="2" class="r">${sym(currency)} ${money(inv.total_with_tax)}</td></tr></tfoot></table>
      <div class="remarkline">备注：${esc(inv.remark)}</div></div><button class="addinv" id="addInv">＋ 新增一张发票</button>
      <label class="savedef"><input type="checkbox" id="saveDefault" ${state.save_as_default?"checked":""}> <span>存为该客户默认开票模版，以后固定这样开。</span></label></div>
      <div class="sec"><button class="collapse-hd" id="ctToggle"><span class="sec-t" style="margin:0">③ 联系人邮箱 <span style="text-transform:none;font-weight:600;color:var(--sub)">· 财务/操作/业务，各可多个</span></span><span class="chev">${contactOpen?"收起":"展开填写"} ▾</span></button>
      <div class="sumline" style="${contactOpen?"display:none":""}">${contactSummary()}</div><div id="ctBody" style="${contactOpen?"":"display:none"};margin-top:6px">${contactEditor("finance","财务邮箱","必填 ★","发票发这里")}${contactEditor("ops","操作邮箱","","账单/确认通知")}${contactEditor("business","业务邮箱","","报价 / 砍价")}</div></div>
      <div class="actions"><button class="btn ghost" id="msgBtn">有疑问 · 留言给我</button><button class="btn primary" id="submitBtn">确认账单 + 开票信息</button></div>
      ${inboundSection()}`;
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
  }
  function bind(){
    document.querySelectorAll("[data-line]").forEach(el=>el.addEventListener("change",e=>{
      const l=state.bill_lines[Number(e.target.dataset.line)], up=num(e.target.value); l.unit_price=up; l.amount=Math.round(up*num(l.qty)*100)/100; dirtyPrice=true; render();
    }));
    document.querySelectorAll("[data-mode]").forEach(b=>b.addEventListener("click",()=>{state.invoices[0].mode=b.dataset.mode;render()}));
    document.getElementById("ctToggle").onclick=()=>{contactOpen=!contactOpen;collect();render()};
    document.getElementById("addInv").onclick=()=>alert("已预留多张发票结构，本轮先确认当前单票。");
    document.getElementById("msgBtn").onclick=()=>alert("请直接联系 Sanlyn 操作，留言入口下一版接入。");
    document.getElementById("submitBtn").onclick=submit;
    document.getElementById("inboundToggle").onclick=()=>{inboundOpen=!inboundOpen;collect();render()};
    document.querySelectorAll("[data-inbound-apply]").forEach(b=>b.addEventListener("click",()=>showInboundApply(Number(b.dataset.inboundApply))));
    document.querySelectorAll("[data-inbound-upload]").forEach(b=>b.addEventListener("click",()=>uploadInbound(Number(b.dataset.inboundUpload))));
  }
  async function submit(){
    collect();
    if(!state.buyer.name||!state.buyer.tax_id){alert("请填写购买方名称和税号");return}
    if(!(state.contacts.finance||[]).length){contactOpen=true;render();alert("请至少填写一个财务邮箱");return}
    const body={token,draft:{...state,price_changed:dirtyPrice,invoice_mode:state.invoices[0].mode}};
    const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok){alert("保存失败："+(d.error||r.status));return}
    state.status=d.draft.status; dirtyPrice=false; render(); alert(state.status==="pending_our_review"?"已提交改价，待我方确认":"已保存确认草稿");
  }
  async function loadInbound(){
    if(!token) return;
    try{
      const r=await fetch(INBOUND_API+"?mt="+encodeURIComponent(token));
      inbound=r.ok?await r.json():{factory:null,gaps:[],uploaded:[]};
    }catch(e){
      inbound={factory:null,gaps:[],uploaded:[]};
    }
  }
  function showInboundApply(i){
    const g=inboundGaps()[i], msg=document.getElementById("inboundMsg"+i);
    if(!g||!msg) return;
    msg.className="in-msg show";
    msg.innerHTML=`<div class="apply-box"><div class="apply-title">开票申请</div>
      <div>购买方：厦门巴匕进出口有限公司</div><div>销售方：${esc(inbound?.factory?.name||"")}</div>
      <div>合同：${esc(g.contract_no||"")}</div><div class="apply-amount">请开含税金额 ${rmb(g.amount_incl_tax)}（${esc(g.tax_rate_label||"")}）</div></div>`;
  }
  function setInboundMsg(i, text, cls){
    const msg=document.getElementById("inboundMsg"+i);
    if(!msg) return null;
    msg.className="in-msg show "+(cls||"");
    msg.textContent=text;
    return msg;
  }
  function uploadInbound(i){
    const g=inboundGaps()[i];
    if(!g) return;
    if(!inboundInput){
      inboundInput=document.createElement("input");
      inboundInput.type="file";
      inboundInput.accept="application/pdf,image/*";
      document.body.appendChild(inboundInput);
    }
    inboundInput.onchange=async e=>{
      const file=e.target.files[0];
      if(!file) return;
      const inv=prompt("请输入发票号码：");
      if(!inv){ e.target.value=""; return; }
      const amt=prompt("请输入价税合计（含税金额）：", g.amount_incl_tax||"");
      setInboundMsg(i,"上传中…","");
      try{
        const b64=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(file);});
        const resp=await fetch(INBOUND_API+"?mt="+encodeURIComponent(token)+"&action=upload",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({invoice_no:inv,amount_incl_tax:amt,contract_nos:g.contract_no,customs_nos:g.customs_no,file_base64:b64,file_name:file.name,mime_type:file.type})});
        const rd=await resp.json();
        if(resp.ok&&rd.ok){ setInboundMsg(i,"✓ 已上传，待财务核对","ok"); collect(); await loadInbound(); render(); }
        else setInboundMsg(i,"上传失败："+(rd.error||resp.status),"bad");
      }catch(err){ setInboundMsg(i,"网络错误","bad"); }
      e.target.value="";
    };
    inboundInput.click();
  }
  async function boot(){
    if(!token){app.innerHTML='<div class="err">缺少 token</div>';return}
    try{
      const r=await fetch(API+"?token="+encodeURIComponent(token));
      const d=await r.json();
      if(!r.ok||!d.ok){app.innerHTML='<div class="err">港杂费开票确认暂不可用</div>';return}
      state=d.data; await loadInbound(); render();
    }catch(e){app.innerHTML='<div class="err">网络错误，暂无法加载港杂费开票确认</div>'}
  }
  boot();
})();
