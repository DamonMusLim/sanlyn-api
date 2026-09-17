(function(){
  "use strict";
  var API="/api/db/manifest-message-channel";
  var VERSION="v2026.09.17-2";
  var state={rows:[],selected:null,coverage:null,outbox:null,preview:null,version:VERSION,generatedAt:null,canSave:false};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={"Content-Type":"application/json"},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(el){while(el.firstChild)el.removeChild(el.firstChild)}
  function text(el,v,fallback){el.textContent=v===null||v===undefined||v===""?(fallback||"未设置"):String(v)}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function pct(filled,total){if(!Number(total||0))return "未接入";return Math.round(Number(filled||0)*1000/Number(total))/10+"%"}
  function fillText(v){return v===null||v===undefined||!Number(v)?"未接入":String(v)+"%"}
  function rate(fields){var ready=(fields||[]).filter(function(f){return f.state==="ready"});if(!ready.length)return "未接入";var total=ready.reduce(function(a,f){return a+Number(f.total||0)},0),filled=ready.reduce(function(a,f){return a+Number(f.filled||0)},0);return total&&filled?pct(filled,total):"未接入"}
  function rateFor(name,group){var f=(((state.coverage||{})[group]||[]).find(function(x){return x.name===name}));if(!f||f.state!=="ready"||!Number(f.total)||!Number(f.filled))return "未接入";return pct(f.filled,f.total)}
  function detailValue(name,value,group,table){
    if(value!==null&&value!==undefined&&String(value).trim()!=="")return value;
    var f=(((state.coverage||{})[group]||[]).find(function(x){return x.name===name}))||{};
    var source=f.source||table+"."+name;
    if(f.state==="ready"&&Number(f.total||0))return "未接入 · 当前记录缺已填值 "+source+"；当前填充率 "+rateFor(name,group);
    if(f.state==="ready")return "未接入 · 缺 "+source+" 真实记录；当前填充率 未接入";
    return "未接入 · 缺 "+source+"；当前填充率 未接入";
  }
  function missingSources(fields, fallback){var xs=(fields||[]).filter(function(f){return f.state!=="ready"||!Number(f.total||0)}).map(function(f){return f.source||f.name});return xs.length?xs.join("、"):fallback}
  function sourceOf(f,table){return f.source||table+"."+f.name}
  function outboxNote(ob){
    if(ob.state==="ready")return "manifest_message_outbox 已接入；必需字段 "+(ob.connected_fields||0)+"/"+(ob.required_fields||0)+"；待发草稿数按真实记录显示";
    return "缺 "+((ob.missing_fields||[]).join("、")||"manifest_message_outbox")+"；当前填充率 "+fillText(ob.fill_rate);
  }
  function draftStateText(status){
    if(status==="pending_send")return "待发";
    if(status==="blocked")return "校验阻断草稿";
    return status||"未设置";
  }
  async function req(method, body, withId){
    var p=new URLSearchParams(), q=$("search").value.trim();
    if(q)p.set("q",q);if(withId&&state.selected&&state.selected.id)p.set("id",state.selected.id);
    var opt={method:method,headers:headers()};if(body)opt.body=JSON.stringify(body);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),opt),d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(!r.ok||d.success===false){var e=new Error(d.error||"请求失败");e.data=d;throw e}
    return d;
  }
  function rowTitle(r){return r.shipment_no||r.bl_no||("ID "+r.id)}
  function renderMetrics(){
    var cov=state.coverage||{}, ob=state.outbox||{};
    var allRows=Number(cov.total_rows_all||0), shownRows=Number(cov.total_rows||0);
    text($("mRows"),allRows?allRows:"未接入");
    text($("mHeader"),rate(cov.header_fields));
    text($("mBusiness"),rate(cov.business_fields));
    text($("mOutbox"),ob.state==="ready"?"已接入":"未接入");
    text($("nRows"),allRows?("customs_shipments 真实记录 "+allRows+" 条；当前筛选 "+shownRows+" 条"):"缺 customs_shipments 真实记录；当前填充率 未接入");
    text($("nHeader"),rate(cov.header_fields)==="未接入"?"缺 "+missingSources(cov.header_fields,"customs_shipments 字段覆盖")+"；当前填充率 未接入":"真实字段覆盖 "+rate(cov.header_fields));
    text($("nBusiness"),rate(cov.business_fields)==="未接入"?"缺 "+missingSources(cov.business_fields,"orders/shipping_plans 可关联字段")+"；当前填充率 未接入":"真实字段覆盖 "+rate(cov.business_fields));
    text($("nOutbox"),outboxNote(ob));
    $("mOutbox").className="num "+(ob.state==="ready"?"":"bad");
    $("summary").textContent="版本 "+(state.version||VERSION)+" · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){
      var allRows=Number((state.coverage||{}).total_rows_all||0);
      box.appendChild(el("div","empty",allRows?"当前筛选无匹配；customs_shipments 已接入真实记录 "+allRows+" 条。":"未接入 · 缺 customs_shipments 真实记录；当前填充率 未接入。"));
      return;
    }
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&String(r.id)===String(state.selected.id)?" active":""));b.type="button";b.dataset.id=r.id;
      b.appendChild(el("strong","",rowTitle(r)));
      b.appendChild(el("span","",(r.company_name||r.company_code||"未设置")+" · BL "+(r.bl_no||"未设置")+" · "+([r.vessel,r.voyage].filter(Boolean).join(" / ")||"船名航次未设置")));
      box.appendChild(b);
    });
  }
  function td(tr,v){var c=document.createElement("td");text(c,v);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取舱单记录，当前填充率 未接入。"));text($("readyPill"),"未接入");return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [["舱单编号",detailValue("shipment_no",r.shipment_no,"header_fields","customs_shipments")],["委托单位",detailValue("company_code",r.company_name||r.company_code,"header_fields","customs_shipments")],["船公司",detailValue("carrier",r.carrier,"header_fields","customs_shipments")],["船名航次",[detailValue("vessel",r.vessel,"header_fields","customs_shipments"),detailValue("voyage",r.voyage,"header_fields","customs_shipments")].join(" / ")],["提单号",detailValue("bl_no",r.bl_no,"header_fields","customs_shipments")],["装卸港",[detailValue("pol",r.pol,"header_fields","customs_shipments"),detailValue("pod",r.pod,"header_fields","customs_shipments")].join(" → ")],["发货人",detailValue("shipper_name",r.shipper_name,"header_fields","customs_shipments")],["收货人",detailValue("consignee_name",r.consignee_name,"header_fields","customs_shipments")],["通知人",detailValue("notify_name",r.notify_name,"header_fields","customs_shipments")],["状态",detailValue("status",r.status,"header_fields","customs_shipments")]].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1]);body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);text($("readyPill"),"真实记录");
  }
  function kv(label,value,bad){
    var d=el("div","kv"+(bad?" bad":"")),b=el("b","",label),s=el("span","");
    text(s,value);d.appendChild(b);d.appendChild(s);return d;
  }
  function businessText(r,name,value){
    var m=(r.business_missing||[]).find(function(x){return x.name===name});
    if(m&&m.reason==="not_connected")return "未接入 · 缺 "+m.source+"；当前填充率 "+rateFor(name,"business_fields");
    if(m&&m.reason==="empty")return "未接入 · 缺已填值 "+m.source+"；当前填充率 "+rateFor(name,"business_fields");
    return value;
  }
  function renderBusiness(){
    var box=$("business");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取舱单记录，当前填充率 未接入。"));text($("businessPill"),"未接入");return}
    var grid=el("div","mini-grid");
    grid.appendChild(kv("订单进程",businessText(r,"order_status",r.order_status)));
    grid.appendChild(kv("海运进程",businessText(r,"plan_status",r.plan_status)));
    grid.appendChild(kv("订单类型",businessText(r,"order_type",r.order_type)));
    grid.appendChild(kv("业务类型",businessText(r,"business_type",r.business_type)));
    grid.appendChild(kv("业务异常",businessText(r,"business_exception",r.business_exception),r.business_exception));
    box.appendChild(grid);
    if(r.business_missing&&r.business_missing.length){
      box.appendChild(el("p","muted","未接入/未填字段："+r.business_missing.map(function(x){return x.label+"("+x.source+")"}).join("、")+"。未接入条目不提供忽略。"));
    }
    text($("businessPill"),r.business_missing_count?"待补字段":"已接入");
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);
    var groups=[["抬头",((state.coverage&&state.coverage.header_fields)||[]),"customs_shipments"],["业务",((state.coverage&&state.coverage.business_fields)||[]),"orders/shipping_plans"],["明细",((state.coverage&&state.coverage.line_fields)||[]),"customs_shipment_lines"]];
    var any=false;
    groups.forEach(function(g){
      g[1].forEach(function(f){
        any=true;
        var d=el("div","field"),b=el("b","",g[0]+" · "+f.label),s=el("span","");
        if(f.state==="not_connected")text(s,"未接入 · 缺 "+sourceOf(f,g[2])+"；当前填充率 未接入");
        else if(!f.total)text(s,"未接入 · 缺 "+sourceOf(f,g[2])+" 真实记录；当前填充率 未接入");
        else if(!Number(f.filled||0))text(s,"未接入 · 缺已填值 "+sourceOf(f,g[2])+"；当前填充率 未接入");
        else text(s,sourceOf(f,g[2])+" · "+f.filled+"/"+f.total+" · "+pct(f.filled,f.total));
        d.appendChild(b);d.appendChild(s);box.appendChild(d);
      });
    });
    if(!any)box.appendChild(el("div","empty","未接入 · 缺字段清单；当前填充率 未接入。"));
  }
  function renderOutbox(){
    var box=$("outbox");clear(box);var ob=state.outbox||{};
    $("save").disabled=ob.state!=="ready"||!state.selected||!state.canSave;
    if(ob.state!=="ready"){var miss=(ob.missing_fields||[]).join("、")||"manifest_message_outbox";box.appendChild(el("p","bad","未接入"));box.appendChild(el("p","muted","缺待发表/字段："+miss+"；当前填充率 "+fillText(ob.fill_rate)+"。"));box.appendChild(el("p","muted","未接入条目不提供忽略；请人工确认建表后再保存待发，SQL 不放入 migrations 自动执行。"));if(ob.required_sql){var p=el("pre","");text(p,ob.required_sql);box.appendChild(p)}return}
    var drafts=ob.drafts||[];box.appendChild(el("p","muted","待发表已接入；保存动作只写 blocked 或 pending_send，不执行发送；必需字段 "+(ob.connected_fields||0)+"/"+(ob.required_fields||0)+"。"));
    if(!drafts.length){box.appendChild(el("div","empty","暂无 blocked/pending_send 待发草稿；manifest_message_outbox 已接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    drafts.forEach(function(d){var tr=document.createElement("tr");td(tr,d.id);td(tr,d.channel);td(tr,draftStateText(d.status));td(tr,d.updated_at||d.created_at);body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
  }
  function renderValidation(){
    var box=$("validation");clear(box);var msg=state.preview||{}, sum=msg.validation_summary, errors=msg.errors||[];
    if(!sum){
      text($("validationPill"),msg.error?"阻断":"未接入");
      if(msg.missing_fields&&msg.missing_fields.length){
        box.appendChild(el("p","bad","未接入 · 缺 "+msg.missing_fields.join("、")+"；当前填充率 未接入。"));
        if(msg.required_sql){var sql=el("pre","");text(sql,msg.required_sql);box.appendChild(sql)}
        return;
      }
      box.appendChild(el("div","empty",msg.error?("阻断 · "+msg.error+"；未落地，未发送。"):"未接入 · 尚未生成校验结果；当前填充率 未接入。"));return}
    text($("validationPill"),sum.state==="ready"?"通过":"阻断");
    var bar=el("div","statusbar");
    [["状态",sum.state],["落库状态",sum.persist_status||"未接入"],["允许落库",((sum.persist_allowed_statuses||[]).join("/")||"未接入")],["可发送","否"],["阻断项",errors.length?errors.length:"无"]].forEach(function(pair){bar.appendChild(el("span","",pair[0]+"："+pair[1]))});
    box.appendChild(bar);
    box.appendChild(el("p",sum.state==="ready"?"muted":"bad",sum.note||"本页不对外发送。"));
    if(!errors.length){box.appendChild(el("div","empty","校验通过；仍只允许落地待发，不发送。"));return}
    var table=document.createElement("table"),head=document.createElement("thead"),hr=document.createElement("tr"),body=document.createElement("tbody");
    ["范围","字段","原因","当前填充率"].forEach(function(h){var th=document.createElement("th");text(th,h);hr.appendChild(th)});head.appendChild(hr);
    errors.forEach(function(e){var tr=document.createElement("tr");td(tr,e.scope);td(tr,(e.label||e.name)+" · "+(e.source||e.name));td(tr,e.reason);td(tr,fillText(e.fill_rate));body.appendChild(tr)});
    table.appendChild(head);table.appendChild(body);box.appendChild(table);
  }
  function renderPreview(){
    if(!state.preview){text($("preview"),"未接入 · 尚未生成报文；缺待发表 manifest_message_outbox 时不能落地，当前填充率 未接入。");text($("previewPill"),"未接入");return}
    text($("preview"),JSON.stringify(state.preview,null,2));text($("previewPill"),state.preview.status||"已生成");
  }
  function render(){renderMetrics();renderList();renderDetail();renderBusiness();renderCoverage();renderOutbox();renderValidation();renderPreview()}
  async function load(keepId, keepSave, withId){
    try{var oldId=keepId&&state.selected?state.selected.id:null,d=await req("GET",null,Boolean(withId));state.rows=d.data||[];state.selected=(oldId&&state.rows.find(function(r){return String(r.id)===String(oldId)}))||d.selected||state.rows[0]||null;state.coverage=d.coverage||null;state.outbox=d.outbox||null;state.generatedAt=d.generated_at;state.version=d.version||VERSION;if(!keepSave)state.canSave=false;render()}
    catch(e){$("summary").textContent="读取失败";["list","business"].forEach(function(id){clear($(id));$(id).appendChild(el("div","error",e.message))})}
  }
  async function action(name){
    try{var d=await req("POST",{action:name},true);var preview=d.message||d;if(d.draft)preview.draft=d.draft;state.preview=preview;state.canSave=Boolean(name==="validate"&&preview.validation_summary&&preview.validation_summary.can_persist);await load(true,state.canSave);state.preview=preview;if(name==="save")state.canSave=false;renderOutbox();renderValidation();renderPreview();alert(name==="validate"?"校验完成，未落地。":("已落地 "+(d.draft&&d.draft.id?("draft #"+d.draft.id):preview.status||"草稿")+"，未发送。"))}
    catch(e){state.preview=e.data||{error:e.message};state.canSave=false;renderOutbox();renderValidation();renderPreview();alert(e.message+"；未发送。")}
  }
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;var id=b.dataset.id;state.selected=state.rows.find(function(r){return String(r.id)===String(id)})||state.selected;state.preview=null;state.canSave=false;render();load(true,false,true)});
  $("reload").addEventListener("click",function(){load()});
  $("search").addEventListener("keydown",function(e){if(e.key==="Enter")load(false)});
  $("validate").addEventListener("click",function(){action("validate")});
  $("save").addEventListener("click",function(){action("save")});
  window.addEventListener("message",function(event){var d=event.data||{};if(event.origin===location.origin&&d.type==="sanlyn:module-refresh")load(true,state.canSave)});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",protocol:"sanlyn:open-tab",module:"manifest-message-channel",title:"报文数据通道",url:location.pathname+location.search,accepts:["sanlyn:module-refresh"]},location.origin);
  load();
})();
