(function(){
  "use strict";
  var API="/api/db/cargo-info";
  var state={rows:[],selected:null,coverage:null,notConnected:[],generatedAt:null};
  var $=function(id){return document.getElementById(id);};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||"";}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h;}
  function clear(el){while(el.firstChild)el.removeChild(el.firstChild);}
  function text(el,v,fallback){el.textContent=v===null||v===undefined||v===""?(fallback||"未设置"):String(v);}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x;}
  function pct(filled,total){if(!total)return "未接入";return Math.round(Number(filled||0)*1000/Number(total))/10+"%";}
  function allFields(){var c=state.coverage||{};return [].concat(c.container_bookings||[],c.containers||[],c.order_containers||[]);}
  async function api(q){
    var r=await fetch(API+(q?"?q="+encodeURIComponent(q):""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"};});
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function fieldRate(name){
    var fs=allFields().filter(function(f){return f.name===name&&f.state==="ready";});
    if(!fs.length)return "未接入";
    var filled=fs.reduce(function(a,f){return a+Number(f.filled||0);},0);
    var total=fs.reduce(function(a,f){return a+Number(f.total||0);},0);
    return pct(filled,total);
  }
  function weightRate(){
    var names={cargo_weight_kg:1,tare_kg:1,vgm_kg:1,gross_weight_kg:1};
    var fs=allFields().filter(function(f){return names[f.name]&&f.state==="ready";});
    if(!fs.length)return "未接入";
    var filled=fs.reduce(function(a,f){return a+Number(f.filled||0);},0);
    var total=fs.reduce(function(a,f){return a+Number(f.total||0);},0);
    return pct(filled,total);
  }
  function renderMetrics(){
    var cov=state.coverage||{}, rows=Number(cov.total_rows||0);
    text($("mRows"),rows?rows:"未接入");
    text($("mBox"),fieldRate("container_no"));
    text($("mWeight"),weightRate());
    text($("mMissing"),rows?state.rows.reduce(function(a,r){return a+Number(r.missing_count||0);},0):"未接入");
    $("summary").textContent="生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function title(r){return r.container_no||r.bl_no||r.contract_no||("ID "+r.id);}
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 container_bookings/containers 真实记录；当前填充率 未接入。"));return;}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.source===state.selected.source&&r.id===state.selected.id?" active":""));
      b.type="button";b.dataset.id=r.source+":"+r.id;
      b.appendChild(el("strong","",title(r)));
      b.appendChild(el("span","",(r.source||"未接入")+" · BL "+(r.bl_no||"未设置")+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function td(tr,v){var c=document.createElement("td");text(c,v);tr.appendChild(c);}
  function renderDetail(){
    var box=$("detail");clear(box);
    var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取箱货记录，当前填充率 未接入。"));text($("readyPill"),"未接入");return;}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["箱号",r.container_no],["封号",r.seal_no],["箱型",r.container_type],["提单号",r.bl_no],
      ["订舱号",r.booking_no],["合同/订单号",r.contract_no],["货重kg",r.cargo_weight_kg],
      ["皮重kg",r.tare_kg],["VGMkg",r.vgm_kg],["毛重kg",r.gross_weight_kg],
      ["体积CBM",r.total_cbm||r.cbm],["箱数",r.ctn_count],["车牌",r.truck_plate],
      ["司机",r.driver_name],["司机电话",r.driver_phone],["装货地址",r.loading_address],
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1]);body.appendChild(tr);});
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length){
      box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.table+"."+x.name+"("+x.label+")";}).join("、")));
    }
    text($("readyPill"),r.missing_count?"待补字段":"字段已填");
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);
    var fields=allFields();
    if(!fields.length){box.appendChild(el("div","empty","未接入 · 缺字段清单；当前填充率 未接入。"));return;}
    fields.forEach(function(f){
      var d=el("div","field"),name=el("b","",f.label),meta=el("span","");
      if(f.state==="not_connected")text(meta,"未接入 · 缺 "+f.table+"."+f.name+"；当前填充率 未接入");
      else text(meta,f.table+"."+f.name+" · "+f.filled+"/"+f.total+" · "+pct(f.filled,f.total));
      d.appendChild(name);d.appendChild(meta);box.appendChild(d);
    });
  }
  function renderNotConnected(){
    var box=$("notConnected");clear(box);
    var missing=allFields().filter(function(f){return f.state==="not_connected";}).map(function(f){return f.table+"."+f.name;});
    if(state.notConnected.length) box.appendChild(el("p","bad",state.notConnected.join("；")));
    box.appendChild(el("p","muted","未接入类条目不提供忽略操作，也不写任何业务事实表。"));
    box.appendChild(el("p","muted","缺字段："+(missing.join("、")||"无缺表字段")+"。当前填充率："+(missing.length?"未接入":"见上方字段卡片")+"。"));
  }
  function render(){renderMetrics();renderList();renderDetail();renderCoverage();renderNotConnected();}
  async function load(){
    try{
      var d=await api($("search").value.trim());
      state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage||null;
      state.notConnected=d.not_connected||[];state.generatedAt=d.generated_at;render();
    }catch(e){$("summary").textContent="读取失败";clear($("list"));$("list").appendChild(el("div","error",e.message));}
  }
  $("list").addEventListener("click",function(e){
    var b=e.target.closest(".row");if(!b)return;
    var key=b.dataset.id;state.selected=state.rows.find(function(r){return r.source+":"+r.id===key;})||state.selected;render();
  });
  $("reload").addEventListener("click",load);
  $("search").addEventListener("keydown",function(e){if(e.key==="Enter")load();});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"箱货信息",url:location.pathname},location.origin);
  load();
})();
