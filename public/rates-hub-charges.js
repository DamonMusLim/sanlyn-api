(function(){
  var tariffFields=["carrier","port","container_type","charge_item_code","charge_item_name","amount_cny","unit_basis","required_flag","conditional_flag","station_name","valid_from","valid_to","review_status"];
  var matrixFields=["code","forwarder_company_id","carrier_code","pol","pod","bl_type","free_days_origin","free_days_dest","total_cost_20gp","total_cost_40hq","cost_currency","is_active","valid_from","valid_to"];
  var itemFields=["matrix_code","charge_name","currency","unit","container_type","unit_price","qty","amount","is_required","sort_order"];
  var localFields=["carrier","pol","pod","company_name","container_type","charge_name","amount","currency","cost_total","sell_total","base_total_cny","markup_cny","valid_from","valid_until","is_active","free_time"];
  var numberFields={amount_cny:1,forwarder_company_id:1,free_days_origin:1,free_days_dest:1,total_cost_20gp:1,total_cost_40hq:1,unit_price:1,qty:1,amount:1,sort_order:1,cost_total:1,sell_total:1,base_total_cny:1,markup_cny:1};
  var boolFields={required_flag:1,conditional_flag:1,is_active:1,is_required:1};
  var endpoints={tariff:"/api/db/carrier-tariff",matrix:"/api/db/port-charge-matrices",item:"/api/db/port-charge-matrices",local:"/api/db/local-charges"};

  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
  function attr(s){return esc(s).replace(/'/g,"&#39;");}
  function blank(v){return v===null||v===undefined||v==="";}
  function cell(v){return blank(v)?'<span class="na">未设置</span>':esc(v);}
  function money(v){if(blank(v))return '<span class="na">未设置</span>';var n=Number(v);return Number.isFinite(n)?n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}):esc(v);}
  function validText(r){var a=r.valid_from||"",b=r.valid_to||r.valid_until||"";return (a||"")+(a||b?" ~ ":"")+(b||"");}
  function feeName(r){return [r.charge_item_code,r.charge_item_name].filter(Boolean).join(" · ");}
  function flagText(r){return r.required_flag?"必收":(r.conditional_flag?"条件":"未设置");}
  function freeText(v){if(blank(v))return "";if(typeof v==="object")return JSON.stringify(v);return v;}
  function yes(v){return v===true?"是":(v===false?"否":'<span class="na">未设置</span>');}
  function countText(rows,unit,key){return rows.length?esc(rows.length+" "+unit):(window.disconnectedText?esc(window.disconnectedText(key)):"未接入");}
  function panel(title,rows,unit,key,body){var kind=key==="matrices"?"matrix":key,canAdd=key!=="tariff";return '<section class="hgj-card section"><div class="section-head"><h2 class="hgj-panel-title">'+esc(title)+'</h2><span class="mini">'+countText(rows,unit,key)+'</span>'+(canAdd?'<button type="button" data-charge-new="'+attr(kind)+'">新增</button>':"")+'</div>'+body+"</section>";}
  function tariffNote(){return '<div class="mini" style="padding:0 14px 10px;color:#6b7280;">官方费率是船司标准基线，只做确认与停用；调价请重传新版本，不在这里改金额。</div>';}
  function empty(key,span){return '<tr><td colspan="'+span+'"><div class="empty">'+(window.emptyState?window.emptyState(key,"",[]):"未接入")+"</div></td></tr>";}
  function value(r,k){
    if(k==="valid")return cell(validText(r));
    if(k==="fee")return cell(feeName(r));
    if(k==="flag")return cell(flagText(r));
    if(k==="free_time")return cell(freeText(r[k]));
    if(k==="is_active"||k==="is_required")return yes(r[k]);
    if(["amount_cny","total_cost_20gp","total_cost_40hq","unit_price","amount","cost_total","sell_total","markup_cny"].indexOf(k)>=0)return money(r[k]);
    return cell(r[k]);
  }
  function rowActions(kind,id,extra){
    var key=kind==="matrix"?"code":"id";
    return '<span class="row-actions"><button class="linkbtn" type="button" data-charge-detail="'+attr(kind)+'" data-'+key+'="'+attr(id)+'">详情</button><button class="mini-btn danger" type="button" data-charge-void="'+attr(kind)+'" data-'+key+'="'+attr(id)+'" '+(extra||"")+'>作废</button></span>';
  }
  function tariffActions(r){
    var confirm=String(r.review_status||"")==="pending"?'<button class="linkbtn" type="button" data-tariff-confirm="'+attr(r.id)+'">确认</button>':"";
    return '<span class="row-actions">'+confirm+'<button class="mini-btn danger" type="button" data-tariff-expire="'+attr(r.id)+'">停用</button></span>';
  }
  function table(key,rows,cols,kind){
    var cs=cols.concat([["_actions","操作"]]),html='<div class="table-wrap"><table><thead><tr>'+cs.map(function(c){return "<th>"+esc(c[1])+"</th>";}).join("")+"</tr></thead><tbody>";
    if(kind!=="tariff")html+=editorRow(kind,{},cs.length,"new");
    if(!rows.length)return html+empty(key,cs.length)+"</tbody></table></div>";
    rows.forEach(function(r){html+="<tr>"+cs.map(function(c){var k=c[0],v=k==="_actions"?(kind==="tariff"?tariffActions(r):rowActions(kind,kind==="matrix"?r.code:r.id)):value(r,k);return '<td'+(c[2]==="num"?' class="num"':"")+">"+v+"</td>";}).join("")+"</tr>"+(kind==="tariff"?"":editorRow(kind,r,cs.length));});
    return html+"</tbody></table></div>";
  }
  function matrixTable(){
    var rows=window.state.data.matrices||[],itemsBy={};
    (window.state.data.matrix_items||[]).forEach(function(i){(itemsBy[i.matrix_code]=itemsBy[i.matrix_code]||[]).push(i);});
    var cs=window.cols.matrices.concat([["_actions","操作"]]),ics=window.cols.matrix_items.concat([["_actions","操作"]]);
    var html='<div class="table-wrap"><table><thead><tr>'+cs.map(function(c){return "<th>"+esc(c[1])+"</th>";}).join("")+"</tr></thead><tbody>";
    html+=editorRow("matrix",{},cs.length,"new");
    if(!rows.length)return html+empty("matrices",cs.length)+"</tbody></table></div>";
    rows.forEach(function(r){
      html+="<tr>"+cs.map(function(c,i){var k=c[0],v=k==="_actions"?rowActions("matrix",r.code):(i===0?'<button class="linkbtn" data-matrix="'+attr(r.code)+'">'+(window.state.expanded[r.code]?"收起":"展开")+"</button> "+cell(r.code):value(r,k));return '<td'+(c[2]==="num"?' class="num"':"")+">"+v+"</td>";}).join("")+"</tr>"+editorRow("matrix",r,cs.length);
      if(window.state.expanded[r.code])html+=itemBlock(r,itemsBy[r.code]||[],ics,cs.length);
    });
    return html+"</tbody></table></div>";
  }
  function itemBlock(matrix,items,ics,span){
    var html='<tr><td colspan="'+span+'"><div class="table-wrap"><table><thead><tr>'+ics.map(function(c){return "<th>"+esc(c[1])+"</th>";}).join("")+"</tr></thead><tbody>";
    if(!items.length)html+='<tr><td colspan="'+ics.length+'"><span class="na">未添加明细</span></td></tr>';
    items.forEach(function(r){html+="<tr>"+ics.map(function(c){var k=c[0],v=k==="_actions"?rowActions("item",r.id):value(r,k);return '<td'+(c[2]==="num"?' class="num"':"")+">"+v+"</td>";}).join("")+"</tr>"+editorRow("item",r,ics.length);});
    var add=window.state.expanded[editKey("item",{matrix_code:matrix.code})]?editorPanel("item",{matrix_code:matrix.code}):"";
    return html+'</tbody></table></div><button type="button" data-charge-new="item" data-matrix-code="'+attr(matrix.code)+'">新增明细</button>'+add+"</td></tr>";
  }
  function editKey(kind,row,force){return "edit:"+kind+":"+(force||((kind==="matrix"?row.code:(row.id||row.matrix_code))||"new"));}
  function editorRow(kind,row,span,force){
    var open=window.state.expanded[editKey(kind,row,force)];
    if(!open)return "";
    return '<tr class="charge-editor"><td colspan="'+span+'">'+editorPanel(kind,row,false)+'</td></tr>';
  }
  function editorPanel(kind,row){
    var fields=kind==="tariff"?tariffFields:(kind==="matrix"?matrixFields:(kind==="item"?itemFields:localFields));
    return '<div class="charge-editor"><div class="drawer-grid">'+fields.map(function(f){return fieldHtml(f,row[f]);}).join("")+'</div><div class="row-actions"><button class="primary" type="button" data-charge-save="'+attr(kind)+'" data-id="'+attr(row.id||"")+'" data-code="'+attr(row.code||"")+'">保存</button></div><div class="drawer-error" hidden></div></div>';
  }
  function fieldHtml(name,value){
    if(boolFields[name])return '<div class="drawer-field"><label>'+esc(name)+'</label><select name="'+attr(name)+'"><option value="">未设置</option><option value="true"'+(value===true?" selected":"")+'>是</option><option value="false"'+(value===false?" selected":"")+'>否</option></select></div>';
    var type=name.indexOf("valid_")===0?"date":(numberFields[name]?"number":"text");
    return '<div class="drawer-field"><label>'+esc(name)+'</label><input name="'+attr(name)+'" type="'+type+'" value="'+attr(value==null?"":String(value).slice(0,type==="date"?10:999))+'"></div>';
  }
  function payloadFrom(scope,kind){
    var fields=kind==="tariff"?tariffFields:(kind==="matrix"?matrixFields:(kind==="item"?itemFields:localFields)),out={};
    fields.forEach(function(f){var el=scope.querySelector("[name='"+f+"']"),v=el?el.value:"";if(v==="")return;out[f]=boolFields[f]?v==="true":(numberFields[f]?Number(v):v);});
    if(kind==="matrix"||kind==="item")out.kind=kind;
    return out;
  }
  function token(){return window.SanlynTable.token();}
  async function save(btn){
    var kind=btn.dataset.chargeSave,row=btn.closest(".charge-editor"),payload=payloadFrom(row,kind),method=btn.dataset.id||btn.dataset.code?"PATCH":"POST";
    if(btn.dataset.id)payload.id=btn.dataset.id;if(btn.dataset.code)payload.code=btn.dataset.code;
    try{var r=await fetch(endpoints[kind],{method:method,headers:{Authorization:"Bearer "+token(),"Content-Type":"application/json"},body:JSON.stringify(payload)}),j=await r.json().catch(function(){return {};});if(!r.ok||j.success===false)throw new Error(j.error||("HTTP "+r.status));window.load();}
    catch(e){var box=row.querySelector(".drawer-error");box.hidden=false;box.textContent=e.message;}
  }
  async function voidRow(kind,id){
    if(!confirm("确认作废？"))return;
    var payload=kind==="tariff"?{id:id,is_active:false}:(kind==="local"?{id:id,is_active:false}:(kind==="matrix"?{kind:"matrix",code:id,deleted:true}:{kind:"item",id:id,deleted:true}));
    try{var r=await fetch(endpoints[kind],{method:"PATCH",headers:{Authorization:"Bearer "+token(),"Content-Type":"application/json"},body:JSON.stringify(payload)}),j=await r.json().catch(function(){return {};});if(!r.ok||j.success===false)throw new Error(j.error||("HTTP "+r.status));window.load();}
    catch(e){alert("作废失败："+e.message);}
  }
  async function confirmTariff(id){
    try{var r=await fetch(endpoints.tariff,{method:"POST",headers:{Authorization:"Bearer "+token(),"Content-Type":"application/json"},body:JSON.stringify({action:"confirm_standards",ids:[id]})}),j=await r.json().catch(function(){return {};});if(!r.ok||j.success===false)throw new Error(j.error||("HTTP "+r.status));window.load();}
    catch(e){alert("确认失败："+e.message);}
  }
  function dateDialog(defaultDate){
    return new Promise(function(resolve){
      var wrap=document.createElement("div");
      wrap.style.cssText="position:fixed;inset:0;background:rgba(17,24,39,.35);display:flex;align-items:center;justify-content:center;z-index:9999;";
      wrap.innerHTML='<div style="background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:16px;min-width:280px;box-shadow:0 12px 30px rgba(0,0,0,.18);"><label style="display:block;font-size:13px;font-weight:700;color:#374151;margin-bottom:8px;">停用日期</label><input type="date" value="'+attr(defaultDate)+'" style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:8px;font-size:14px;"><div class="row-actions" style="justify-content:flex-end;margin-top:12px;"><button type="button" data-cancel>取消</button><button type="button" class="primary" data-ok>确认</button></div></div>';
      function close(v){document.body.removeChild(wrap);resolve(v);}
      wrap.querySelector("[data-cancel]").onclick=function(){close(null);};
      wrap.querySelector("[data-ok]").onclick=function(){close(wrap.querySelector("input").value||defaultDate);};
      wrap.onclick=function(e){if(e.target===wrap)close(null);};
      document.body.appendChild(wrap);
      wrap.querySelector("input").focus();
    });
  }
  async function expireTariff(id){
    var today=new Date().toISOString().slice(0,10),validTo=await dateDialog(today);
    if(validTo===null)return;
    try{var r=await fetch(endpoints.tariff,{method:"PATCH",headers:{Authorization:"Bearer "+token(),"Content-Type":"application/json"},body:JSON.stringify({action:"expire_standard",id:id,valid_to:validTo})}),j=await r.json().catch(function(){return {};});if(!r.ok||j.success===false)throw new Error(j.error||("HTTP "+r.status));window.load();}
    catch(e){alert("停用失败："+e.message);}
  }
  function toggle(kind,id){var k="edit:"+kind+":"+id;window.state.expanded[k]=!window.state.expanded[k];window.draw();}
  function render(){
    var d=window.state.data;
    window.$("content").innerHTML='<div class="sections">'+panel("官方费率",d.tariff||[],"行","tariff",tariffNote()+table("tariff",d.tariff||[],window.cols.tariff,"tariff"))+panel("货代实报套餐",d.matrices||[],"套餐","matrices",matrixTable())+panel("本地费",d.local||[],"行","local",table("local",d.local||[],window.cols.local,"local"))+"</div>";
    window.statParts([["官方",d.tariff||[],"tariff"],["套餐",d.matrices||[],"matrices"],["本地",d.local||[],"local"]]);window.renderDashboard();
  }
  function handleClick(e){
    var n=e.target.closest("[data-charge-new]");if(n){toggle(n.dataset.chargeNew,n.dataset.matrixCode||"new");return true;}
    var d=e.target.closest("[data-charge-detail]");if(d){toggle(d.dataset.chargeDetail,d.dataset.code||d.dataset.id);return true;}
    var s=e.target.closest("[data-charge-save]");if(s){save(s);return true;}
    var v=e.target.closest("[data-charge-void]");if(v){voidRow(v.dataset.chargeVoid,v.dataset.code||v.dataset.id);return true;}
    var c=e.target.closest("[data-tariff-confirm]");if(c){confirmTariff(c.dataset.tariffConfirm);return true;}
    var x=e.target.closest("[data-tariff-expire]");if(x){expireTariff(x.dataset.tariffExpire);return true;}
    return false;
  }
  window.RatesHubCharges={render:render,handleClick:handleClick};
})();
