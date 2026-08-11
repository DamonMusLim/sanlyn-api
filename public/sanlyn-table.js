(function(){
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])})}
  function escAttr(s){return esc(s).replace(/'/g,"&#39;")}
  function money(n){n=Number(n||0);return n?n.toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}):"0.00"}
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function authHeaders(extra){var h=extra||{},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function qs(obj){return new URLSearchParams(obj||{}).toString()}
  function gapHit(row,col){var g=row.gap_flags||[];return col.gap===true?g.length>0:!!(col.gap&&g.indexOf(col.gap)>=0)}
  function splitFold(v,sep){return String(v||"").split(sep||"+").filter(Boolean)}

  function SanlynTable(el,config){
    this.el=el;this.config=config;this.rows=[];this.edits=[];this.editMode=!!config.editable;this.modal=this.ensureModal();
    this.bind();
  }
  SanlynTable.prototype.ensureModal=function(){
    var m=document.getElementById("modal");
    if(!m){
      m=document.createElement("div");m.id="modal";
      m.innerHTML='<div id="mbox"><h3 id="mtitle"></h3><div id="mbody"></div><div class="mbtns"><button class="btn" id="msave">保存全部</button><button class="btn" id="mcancel" style="background:#6b7280">取消</button></div></div>';
      document.body.appendChild(m);
    }
    return m;
  };
  SanlynTable.prototype.bind=function(){
    var self=this;
    this.el.addEventListener("click",function(e){
      var fold=e.target.closest("td.po-fold");if(fold&&e.target.tagName!=="A"&&!e.target.classList.contains("pen"))fold.classList.toggle("open");
      var pen=e.target.closest(".pen");if(pen){self.openEdit(Number(pen.dataset.row));e.stopPropagation();}
    });
    this.el.addEventListener("dblclick",function(e){
      var td=e.target.closest("td[data-edit]");if(td)self.quickEdit(Number(td.dataset.edit),td.innerText.replace(/,/g,""));
    });
    this.modal.querySelector("#mcancel").onclick=function(){self.modal.style.display="none"};
    this.modal.querySelector("#msave").onclick=function(){self.saveModal()};
  };
  SanlynTable.prototype.loginBox=function(){
    var self=this;
    this.el.className="";
    this.el.innerHTML='<div id="login" style="display:block"><h3>登录</h3><input id="u" placeholder="用户名" style="width:100%;margin-bottom:8px;padding:9px"><input id="p" type="password" placeholder="密码" style="width:100%;margin-bottom:10px;padding:9px"><button id="go" style="width:100%;padding:10px">登录</button><div id="le" style="color:#b91c1c;font-size:12px;margin-top:6px"></div></div>';
    this.el.querySelector("#go").onclick=async function(){
      var u=self.el.querySelector("#u"),p=self.el.querySelector("#p"),le=self.el.querySelector("#le");
      try{
        var r=await fetch(self.config.loginApi,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u.value,password:p.value})});
        var d=await r.json();if(!r.ok||!d.token)throw new Error(d.error||"登录失败");
        localStorage.setItem("sanlyn_token",d.token);self.el.className="panel";self.load();
      }catch(e){le.textContent=e.message}
    };
  };
  SanlynTable.prototype.err=function(e){this.el.innerHTML="";var msg=document.getElementById("msg");if(msg)msg.innerHTML='<div class="err">'+esc(e.message||e)+'</div>'};
  SanlynTable.prototype.softErr=function(e){var msg=document.getElementById("msg");if(msg)msg.innerHTML='<div class="err">'+esc(e.message||e)+'</div>'};
  SanlynTable.prototype.load=async function(){
    var stamp=document.getElementById("stamp"),msg=document.getElementById("msg");
    if(msg)msg.innerHTML="";this.el.className="panel";this.el.innerHTML='<div class="hint">Loading...</div>';
    try{
      var url=this.config.api+"?"+qs(this.config.params?this.config.params():{});
      var r=await fetch(url,{headers:authHeaders({})});
      if(r.status===401){this.loginBox();return}
      var j=await r.json();if(!r.ok||!j.success)throw new Error(j.error||r.statusText);
      this.rows=(j.data||[]).filter(this.config.filter||function(){return true});if(stamp)stamp.textContent="生成时间 "+new Date().toLocaleString("zh-CN");this.render();
    }catch(e){this.err(e)}
  };
  SanlynTable.prototype.sumRow=function(){
    var sums={},keys=this.config.sumKeys||[];
    keys.forEach(function(k){sums[k]=0});
    this.rows.forEach(function(r){keys.forEach(function(k){sums[k]+=Number(r[k]||0)})});
    return sums;
  };
  SanlynTable.prototype.cell=function(row,col,ri,ci){
    var cls=[],html="",edit=null,prefix="";
    if(gapHit(row,col))cls.push("gap");
    if(this.editMode&&ci===0&&this.config.rowEdit&&(this.config.rowEdit(row)||[]).length)prefix='<b class="pen" title="编辑本票" data-row="'+ri+'">&#9998;</b> ';
    if(col.render){html=prefix+col.render(row,{esc:esc,token:token,money:money});}
    else if(col.type==="fold"){html=prefix+this.foldHtml(row[col.key],col);}
    else if(col.type==="num"){html=money(row[col.key]);}
    else html=esc(row[col.key]||"");
    if(this.editMode&&col.type==="num"&&col.edit){edit=col.edit(row);if(edit&&this.config.editApi){cls.push("ed");this.edits.push(edit)}}
    var data=edit?' data-edit="'+(this.edits.length-1)+'" title="双击编辑"':"";
    if(col.type==="fold"||col.fold)cls.push("po-fold");
    return '<td class="'+cls.join(" ")+'"'+data+'>'+html+'</td>';
  };
  SanlynTable.prototype.foldHtml=function(v,col){
    var parts=splitFold(v,col.sep);
    if(parts.length<=Number(col.show||3))return esc(parts.join(" + ")||"-");
    var head=parts.slice(0,col.show||3).join(" + ");
    return '<span class="po-head">'+esc(head)+' <b class="po-more">+'+(parts.length-(col.show||3))+'</b></span><span class="po-full">'+esc(parts.join(" + "))+'</span>';
  };
  SanlynTable.prototype.headHtml=function(cols){
    if(!cols.some(function(c){return c.group}))return '<tr>'+cols.map(function(c){return '<th>'+esc(c.label||c.key)+'</th>'}).join("")+'</tr>';
    var r1="",r2="",i=0;
    while(i<cols.length){var c=cols[i];
      if(!c.group){r1+='<th rowspan="2">'+esc(c.label||c.key)+'</th>';i++;continue}
      var g=c.group,span=0;while(i+span<cols.length&&cols[i+span].group===g)span++;
      r1+='<th colspan="'+span+'" class="grp">'+esc(g)+'</th>';
      for(var k=0;k<span;k++)r2+='<th>'+esc(cols[i+k].label||cols[i+k].key)+'</th>';
      i+=span;}
    return '<tr>'+r1+'</tr><tr>'+r2+'</tr>';
  };
  SanlynTable.prototype.render=function(){
    var self=this,cols=this.config.columns||[],sums=this.sumRow();this.edits=[];
    var head=this.headHtml(cols);
    var body=this.rows.map(function(r,ri){return '<tr>'+cols.map(function(c,ci){return self.cell(r,c,ri,ci)}).join("")+'</tr>'}).join("");
    if((this.config.sumKeys||[]).length){
      body+='<tr class="sum">'+cols.map(function(c,ci){
        if(ci===0)return '<td>合计</td>';
        if((self.config.sumKeys||[]).indexOf(c.key)>=0)return '<td>'+money(sums[c.key])+'</td>';
        return '<td></td>';
      }).join("")+'</tr>';
    }
    this.el.innerHTML='<table class="tbl">'+head+body+'</table>';
  };
  SanlynTable.prototype.patch=async function(item,value){
    var r=await fetch(this.config.editApi,{method:"PATCH",headers:authHeaders({"Content-Type":"application/json"}),body:JSON.stringify({kind:item.kind,key:item.key,field:item.field,value:value})});
    var j=await r.json();if(!r.ok||!j.success)throw new Error(j.error||r.statusText);
  };
  SanlynTable.prototype.quickEdit=async function(i,cur){
    var ed=this.edits[i],nv;if(!ed)return;
    nv=prompt("修改 "+ed.field+" ("+ed.key+")",cur);if(nv===null||nv===cur)return;
    try{await this.patch(ed,nv);this.load()}catch(e){this.softErr(e)}
  };
  SanlynTable.prototype.openEdit=function(i){
    var row=this.rows[i],items=this.config.rowEdit?this.config.rowEdit(row):[],h="";
    if(!items.length){this.err("本票无可编辑字段(纯货代票金额在海运录入改)");return}
    items.forEach(function(it,idx){
      h+='<div class="mrow"><label>'+esc(it.label)+'</label><input data-i="'+idx+'" value="'+escAttr(it.value||0)+'"></div>';
    });
    this.modal._items=items;
    this.modal.querySelector("#mtitle").textContent=(row.po_nos||"(无PO)")+"  "+(row.bl_no||"");
    this.modal.querySelector("#mbody").innerHTML=h;
    this.modal.querySelectorAll("input").forEach(function(inp){inp.dataset.orig=inp.value});
    this.modal.style.display="block";
  };
  SanlynTable.prototype.saveModal=async function(){
    var self=this,btn=this.modal.querySelector("#msave"),ins=this.modal.querySelectorAll("input");
    btn.disabled=true;
    try{
      for(var k=0;k<ins.length;k++){
        var inp=ins[k],it=this.modal._items[Number(inp.dataset.i)];
        if(inp.value!==inp.dataset.orig)await self.patch(it,inp.value);
      }
      this.modal.style.display="none";this.load();
    }catch(e){alert("保存失败: "+e.message)}finally{btn.disabled=false}
  };
  SanlynTable.prototype.exportExcel=async function(filename){
    if(!this.config.exportUrl)return;
    try{
      var r=await fetch(this.config.exportUrl+"?"+qs(this.config.params?this.config.params():{}),{headers:authHeaders({})});
      if(r.status===401){this.loginBox();return}
      if(!r.ok)throw new Error("导出失败");
      var b=await r.blob(),a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=filename||"export.xlsx";a.click();URL.revokeObjectURL(a.href);
    }catch(e){this.err(e)}
  };
  SanlynTable.prototype.setEditMode=function(v){this.editMode=!!v;this.render()};
  async function companySelect(sel,defVal){
    try{
      var r=await fetch("/api/db/recon-companies",{headers:authHeaders({})});
      var j=await r.json();if(!j.success)return;
      sel.innerHTML='<option value="">全部客户</option>'+j.data.map(function(c){
        return '<option value="'+escAttr(c.code)+'"'+(c.code===defVal?" selected":"")+'>'+esc((c.name||c.code).slice(0,26))+' ('+esc(c.code)+')</option>'}).join("");
    }catch(e){}
  }
  window.SanlynTable={mount:function(el,config){var t=new SanlynTable(el,config);t.load();return t},esc:esc,token:token,money:money,companySelect:companySelect};
})();
