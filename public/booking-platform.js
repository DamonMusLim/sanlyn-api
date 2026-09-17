(function(){
  "use strict";
  var API="/api/db/booking-platform";
  var params=new URLSearchParams(location.search);
  var state={rows:[],selected:null,selectedKey:params.get("selected")||"",coverage:null,channel:null,platform:null,documents:null,trial:null,generatedAt:null,version:"v2026.09.17-3",nextOnly:params.get("next")!=="0"};
  var $=function(id){return document.getElementById(id)};
  function on(id,type,fn){var x=$(id);if(x)x.addEventListener(type,fn)}
  function setDisabled(id,value){var x=$(id);if(x)x.disabled=!!value}
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function text(x,v,fallback){x.textContent=v===null||v===undefined||v===""?(fallback||"未设置"):String(v)}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function pct(filled,total){if(!total||!Number(filled||0))return "未接入";return Math.round(Number(filled||0)*1000/Number(total))/10+"%"}
  function rateText(f){return f&&f.fill_text?f.fill_text:(f&&f.total?pct(f.filled,f.total):"未接入")}
  function safeUrl(raw){try{var p=new URL(String(raw||""),location.origin);if(p.protocol==="http:"||p.protocol==="https:")return p.href;if(p.origin===location.origin)return p.pathname+p.search+p.hash}catch(e){}return ""}
  function currentUrl(){
    var p=new URLSearchParams(), q=$("search").value.trim(), st=$("state").value;
    if(q)p.set("q",q);if(st)p.set("state",st);if(!state.nextOnly)p.set("next","0");
    if(state.selectedKey)p.set("selected",state.selectedKey);
    return "/booking-platform"+(p.toString()?"?"+p.toString():"");
  }
  function syncQuery(){
    var url=currentUrl();
    if(history.replaceState)history.replaceState(null,"",url);
    $("nextTicket").classList.toggle("primary",state.nextOnly);
  }
  function downloadOne(doc){
    var href=safeUrl(doc&&doc.url);
    if(!href)return;
    var a=document.createElement("a");
    a.href=href;a.target="_blank";a.rel="noopener";a.download="";
    document.body.appendChild(a);a.click();a.remove();
  }
  function downloadManifest(){
    var r=state.selected,docs=readyDocs(),platformDocs=platformLinks();
    if(!r||(!docs.length&&!platformDocs.length))return;
    var payload={
      version:state.version,
      generated_at:new Date().toISOString(),
      source:"document_files/ocean_doc_intake + booking_platform_integrations",
      shipment_no:r.shipment_no||"",
      booking_ref:r.booking_no||r.forwarder_booking_no||r.so_no||"",
      bl_no:r.bl_no||"",
      trial_order:r.trial_order||"",
      is_next_ticket:!!r.is_next_ticket,
      documents:docs.map(function(d){return {kind:d.kind||"",name:d.name||"",type:d.type||"",source:d.source||"",url:safeUrl(d.url),uploaded_at:d.uploaded_at||""}}),
      platform_downloads:platformDocs.map(function(x){return {account:x.account||"",session_status:x.session_status||"",login_url:safeUrl(x.login_url),url:safeUrl(x.download_url),downloaded_at:x.downloaded_at||"",matched_refs:x.matched_refs||[]}}),
      missing_fields:(state.trial&&state.trial.missing_fields)||[]
    };
    var blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    var a=document.createElement("a"),name=(r.shipment_no||r.bl_no||r.booking_no||"booking-docs").replace(/[^A-Za-z0-9_-]+/g,"-");
    a.href=URL.createObjectURL(blob);a.download=name+"-docs.json";document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},0);
  }
  function downloadAllDocs(){
    var docs=readyDocs();
    if(!docs.length)return;
    docs.forEach(downloadOne);
    downloadManifest();
  }
  function readyDocs(){var r=state.selected,docs=(r&&r.docs)||[];return docs.filter(function(d){return safeUrl(d.url)&&(d.kind==="bl"||d.kind==="signed")})}
  function platformLinks(){return ((state.platform&&state.platform.entries)||[]).filter(function(x){return safeUrl(x.download_url)})}
  function platformLoginLinks(){return ((state.platform&&state.platform.entries)||[]).filter(function(x){return safeUrl(x.login_url)})}
  function platformDownloadCount(){return platformLinks().length}
  function matchedText(item){
    var refs=(item&&item.matched_refs)||[];
    if(refs.length)return refs.map(function(x){return x.field+"="+x.value}).join("；");
    return item&&item.match_ref?("匹配值 "+item.match_ref):"未接入";
  }
  function openExternalUrl(raw){
    var href=safeUrl(raw);
    if(!href)return;
    window.open(href,"_blank","noopener");
  }
  function openPlatformDownloads(){
    var links=platformLinks();
    if(links.length){links.forEach(function(x){openExternalUrl(x.download_url)});return}
    platformLoginLinks().forEach(function(x){openExternalUrl(x.login_url)});
  }
  function downloadPlatformDocs(){
    var links=platformLinks();
    if(!links.length)return;
    links.forEach(function(x){openExternalUrl(x.download_url)});
    downloadManifest();
  }
  function openWorkbench(title,url){
    if(window.SanlynOpenTab){window.SanlynOpenTab(title,url);return}
    if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",protocol:"sanlyn:open-tab",title:title,url:url},location.origin);
    else window.open("/wb-tabs?open="+encodeURIComponent(url)+"&title="+encodeURIComponent(title),"_blank","noopener");
  }
  function fields(){return ((state.coverage&&state.coverage.fields)||[]).concat((state.coverage&&state.coverage.channel_fields)||[]).concat((state.coverage&&state.coverage.document_fields)||[]).concat((state.coverage&&state.coverage.platform_fields)||[])}
  function field(name){return fields().find(function(f){return f.name===name})||null}
  function groupField(group,name){return ((state.coverage&&state.coverage[group])||[]).find(function(f){return f.name===name})||null}
  function fieldRate(names){
    var fs=names.map(field).filter(Boolean).filter(function(f){return f.state==="ready"});
    if(!fs.length)return "未接入";
    var total=fs.reduce(function(a,f){return a+Number(f.total||0)},0);
    var filled=fs.reduce(function(a,f){return a+Number(f.filled||0)},0);
    if(!filled)return "未接入";
    return total?filled+"/"+total+" ("+pct(filled,total)+")":"未接入";
  }
  function anyRowRate(names){
    var rows=state.rows||[];
    if(!rows.length)return "未接入";
    var filled=rows.filter(function(r){return names.some(function(n){return nonEmpty(r[n])})}).length;
    return filled?filled+"/"+rows.length+" ("+pct(filled,rows.length)+")":"未接入";
  }
  function metricMeta(id, msg){var x=$(id);if(x)x.textContent=msg}
  async function api(){
    var p=new URLSearchParams(), q=$("search").value.trim(), st=$("state").value;
    if(q)p.set("q",q);if(st)p.set("state",st);
    if(state.nextOnly)p.set("next","1");
    if(state.selectedKey)p.set("selected",state.selectedKey);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function stateLabel(s){
    return {ready:"订舱字段已填",not_connected:"未接入",missing_booking:"缺订舱号",missing_schedule:"缺船期",missing_forwarder:"缺货代"}[s]||"待核";
  }
  function renderMetrics(){
    var cov=state.coverage||{};
    text($("mRows"),cov.total_rows?cov.total_rows:"未接入");
    var bookingRate=anyRowRate(["booking_no","forwarder_booking_no","so_no"]);
    text($("mBooking"),bookingRate);
    text($("mSchedule"),fieldRate(["vessel","voyage","etd"]));
    text($("mChannel"),"未接入");
    metricMeta("mRowsMeta",cov.total_rows?"shipping_plans 真实记录":"缺 shipping_plans 真实记录；当前填充率 未接入");
    metricMeta("mBookingMeta","字段 shipping_plans.booking_no / forwarder_booking_no / so_no 任一有值；当前填充率 "+bookingRate+"。单列填充率 "+fieldRate(["booking_no","forwarder_booking_no","so_no"]));
    metricMeta("mScheduleMeta","字段 shipping_plans.vessel / voyage / etd；当前填充率 "+fieldRate(["vessel","voyage","etd"]));
    metricMeta("mChannelMeta","缺订舱外部发送接口/凭证/回执落库；当前填充率 未接入");
    setDisabled("downloadAll",!readyDocs().length);
    setDisabled("manifestBtn",!(readyDocs().length||platformDownloadCount()));
    setDisabled("downloadTrialPack",!state.selected);
    setDisabled("downloadPlatformDocs",!platformDownloadCount());
    setDisabled("openPlatform",!(platformLinks().length||platformLoginLinks().length));
    $("downloadPlatformDocs").textContent=platformDownloadCount()?("下载海管家资料 "+platformDownloadCount()+" 份"):"海管家资料未接入";
    $("openPlatform").textContent=platformDownloadCount()?"打开海管家下载入口":(platformLoginLinks().length?"打开海管家登录入口":"海管家入口未接入");
    $("summary").textContent=state.version+" · "+(state.nextOnly?"下一票试走 · ":"")+"生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function rowKey(r){return String(r.id||r.plan_id||r.shipment_no||r.bl_no||"")}
  function rowTitle(r){return r.shipment_no||r.booking_no||r.forwarder_booking_no||r.so_no||r.bl_no||("ID "+(r.id||r.plan_id||r._id||"未接入"))}
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 shipping_plans 真实记录；当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&rowKey(r)===rowKey(state.selected)?" active":""));
      b.type="button";b.dataset.key=rowKey(r);
      b.appendChild(el("strong","",rowTitle(r)));
      if(r.is_next_ticket)b.appendChild(el("span","","下一票试走 · 顺序 "+(r.trial_order||1)));
      b.appendChild(el("span","","订舱 "+(r.booking_no||r.forwarder_booking_no||r.so_no||"未接入")+" · "+(r.pol||"未设置")+" / "+(r.pod||"未设置")));
      b.appendChild(el("span","","船期 "+([r.vessel,r.voyage].filter(Boolean).join(" / ")||"未接入")+" · ETD "+(r.etd||"未接入")+" · 系统资料 "+(r.doc_ready?("可下载 "+(r.doc_ready_count||1)+" 份"):"未接入")+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function td(tr,v,fallback){var c=document.createElement("td");text(c,v,fallback||"未接入");tr.appendChild(c)}
  function rateFor(name){return rateText(field(name))}
  function missingLine(r,names,table){
    var miss=(r&&r.missing||[]).filter(function(x){return names.indexOf(x.name)>=0}).map(function(x){return x.label+"("+(table||"shipping_plans")+"."+x.name+")"});
    return miss.length?"缺字段："+miss.join("、")+"；当前填充率 "+names.map(function(n){return n+" "+rateFor(n)}).join("；"):"";
  }
  function renderDetail(){
    var box=$("detail");clear(box);
    var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取 shipping_plans 记录；当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["CY号",r.shipment_no],["订舱号",r.booking_no],["货代订舱号",r.forwarder_booking_no],["SO号",r.so_no],["提单号",r.bl_no],
      ["订单号",(r.order_nos||[]).join(" / ")],["合同号",([r.contract_no].concat(r.contract_nos||[]).filter(Boolean)).join(" / ")],
      ["船公司",r.carrier_code],["货代",r.forwarder_cn],["起运/目的港",[r.pol,r.pod].filter(Boolean).join(" / ")],
      ["船名航次",[r.vessel,r.voyage].filter(Boolean).join(" / ")],["ETD/ETA",[r.etd,r.eta].filter(Boolean).join(" / ")],
      ["截关/截港/SI",[r.cutoff_time,r.cy_cutoff,r.si_cutoff].filter(Boolean).join(" / ")],
      ["柜量/柜型",[r.container_qty,r.container_type].filter(function(x){return x!==null&&x!==undefined&&x!==""}).join(" / ")],
      ["客户",r.customer],["状态",r.status]
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0],"未设置");td(tr,pair[1]);body.appendChild(tr)});
    if(state.nextOnly){
      var trialTr=document.createElement("tr");
      td(trialTr,"试走顺序","未设置");
      td(trialTr,r.is_next_ticket?"下一票":(r.trial_order?("第 "+r.trial_order+" 票"):"未接入"));
      body.appendChild(trialTr);
    }
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length)box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"(shipping_plans."+x.name+")";}).join("、")+"；当前填充率见下方真实字段卡片。"));
    $("readyPill").className="pill "+(r.state==="ready"?"":(r.state==="not_connected"?"bad":"warn"));
    text($("readyPill"),stateLabel(r.state));
  }
  function docRateText(){
    var f=field("file_url");
    if(!f)return "当前填充率 未接入";
    return "当前填充率 "+rateText(f);
  }
  function docMissingText(){
    var miss=(state.documents&&state.documents.missing_fields||[]).map(function(x){return (x.table||"document_files")+"."+x.name}).join("、");
    return miss||"document_files/ocean_doc_intake 提单/签单资料记录";
  }
  function docCoverageText(){
    var f=field("file_url"), t=field("doc_type");
    return "资料URL "+rateText(f)+"；资料类型 "+rateText(t);
  }
  function nonEmpty(v){return v!==null&&v!==undefined&&String(v).trim()!==""}
  function localTrial(){
    var r=state.selected,ready=readyDocs(),miss=[],hasRef=r&&(nonEmpty(r.booking_no)||nonEmpty(r.forwarder_booking_no)||nonEmpty(r.so_no));
    function add(name,label){var f=field(name);miss.push({name:name,label:label,table:name==="file_url"||name==="doc_type"?"document_files/ocean_doc_intake":"shipping_plans",fill_text:rateText(f)})}
    if(!r)return state.trial||{can_download:false,can_trial:false,missing_fields:[{name:"shipping_plans",label:"订舱记录",table:"shipping_plans",fill_text:"未接入"}],note:"缺可读取 shipping_plans 记录，不能定位下一票。"};
    if(!hasRef){add("booking_no","订舱号");add("forwarder_booking_no","货代订舱号");add("so_no","SO号")}
    [["vessel","船名"],["voyage","航次"],["etd","ETD"]].forEach(function(x){if(!nonEmpty(r[x[0]]))add(x[0],x[1])});
    if(!ready.length){add("file_url","提单/签单资料URL");add("doc_type","提单/签单资料类型")}
    var ok=hasRef&&nonEmpty(r.vessel)&&nonEmpty(r.voyage)&&nonEmpty(r.etd)&&ready.length>0;
    return {can_download:ready.length>0,can_trial:ok,missing_fields:miss,note:ok?"当前选中票已有订舱参考和提单/签单资料 URL，可人工登录海管家平台试走下载核对。":"当前选中票缺订舱参考、船期或提单/签单资料 URL，只展示未接入，不提供忽略。"};
  }
  function docSourceText(){
    return "来源 document_files.file_url / ocean_doc_intake.file_url；按 shipment_no / bl_no / contract_no / order_no / order_nos / 已绑定订单ID 匹配；资料类型按 doc_type / 文件名 / URL 真实字段识别";
  }
  function platformRate(name){
    var f=groupField("platform_fields",name);
    return f?rateText(f):"未接入";
  }
  function platformMissingText(){
    var miss=(state.platform&&state.platform.missing_fields||[]).map(function(x){return (x.table||"booking_platform_integrations")+"."+x.name+" "+(x.fill_text||"未接入");});
    return miss.length?miss.join("；"):"booking_platform_integrations.hgj_download_url 未接入";
  }
  function platformRequiredText(){
    var req=(state.platform&&state.platform.required_fields)||[];
    return req.length?req.map(function(x){return (x.table||"booking_platform_integrations")+"."+x.name+" 当前填充率 "+(x.fill_text||"未接入");}).join("；"):"booking_platform_integrations.hgj_account / hgj_session_status / hgj_login_url / hgj_download_url 当前填充率 未接入";
  }
  function hgjPackContext(){
    var platformReq=(state.platform&&state.platform.required_fields)||[];
    return {
      selected:state.selected,
      version:state.version,
      ready_docs:readyDocs(),
      platform_entries:(state.platform&&state.platform.entries)||[],
      missing_fields:((state.trial&&state.trial.missing_fields)||[]).concat((state.platform&&state.platform.missing_fields)||[]),
      required_fields:platformReq,
      fill_rates:{
        document_file_url:rateText(groupField("document_fields","file_url")),
        document_doc_type:rateText(groupField("document_fields","doc_type")),
        hgj_login_url:platformRate("hgj_login_url"),
        hgj_download_url:platformRate("hgj_download_url")
      }
    };
  }
  function renderDocs(){
    var box=$("docs");clear(box);
    var r=state.selected, docs=(r&&r.docs)||[], ready=readyDocs();
    $("docPill").className="pill "+(ready.length?"":"bad");
    text($("docPill"),ready.length?("可下载 "+ready.length+" 份"):"未接入");
    setDisabled("downloadAll",!ready.length);
    setDisabled("manifestBtn",!(ready.length||platformDownloadCount()));
    setDisabled("downloadPlatformDocs",!platformDownloadCount());
    setDisabled("openPlatform",!(platformLinks().length||platformLoginLinks().length));
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取 shipping_plans 记录；当前填充率 未接入。"));return}
    if(!ready.length){
      var why=docs.length?"缺 document_files/ocean_doc_intake.file_url 可下载提单/签单资料URL":("缺 "+docMissingText());
      box.appendChild(el("div","empty","未接入 · "+why+"；"+docRateText()+"。"));
      return;
    }
    var table=document.createElement("table"),body=document.createElement("tbody");
    ready.forEach(function(d){
      var tr=document.createElement("tr"), c1=document.createElement("td"), c2=document.createElement("td"), c3=document.createElement("td"), actions=el("div","doc-actions"), a=document.createElement("a"), b=el("button","","下载");
      text(c1,d.kind==="bl"?"提单资料":"签单资料");text(c2,[d.name||d.type||"未设置",d.source].filter(Boolean).join(" · "));
      a.className="hgj-link";a.href=safeUrl(d.url);a.target="_blank";a.rel="noopener";a.textContent="下载";
      b.type="button";b.addEventListener("click",function(){downloadOne(d)});
      actions.appendChild(a);actions.appendChild(b);c3.appendChild(actions);tr.appendChild(c1);tr.appendChild(c2);tr.appendChild(c3);body.appendChild(tr);
    });
    table.appendChild(body);box.appendChild(table);
    box.appendChild(el("p","muted",docSourceText()+"；"+docRateText()+"。"));
  }
  function renderTrial(){
    var box=$("trial");clear(box);var r=state.selected,ready=readyDocs(),t=localTrial();
    $("trialPill").className="pill "+(t.can_trial?"":(t.can_download?"warn":"bad"));
    text($("trialPill"),t.can_trial?"可试走":(t.can_download?"可下载待补字段":"未接入"));
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取 shipping_plans 记录；当前填充率 未接入。"));return}
    var lines=[
      ["当前票",rowTitle(r)],
      ["订舱参考",r.booking_no||r.forwarder_booking_no||r.so_no,["booking_no","forwarder_booking_no","so_no"]],
      ["船期",[r.vessel,r.voyage,r.etd].filter(Boolean).join(" / "),["vessel","voyage","etd"]],
      ["资料下载",ready.length?("提单/签单 "+ready.length+" 份"):"未接入"]
    ];
    var table=document.createElement("table"),body=document.createElement("tbody"),notes=[];
    lines.forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0],"未设置");td(tr,pair[1]);body.appendChild(tr);if(!pair[1]&&pair[2])notes.push(missingLine(r,pair[2]))});
    table.appendChild(body);box.appendChild(table);
    notes.filter(Boolean).forEach(function(s){box.appendChild(el("p","muted",s))});
    if(t.missing_fields&&t.missing_fields.length){
      box.appendChild(el("p","muted","缺字段："+t.missing_fields.map(function(x){return (x.label||x.name)+"("+(x.table||"shipping_plans")+"."+x.name+") 当前填充率 "+(x.fill_text||"未接入");}).join("；")+"。"));
    }
    if(t.can_download){
      var steps=document.createElement("ol");steps.className="steps";
      ["下载本票提单/签单资料和资料清单", "核对订舱号/SO号/提单号与当前票一致", "用清单里的真实入口人工登录海管家试走下载，不等货代微信转发"].forEach(function(s){steps.appendChild(el("li","",s))});
      box.appendChild(steps);
      box.appendChild(el("p","muted",(t.note||"已有真实 URL，可点击下载本票资料。")+"只读取系统已上传文件，不向外部平台发送数据；"+docCoverageText()+"。"));
    }
    else box.appendChild(el("p","muted","未接入 · 缺 "+docMissingText()+"；"+docRateText()+"。未接入条目不提供忽略。"));
  }
  function renderPlatformTrial(){
    var box=$("platformTrial");clear(box);
    var r=state.selected,docsReady=readyDocs(),entries=(state.platform&&state.platform.entries)||[];
    var hasPlatform=entries.some(function(x){return safeUrl(x.download_url)});
    var hasLogin=entries.some(function(x){return safeUrl(x.login_url)});
    var t=state.trial||{}, canTry=Boolean(r&&t.can_platform_download&&hasPlatform), canLogin=Boolean(r&&t.can_platform_login&&hasLogin);
    $("platformTrialPill").className="pill "+(canTry?"":(canLogin?"warn":"bad"));
    text($("platformTrialPill"),canTry?"可人工试走":(canLogin?"可登录核对":"未接入"));
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取 shipping_plans 记录；当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["本票",rowTitle(r)],
      ["订舱参考",r.booking_no||r.forwarder_booking_no||r.so_no],
      ["提单号",r.bl_no],
      ["系统资料",docsReady.length?("提单/签单 "+docsReady.length+" 份"):"未接入"],
      ["海管家登录入口",hasLogin?("真实入口 "+platformLoginLinks().length+" 个"):"未接入"],
      ["海管家下载入口",hasPlatform?("真实入口 "+entries.filter(function(x){return safeUrl(x.download_url)}).length+" 个"):"未接入"],
      ["平台匹配依据",hasPlatform?entries.filter(function(x){return safeUrl(x.download_url)}).map(matchedText).join("；"):"未接入"]
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0],"未设置");td(tr,pair[1]);body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
    if(canTry||canLogin){
      box.appendChild(el("p","muted",(t.note||"可人工登录海管家平台，用本票订舱参考核对后下载；")+"有 hgj_download_url 时可直接点“下载海管家资料”。系统资料未接入时仍按缺字段和填充率展示，不显示 0 或反推状态。页面只打开真实 URL，不自动登录、不发送订舱、不写费用或物流事实。"));
      if(canLogin&&!canTry)box.appendChild(el("p","muted","未接入 · 缺 booking_platform_integrations.hgj_download_url；当前填充率 "+platformRate("hgj_download_url")+"。可打开登录入口人工核对，但不显示平台已下载。"));
      return;
    }
    box.appendChild(el("p","muted","未接入 · 缺 "+(!docsReady.length?docMissingText()+"；":"")+(!hasPlatform?platformMissingText():"")+"。"));
    box.appendChild(el("p","muted","当前填充率：系统资料URL "+rateText(groupField("document_fields","file_url"))+"；海管家登录入口 "+platformRate("hgj_login_url")+"；海管家下载入口 "+platformRate("hgj_download_url")+"；"+platformRequiredText()+"。未接入条目不提供忽略。"));
  }
  function renderPlatform(){
    var box=$("platformState");clear(box);
    var s=state.platform||{}, fs=(state.coverage&&state.coverage.platform_fields)||[], entries=s.entries||[];
    var missing=(s.missing_fields||[]).map(function(x){return (x.label||x.name)+"("+(x.table||"booking_platform_integrations")+"."+x.name+")";}).join("、");
    if(!missing&&!Number(s.total_rows||0))missing="booking_platform_integrations 真实记录";
    var rates=fs.map(function(f){return f.name+" "+rateText(f);}).join("；");
    var ready=s.state==="ready"&&entries.some(function(x){return safeUrl(x.download_url)});
    var loginOnly=s.state==="login_only"&&entries.some(function(x){return safeUrl(x.login_url)});
    $("platformPill").className="pill "+(ready?"":(loginOnly?"warn":"bad"));text($("platformPill"),ready?"已有下载入口":(loginOnly?"仅登录入口":"未接入"));
    box.appendChild(el("p",ready||loginOnly?"muted":"bad",ready?"已有真实平台资料下载 URL":(loginOnly?"已有真实海管家登录入口，缺平台下载 URL":"未接入")));
    if(ready||loginOnly){
      var table=document.createElement("table"),body=document.createElement("tbody");
      entries.forEach(function(item){
        var href=safeUrl(item.download_url), login=safeUrl(item.login_url);if(!href&&!login)return;
        var tr=document.createElement("tr"), c1=document.createElement("td"), c2=document.createElement("td"), c3=document.createElement("td"), actions=el("div","doc-actions"), a=document.createElement("a");
        text(c1,item.account||"未设置");text(c2,[item.session_status||"未设置",item.downloaded_at||"未设置",matchedText(item)].join(" · "));
        if(login){var l=document.createElement("a");l.className="hgj-link";l.href=login;l.target="_blank";l.rel="noopener";l.textContent="登录入口";actions.appendChild(l)}
        if(href){a.className="hgj-link";a.href=href;a.target="_blank";a.rel="noopener";a.textContent="打开下载入口";actions.appendChild(a)}
        else actions.appendChild(el("span","muted","缺 hgj_download_url，当前填充率 "+platformRate("hgj_download_url")));
        c3.appendChild(actions);tr.appendChild(c1);tr.appendChild(c2);tr.appendChild(c3);body.appendChild(tr);
      });
      table.appendChild(body);box.appendChild(table);
      box.appendChild(el("p","muted",ready?"可从页面顶部直接下载本票海管家资料，或打开真实下载入口人工核对；只打开真实 URL，不自动登录、不发送订舱、不写下载次数。":"可从页面顶部打开海管家登录入口人工核对；缺下载 URL 时仍显示未接入，不显示 0 次下载。"));
    }
    box.appendChild(el("p","muted",s.note||"缺海管家账号、登录入口、下载入口和下载回执落库；当前只能下载系统已有提单/签单资料。"));
    box.appendChild(el("p","muted","缺字段："+(missing||"无")+"。当前填充率："+(rates||"未接入")+"。必需接入："+platformRequiredText()+"。"));
    box.appendChild(el("p","muted","未接入类条目不提供忽略；平台自动下载未接入时不显示 0 次下载，也不反推平台状态。"));
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var fs=fields();
    if(!fs.length){box.appendChild(el("div","empty","未接入 · 缺字段清单；当前填充率 未接入。"));return}
    fs.forEach(function(f){
      var d=el("div","field"), name=el("b","",f.label), meta=el("span","");
      var table=f.table||"shipping_plans";
      if(!f.total)text(meta,"未接入 · 缺可读取记录；当前填充率 未接入");
      else if(f.state==="not_connected"&&f.filled===null)text(meta,"未接入 · 缺 "+table+"."+f.name+"；当前填充率 未接入");
      else if(!Number(f.filled||0))text(meta,"未接入 · "+table+"."+f.name+" 当前无已填值；当前填充率 "+rateText(f));
      else if(f.state==="not_connected")text(meta,"未接入 · 缺 "+table+"."+f.name+"；当前填充率 未接入");
      else text(meta,table+"."+f.name+" · "+rateText(f));
      d.appendChild(name);d.appendChild(meta);box.appendChild(d);
    });
  }
  function renderChannel(){
    var box=$("channelState");clear(box);
    var s=state.channel||{}, missing=(s.missing_fields||[]).map(function(x){return x.label+"(shipping_plans."+x.name+")";}).join("、");
    var rates=((state.coverage&&state.coverage.channel_fields)||[]).map(function(f){return f.name+" "+rateText(f);}).join("；");
    box.appendChild(el("p","bad","未接入"));
    box.appendChild(el("p","muted",s.note||"缺订舱外部发送通道、通道状态字段和回执字段；本页只读。"));
    box.appendChild(el("p","muted",(missing?("缺字段："+missing):"缺外部发送接口/通道凭证/回执落库")+"。当前填充率："+(rates||"未接入")+"。"));
    box.appendChild(el("p","muted","未接入条目不提供忽略，也不会向货代或船公司发送订舱。"));
  }
  function render(){renderMetrics();renderList();renderDetail();renderDocs();renderTrial();renderPlatformTrial();renderPlatform();renderCoverage();renderChannel()}
  async function load(){
    try{
      syncQuery();
      var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;
      state.selectedKey=state.selected?rowKey(state.selected):"";
      state.coverage=d.coverage||null;state.channel=d.booking_channel||null;state.platform=d.platform_access||null;state.documents=d.documents||null;state.trial=d.trial||null;state.generatedAt=d.generated_at;state.version=d.version||state.version;render();
    }catch(e){$("summary").textContent=state.version+" · 读取失败 · 生成时间 "+new Date().toLocaleString("zh-CN");["list","detail","docs","trial","platformTrial","platformState","coverage","channelState"].forEach(function(id){clear($(id));$(id).appendChild(el("div","error",e.message))})}
  }
  $("list").addEventListener("click",function(e){
    var b=e.target.closest(".row");if(!b)return;
    var key=b.dataset.key;state.selectedKey=key;state.selected=state.rows.find(function(r){return rowKey(r)===key})||state.selected;render();load();
  });
  on("reload","click",load);
  on("nextTicket","click",function(){state.nextOnly=!state.nextOnly;load()});
  on("searchBtn","click",load);
  on("search","keydown",function(e){if(e.key==="Enter")load()});
  on("state","change",load);
  on("downloadAll","click",downloadAllDocs);
  on("downloadTrialPack","click",function(){
    if(window.BookingPlatformHgj)window.BookingPlatformHgj.downloadTrialPack(hgjPackContext());
  });
  on("downloadPlatformDocs","click",downloadPlatformDocs);
  on("openPlatform","click",openPlatformDownloads);
  on("manifestBtn","click",downloadManifest);
  on("openWb","click",function(){
    openWorkbench("订舱平台",currentUrl());
  });
  $("search").value=params.get("q")||"";
  $("state").value=params.get("state")||"";
  syncQuery();
  window.addEventListener("message",function(event){
    if(event.origin===location.origin&&event.data&&event.data.type==="sanlyn:module-refresh")load();
  });
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",protocol:"sanlyn:open-tab",module:"booking-platform",title:"订舱平台",url:location.pathname+location.search,version:state.version,accepts:["sanlyn:module-refresh"]},location.origin);
  load();
})();
