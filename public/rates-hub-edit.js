(function(){
  var api=null,root=null,current=null;
  var fields=[
    {name:"pol",label:"POL *",group:"route"},
    {name:"pod",label:"POD *",group:"route"},
    {name:"carrier",label:"船公司 Carrier",group:"route"},
    {name:"forwarder",label:"货代 Forwarder",group:"route"},
    {name:"route_code",label:"航线代码 Route Code",group:"route"},
    {name:"via",label:"中转 Via",group:"route"},
    {name:"transit_days",label:"航程天数",type:"number",group:"route"},
    {name:"freetime",label:"免箱期 Free Time",group:"route"},
    {name:"gp20",label:"20GP 成本",type:"number",group:"cost"},
    {name:"hq40",label:"40HQ 成本",type:"number",group:"cost"},
    {name:"thc",label:"THC 港杂",type:"number",group:"cost"},
    {name:"local_charge_code",label:"本地费代码",group:"cost"},
    {name:"customer_gp20",label:"20GP 报价",type:"number",group:"quote"},
    {name:"customer_hq40",label:"40HQ 报价",type:"number",group:"quote"},
    {name:"rf20",label:"20RF 成本",type:"number",group:"reefer"},
    {name:"rh40",label:"40RH 成本",type:"number",group:"reefer"},
    {name:"customer_rf20",label:"20RF 客户价",type:"number",group:"reefer"},
    {name:"customer_rh40",label:"40RH 客户价",type:"number",group:"reefer"},
    {name:"reefer_temp_c",label:"设定温度℃",type:"number",group:"reefer",placeholder:"冷冻 -18 / 冷藏 0~4"},
    {name:"valid_from",label:"有效期起",type:"date",group:"quote"},
    {name:"valid_to",label:"有效期止",type:"date",group:"quote"},
    {name:"remarks",label:"备注",type:"textarea",group:"quote",full:true},
    {name:"markup_sales",label:"业务员加价",type:"number",group:"rules"},
    {name:"markup_customer",label:"客户加价",type:"number",group:"rules"},
    {name:"min_container_qty",label:"最低箱量",type:"number",group:"rules"},
    {name:"payment_method",label:"付款方式",group:"rules",options:["FREIGHT PREPAID","FREIGHT COLLECT"]},
    {name:"applicable_commodity",label:"适用品名",group:"rules"},
    {name:"space_status",label:"舱位情况",group:"rules",options:["充足","无舱位","爆舱"]}
  ];
  var groupNames={route:"航线 / Route",cost:"成本价 / Carrier Cost (内部)",quote:"客户报价 / Customer Quote",reefer:"冷冻柜 / Reefer",rules:"报价规则 / Quote Rules"};
  var numeric={gp20:1,hq40:1,thc:1,customer_gp20:1,customer_hq40:1,rf20:1,rh40:1,customer_rf20:1,customer_rh40:1,reefer_temp_c:1,transit_days:1,markup_sales:1,markup_customer:1,min_container_qty:1};
  var aliases={route_code:["routeCode"],customer_gp20:["customerGp20"],customer_hq40:["customerHq40"],valid_from:["validFrom"],valid_to:["validTo"],transit_days:["transitDays"],local_charge_code:["localChargeCode"]};
  var mainBoxes={"20GP":1,"40HQ":1,"20RF":1,"40RH":1};

  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
  function attr(s){return esc(s).replace(/'/g,"&#39;");}
  function val(row,name){
    if(!row)return "";
    if(row[name]!=null)return row[name];
    var a=aliases[name]||[];
    for(var i=0;i<a.length;i++)if(row[a[i]]!=null)return row[a[i]];
    return "";
  }
  function emptyForm(){var f={};fields.forEach(function(x){f[x.name]=""});return f;}
  function formFromRow(row){var f=emptyForm();fields.forEach(function(x){var n=x.name,v=(n==="pol"?val(row,"pol_raw"):(n==="pod"?val(row,"pod_raw"):val(row,n)));if((n==="pol"||n==="pod")&&v==="")v=val(row,n);f[n]=v==null?"":String(v).slice(0,x.type==="date"?10:999);});return f;}
  function formValues(){var out={};fields.forEach(function(x){var el=root.querySelector("[name='"+x.name+"']");out[x.name]=el?el.value:"";});return out;}
  function toPayload(form,initial){
    var out={};
    fields.forEach(function(x){
      if(initial&&String(initial[x.name]||"")===String(form[x.name]||""))return;
      var v=form[x.name];
      if(v==="")out[x.name]=null;
      else out[x.name]=numeric[x.name]?Number(v):v;
    });
    return out;
  }
  function changed(a,b){
    return fields.some(function(x){return String(a[x.name]||"")!==String(b[x.name]||"");});
  }
  function authHeaders(json){
    var h={Authorization:"Bearer "+api.token()};
    if(json)h["Content-Type"]="application/json";
    return h;
  }
  function showError(msg){
    var box=root.querySelector(".drawer-error");
    if(box){box.hidden=false;box.textContent=msg;}
  }
  function localChargeOptions(){return api&&api.localChargeOptions?api.localChargeOptions():[];}
  function fixedSelect(name,value,options){
    var v=norm(value),has=!v;
    var html='<select name="'+attr(name)+'"><option value="">未设置</option>';
    options.forEach(function(x){if(x===v)has=true;html+='<option value="'+attr(x)+'"'+(x===v?" selected":"")+">"+esc(x)+"</option>";});
    if(v&&!has)html+='<option value="'+attr(v)+'" selected>'+esc(v)+'</option>';
    return html+"</select>";
  }
  function localChargeSelect(name,value){
    var opts=localChargeOptions();
    if(!opts.length)return null;
    return '<select name="'+attr(name)+'"><option value="">未设置</option>'+opts.map(function(o){
      var v=o.charge_code||"",t=[o.charge_code,o.carrier,o.pol,o.container_type].filter(Boolean).join(" · ");
      return '<option value="'+attr(v)+'"'+(String(value||"")===String(v)?" selected":"")+">"+esc(t||v)+"</option>";
    }).join("")+"</select>";
  }
  function data(){return (window.state&&window.state.data)||{};}
  function norm(v){return String(v==null?"":v).trim();}
  function sortVals(a){return a.sort(function(x,y){return x.localeCompare(y,"zh-CN");});}
  function unique(items){
    var seen={},out=[];
    items.forEach(function(v){v=norm(v);if(!v||seen[v])return;seen[v]=1;out.push(v);});
    return sortVals(out);
  }
  function diffVals(items,used){return items.filter(function(v){return !used[v];});}
  function portGroups(name,value){
    var d=data(),used={},rate=unique((d.ocean||[]).map(function(r){return r[name];}));
    rate.forEach(function(v){used[v]=1;});
    var sail=unique((d.sailing_lanes||[]).map(function(r){return r[name];}));
    sail=diffVals(sail,used);sail.forEach(function(v){used[v]=1;});
    var master=unique((d.port_options||[]).map(function(p){return p.name_en;}));
    master=diffVals(master,used);
    return groupsWithCurrent([["本航线已有",rate],["维运网有船期",sail],["港口主数据",master]],value);
  }
  function carrierGroups(value){
    var d=data(),rate=[],sail=[];
    (d.carrier_options||[]).forEach(function(o){(o.source==="rate"?rate:sail).push(o.carrier);});
    return groupsWithCurrent([["本航线已有",unique(rate)],["维运网有船期",unique(sail)]],value);
  }
  function forwarderGroups(value){
    var d=data();
    return groupsWithCurrent([["已报过价",unique((d.forwarder_options||[]).map(function(o){return o.forwarder;}))]],value);
  }
  function groupsWithCurrent(groups,value){
    var v=norm(value),seen={},has=false;
    groups.forEach(function(g){g[1].forEach(function(x){seen[x]=1;if(x===v)has=true;});});
    if(v&&!has)groups.unshift(["当前值",[v]]);
    return groups.filter(function(g){return g[1].length;});
  }
  function choiceGroups(name,value){
    if(name==="pol"||name==="pod")return portGroups(name,value);
    if(name==="carrier")return carrierGroups(value);
    if(name==="forwarder")return forwarderGroups(value);
    return [];
  }
  function choiceSelect(name,value){
    var groups=choiceGroups(name,value),v=norm(value),has=false;
    if(!groups.length)return null;
    groups.forEach(function(g){g[1].forEach(function(x){if(x===v)has=true;});});
    var html='<select data-rate-choice="'+attr(name)+'"><option value="">未设置</option>';
    groups.forEach(function(g){html+='<optgroup label="'+attr(g[0])+'">'+g[1].map(function(x){return '<option value="'+attr(x)+'"'+(x===v?" selected":"")+">"+esc(x)+"</option>";}).join("")+"</optgroup>";});
    html+='<option value="__other__"'+(v&&!has?" selected":"")+'>其它(手工填写)</option></select>';
    return html+'<input name="'+attr(name)+'" type="'+(v&&!has?"text":"hidden")+'" value="'+attr(value)+'">';
  }
  function syncChoice(el){
    var name=el.dataset.rateChoice,input=root.querySelector("input[name='"+name+"']");
    if(!input)return;
    if(el.value==="__other__"){input.type="text";input.focus();return;}
    input.type="hidden";input.value=el.value;
  }
  function sectionHtml(group,form){
    return '<section class="drawer-section"><h3>'+esc(groupNames[group])+'</h3><div class="drawer-grid">'+fields.filter(function(x){return x.group===group;}).map(function(x){
      var cls="drawer-field"+(x.full?" full":"");
      if(x.type==="textarea")return '<div class="'+cls+'"><label>'+esc(x.label)+'</label><textarea name="'+attr(x.name)+'">'+esc(form[x.name])+'</textarea></div>';
      if(x.options)return '<div class="'+cls+'"><label>'+esc(x.label)+'</label>'+fixedSelect(x.name,form[x.name],x.options)+'</div>';
      if(x.name==="local_charge_code"){var select=localChargeSelect(x.name,form[x.name]);if(select)return '<div class="'+cls+'"><label>'+esc(x.label)+'</label>'+select+'</div>';}
      if(x.name==="pol"||x.name==="pod"||x.name==="carrier"||x.name==="forwarder"){var choice=choiceSelect(x.name,form[x.name]);if(choice)return '<div class="'+cls+'"><label>'+esc(x.label)+'</label>'+choice+'</div>';}
      return '<div class="'+cls+'"><label>'+esc(x.label)+'</label><input name="'+attr(x.name)+'" type="'+attr(x.type||"text")+'" value="'+attr(form[x.name])+'"'+(x.placeholder?' placeholder="'+attr(x.placeholder)+'"':"")+"></div>";
    }).join("")+'</div></section>';
  }
  function boxRows(){return current&&current.row&&Array.isArray(current.row.boxes)?current.row.boxes:[];}
  function boxOptions(){
    var used={};boxRows().forEach(function(b){used[norm(b.container_type)]=1;});
    return ((data().container_type_options)||[]).filter(function(o){var c=norm(o.code);return c&&!mainBoxes[c]&&!used[c];});
  }
  function boxSelect(name){
    var opts=boxOptions(),groups=[["常用",opts.filter(function(o){return o.is_common===true;})],["全部",opts.filter(function(o){return o.is_common!==true;})]];
    var html='<select name="'+attr(name)+'"><option value="">选择箱型</option>';
    groups.forEach(function(g){if(!g[1].length)return;html+='<optgroup label="'+attr(g[0])+'">'+g[1].map(function(o){return '<option value="'+attr(o.code)+'">'+esc(o.code+" · "+(o.name_cn||""))+"</option>";}).join("")+"</optgroup>";});
    return html+"</select>";
  }
  function boxesHtml(){
    if(!current||current.mode!=="edit")return '<section class="drawer-section"><h3>其它箱型 / More Box Types</h3><p class="na">保存后可添加其它箱型</p></section>';
    var rows=boxRows(),html='<section class="drawer-section" data-box-section><h3>其它箱型 / More Box Types</h3><div class="table-wrap"><table><thead><tr><th>箱型</th><th>成本</th><th>客户价</th><th>备注</th><th>操作</th></tr></thead><tbody>';
    if(!rows.length)html+='<tr><td colspan="5"><span class="na">未添加其它箱型</span></td></tr>';
    rows.forEach(function(b){
      html+='<tr><td>'+cellBox(b.container_type)+'</td><td><input data-box-field="cost" data-box-id="'+attr(b.id)+'" type="number" value="'+attr(b.cost)+'"></td><td><input data-box-field="customer_price" data-box-id="'+attr(b.id)+'" type="number" value="'+attr(b.customer_price)+'"></td><td><input data-box-field="remarks" data-box-id="'+attr(b.id)+'" value="'+attr(b.remarks)+'"></td><td><button class="mini-btn danger" type="button" data-box-delete="'+attr(b.id)+'">删除</button></td></tr>';
    });
    html+='</tbody></table></div><div class="box-add" hidden data-box-add-row>'+boxSelect("box_container_type")+'<input name="box_cost" type="number" placeholder="成本"><input name="box_customer_price" type="number" placeholder="客户价"><input name="box_remarks" placeholder="备注"><button class="primary" type="button" data-box-create="1">添加</button></div><button type="button" data-box-add="1" '+(boxOptions().length?"":"hidden")+'>+ 添加箱型</button></section>';
    return html;
  }
  function cellBox(v){return blankBox(v)?'<span class="na">未设置</span>':esc(v);}
  function blankBox(v){return v===null||v===undefined||v==="";}
  function updateBoxesSection(){
    var old=root.querySelector("[data-box-section]");
    if(old)old.outerHTML=boxesHtml();
  }
  function boxPayload(row){
    var out={};
    ["cost","customer_price","remarks"].forEach(function(k){var v=row[k];out[k]=v===""?null:(k==="remarks"?v:Number(v));});
    return out;
  }
  async function sendBox(method,payload){
    var r=await fetch("/api/db/freight-rate-boxes",{method:method,headers:authHeaders(true),body:JSON.stringify(payload)});
    var j=await r.json().catch(function(){return {};});
    if(!r.ok||j.success===false)throw new Error(j.error||("HTTP "+r.status));
    return j;
  }
  async function patchBox(el){
    var id=el.dataset.boxId,box=boxRows().find(function(b){return String(b.id)===String(id);});
    if(!box)return;
    var payload={id:id};payload[el.dataset.boxField]=el.value===""?null:(el.dataset.boxField==="remarks"?el.value:Number(el.value));
    try{await sendBox("PATCH",payload);box[el.dataset.boxField]=payload[el.dataset.boxField];api.refresh();}
    catch(e){showError(e.message);}
  }
  async function createBox(btn){
    var wrap=btn.closest("[data-box-add-row]");if(!wrap||!current||!current.row.id)return;
    var payload={rate_id:current.row.id,container_type:wrap.querySelector("[name='box_container_type']").value};
    ["cost","customer_price","remarks"].forEach(function(k){var el=wrap.querySelector("[name='box_"+k+"']"),v=el?el.value:"";if(v!=="")payload[k]=k==="remarks"?v:Number(v);});
    if(!payload.container_type){showError("请选择箱型");return;}
    try{var j=await sendBox("POST",payload);current.row.boxes=boxRows().concat([j.data||payload]);api.refresh();updateBoxesSection();}
    catch(e){showError(e.message);}
  }
  async function deleteBox(id){
    if(!id||!confirm("确认删除这个箱型？"))return;
    try{await sendBox("DELETE",{id:id});current.row.boxes=boxRows().filter(function(b){return String(b.id)!==String(id);});api.refresh();updateBoxesSection();}
    catch(e){showError(e.message);}
  }
  function drawerHtml(mode,row){
    var form=mode==="new"?emptyForm():formFromRow(row);
    var title=mode==="new"?"新增海运费率":((row.pol||"未设置")+" -> "+(row.pod||"未设置"));
    var sub=mode==="new"?"New Freight Rate":("ID #"+row.id+" · "+(row.carrier||""));
    return '<div class="drawer-mask" data-rate-close="1"></div><aside class="rate-drawer" role="dialog" aria-modal="true">'+
      '<div class="drawer-head"><button type="button" data-rate-close="1">关闭</button><div class="drawer-title"><b>'+esc(title)+'</b><span>'+esc(sub)+'</span></div>'+
      (mode==="new"?'<button class="primary" type="button" data-rate-save="1">保存</button>':'<span class="dirty-actions" hidden><button type="button" data-rate-cancel="1">取消</button> <button class="primary" type="button" data-rate-save="1">保存</button></span>')+'</div>'+
      '<div class="drawer-body"><div class="drawer-error" hidden></div>'+sectionHtml("route",form)+sectionHtml("cost",form)+sectionHtml("quote",form)+sectionHtml("reefer",form)+boxesHtml()+sectionHtml("rules",form)+'</div>'+
      '<div class="drawer-foot">'+(mode==="new"?'<button type="button" data-rate-close="1">取消</button><button class="primary" type="button" data-rate-save="1">保存</button>':'<span class="dirty-actions" hidden><button type="button" data-rate-cancel="1">取消</button><button class="primary" type="button" data-rate-save="1">保存</button></span>')+'</div></aside>';
  }
  function open(mode,row){
    current={mode:mode,row:row||{},initial:mode==="new"?emptyForm():formFromRow(row||{})};
    root.innerHTML=drawerHtml(mode,row||{});
    root.querySelectorAll("input,textarea,select").forEach(function(el){el.addEventListener("input",markDirty);el.addEventListener("change",markDirty);});
  }
  function close(){current=null;root.innerHTML="";}
  function markDirty(){
    if(!current||current.mode==="new")return;
    var isDirty=changed(current.initial,formValues());
    root.querySelectorAll(".dirty-actions").forEach(function(x){x.hidden=!isDirty;});
  }
  async function save(){
    if(!current)return;
    var form=formValues();
    if(!form.pol.trim()||!form.pod.trim()){showError("POL 和 POD 必填。");return;}
    if(!form.forwarder.trim()){showError("货代必填");return;}
    var payload=toPayload(form,current.mode==="edit"?current.initial:null);
    if(current.mode==="edit"){
      payload.id=current.row.id;
      if(!changed(current.initial,form))return;
    }
    var btns=root.querySelectorAll("[data-rate-save]");
    btns.forEach(function(b){b.disabled=true;b.textContent="保存中...";});
    try{
      var r=await fetch("/api/db/freight-rates",{method:current.mode==="new"?"POST":"PATCH",headers:authHeaders(true),body:JSON.stringify(payload)});
      var j=await r.json().catch(function(){return {};});
      if(!r.ok||j.success===false)throw new Error(j.error||("HTTP "+r.status));
      close();api.refresh();
    }catch(e){
      showError("保存失败："+e.message);
      btns.forEach(function(b){b.disabled=false;b.textContent="保存";});
    }
  }
  async function withdrawRate(id){
    if(!id||!confirm("确认作废这条运价？"))return;
    try{
      var r=await fetch("/api/db/freight-rates",{method:"PATCH",headers:authHeaders(true),body:JSON.stringify({id:id,status:"withdrawn"})});
      var j=await r.json().catch(function(){return {};});
      if(!r.ok||j.success===false)throw new Error(j.error||("HTTP "+r.status));
      api.refresh();
    }catch(e){alert("作废失败："+e.message);}
  }
  async function portal(row,button){
    if(!row||!row.supplier_id)return;
    button.disabled=true;
    try{
      var r=await fetch("/api/db/portal-short-code",{method:"POST",headers:authHeaders(true),body:JSON.stringify({company_id:row.supplier_id})});
      var j=await r.json().catch(function(){return {};});
      if(!r.ok||!j.url)throw new Error(j.error||("HTTP "+r.status));
      button.title=j.url;
      if(navigator.clipboard)navigator.clipboard.writeText(j.url).catch(function(){});
    }catch(e){alert("报价门户失败："+e.message);}
    finally{button.disabled=false;}
  }
  function actionsHtml(row){
    if(!row||!row.id)return "";
    if(row.status==="withdrawn")return '<span class="na">已作废</span>';
    return '<span class="row-actions"><button class="linkbtn" type="button" data-rate-detail="'+attr(row.id)+'">详情</button><button class="mini-btn danger" type="button" data-rate-withdrawn="'+attr(row.id)+'">作废</button></span>';
  }
  function portalHtml(row){
    if(!row||!row.supplier_id)return "";
    return '<button class="portal-btn" type="button" data-rate-portal="'+attr(row.id)+'" title="生成并复制报价门户链接">报价门户</button>';
  }
  function handleClick(e){
    var closeBtn=e.target.closest("[data-rate-close]");if(closeBtn){close();return true;}
    var saveBtn=e.target.closest("[data-rate-save]");if(saveBtn){save();return true;}
    var cancelBtn=e.target.closest("[data-rate-cancel]");if(cancelBtn&&current){root.innerHTML=drawerHtml("edit",current.row);root.querySelectorAll("input,textarea,select").forEach(function(el){el.addEventListener("input",markDirty);el.addEventListener("change",markDirty);});return true;}
    var detail=e.target.closest("[data-rate-detail]");if(detail){open("edit",api.findRow(detail.dataset.rateDetail));return true;}
    var withdrawBtn=e.target.closest("[data-rate-withdrawn]");if(withdrawBtn){withdrawRate(withdrawBtn.dataset.rateWithdrawn);return true;}
    var portalBtn=e.target.closest("[data-rate-portal]");if(portalBtn){portal(api.findRow(portalBtn.dataset.ratePortal),portalBtn);return true;}
    var addBox=e.target.closest("[data-box-add]");if(addBox){var row=root.querySelector("[data-box-add-row]");if(row)row.hidden=false;addBox.hidden=true;return true;}
    var create=e.target.closest("[data-box-create]");if(create){createBox(create);return true;}
    var delBox=e.target.closest("[data-box-delete]");if(delBox){deleteBox(delBox.dataset.boxDelete);return true;}
    return false;
  }
  function init(opts){
    api=opts;root=document.getElementById("rateDrawerRoot");
    root.addEventListener("click",handleClick);
    root.addEventListener("change",function(e){var el=e.target.closest("[data-rate-choice]");if(el){syncChoice(el);markDirty();}});
    root.addEventListener("change",function(e){var el=e.target.closest("[data-box-field]");if(el)patchBox(el);});
  }
  window.RatesHubEdit={init:init,openNew:function(){open("new");},openDetail:function(row){open("edit",row);},handleClick:handleClick,actionsHtml:actionsHtml,portalHtml:portalHtml};
})();
