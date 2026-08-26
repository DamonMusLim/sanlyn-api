(function(){
"use strict";
var API="/api/db/global-search";
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function defaultOpen(item){if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",title:item.label,url:item.url},location.origin);else window.open(item.url,"_blank","noopener")}
function mountGlobalSearch(root,opt){
  var timer=0,last="",items=[],active=-1,open=(opt&&opt.open)||defaultOpen;
  var shell=el("div","search-shell"),icon=el("span","search-icon","⌕"),input=el("input","search-input"),clear=el("button","clear-btn","×"),box=el("div","dropdown");
  input.type="search";input.placeholder=(opt&&opt.placeholder)||"搜索提单 / 订单 / 客户 / 账单 / 集装箱";input.autocomplete="off";clear.type="button";clear.title="清空";clear.hidden=true;box.hidden=true;
  shell.append(icon,input,clear);root.append(shell,box);
  function showState(text){box.textContent="";box.appendChild(el("div","state",text));box.hidden=false}
  function render(groups){
    box.textContent="";items=[];active=-1;if(!groups.length){showState("没有匹配结果");return}
    groups.forEach(function(group){var wrap=el("div","group");wrap.appendChild(el("div","group-title",group.type));(group.items||[]).forEach(function(item){items.push(item);var btn=el("button","result");btn.type="button";btn.appendChild(el("div","type",item.type));var txt=el("div");txt.appendChild(el("div","label",item.label||"未设置"));txt.appendChild(el("div","sub",item.sub||"未设置"));btn.appendChild(txt);btn.addEventListener("click",function(){open(item)});wrap.appendChild(btn)});box.appendChild(wrap)});box.hidden=false;
  }
  function mark(){Array.prototype.forEach.call(box.querySelectorAll(".result"),function(n,i){n.classList.toggle("active",i===active)})}
  async function search(){
    var q=input.value.trim();clear.hidden=!q;if(q.length<2){box.hidden=true;items=[];return}if(q===last)return;last=q;showState("查询中");
    try{var r=await fetch(API+"?q="+encodeURIComponent(q),{headers:headers()});var d=await r.json().catch(function(){return{success:false,error:"接口返回异常"}});if(!r.ok||d.success===false)throw new Error(d.error||"查询失败");render(Array.isArray(d.data)?d.data:[])}catch(err){showState(err.message||"查询失败")}
  }
  input.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(search,250)});
  input.addEventListener("focus",function(){if(input.value.trim().length>=2)box.hidden=false});
  input.addEventListener("keydown",function(e){if(e.key==="Enter"&&items[0]){e.preventDefault();open(items[Math.max(active,0)])}if(e.key==="Escape")box.hidden=true;if(e.key==="ArrowDown"&&items.length){e.preventDefault();active=(active+1)%items.length;mark()}if(e.key==="ArrowUp"&&items.length){e.preventDefault();active=(active+items.length-1)%items.length;mark()}});
  clear.addEventListener("click",function(){input.value="";last="";items=[];clear.hidden=true;box.hidden=true;input.focus()});
  document.addEventListener("click",function(e){if(!root.contains(e.target))box.hidden=true});
}
window.SanlynGlobalSearch={mount:mountGlobalSearch};
})();
