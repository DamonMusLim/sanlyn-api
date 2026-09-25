(function(){
"use strict";

function clean(v){return v==null?"":String(v).trim()}
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}

// 视图会把空值渲染成中文占位(❓无提单号/待补/—/未接入/(空)),拿这些去拼URL会打开一张错单。
function validBl(v){
  v=clean(v);
  if(!v)return "";
  var compact=v.replace(/\s+/g,"");
  if(/[❓]/.test(v))return "";
  if(/^(待补|—|-|未接入|\(空\)|（空）)$/.test(compact))return "";
  if(compact.length<6)return "";
  if(!/\d/.test(compact))return "";
  return v;
}

var TYPES={
  fob_portcharge:"港杂单",
  fob_invoice:"海运费单",
  exw_invoice:"EXW全费用单",
  // 跨境业务人民币结算收款说明(2016版)。银行原版母版 receipt-master.docx,一格都不能改;
  // 后端 receipt-doc.js 默认自动盖章(stamp_seal!==false)。银行到账金额未接入前「收款金额合计」留空,
  // 绝不用系统报价顶替——那是交给银行的合规单据。见 skill cross-border-receipt-notice。
  receipt:"收款证明"
};

var state={
  bl:"",
  type:"fob_invoice",
  token:"",
  iframe:null,
  blobUrl:"",
  loading:false,
  requestId:0,
  internalRequestId:0,
  docWarnings:[]
};

function qs(){
  try{return new URLSearchParams(location.search)}catch(e){return new URLSearchParams("")}
}

function token(){
  var p=qs(),t=clean(p.get("token"));
  if(t)return t;
  try{
    return clean(localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token"));
  }catch(e){
    return "";
  }
}

function initialBl(){
  var p=qs();
  return validBl(p.get("bl")||p.get("bl_no")||p.get("mbl_no")||"");
}

function initialType(){
  var p=qs(),t=clean(p.get("type"));
  return TYPES[t]?t:"fob_invoice";
}

function $(sel){return document.querySelector(sel)}
function $all(sel){return Array.prototype.slice.call(document.querySelectorAll(sel))}

function ensureRoot(){
  var root=$("#docApp")||$("#app")||$(".doc-app")||document.body;
  var toolbar=$("#docToolbar")||$(".doc-toolbar")||root.querySelector("[data-doc-toolbar]");
  var viewer=$("#docViewer")||$("#viewer")||$(".doc-viewer")||root.querySelector("[data-doc-viewer]");
  var status=$("#docStatus")||$("#status")||$(".doc-status")||root.querySelector("[data-doc-status]");
  var loginHint=$("#loginHint")||$(".login-hint")||root.querySelector("[data-login-hint]");

  if(!toolbar){
    toolbar=document.createElement("div");
    toolbar.id="docToolbar";
    root.appendChild(toolbar);
  }
  if(!viewer){
    viewer=document.createElement("div");
    viewer.id="docViewer";
    root.appendChild(viewer);
  }
  if(!status){
    status=document.createElement("div");
    status.id="docStatus";
    root.insertBefore(status,viewer);
  }
  if(!loginHint){
    loginHint=document.createElement("div");
    loginHint.id="loginHint";
    root.insertBefore(loginHint,viewer);
  }
  return {root:root,toolbar:toolbar,viewer:viewer,status:status,loginHint:loginHint};
}

function typeButtons(){
  var out=[],seen={};
  Object.keys(TYPES).forEach(function(type){
    var list=$all('[data-doc-type="'+type+'"],[data-type="'+type+'"],#type-'+type+',#btn-'+type);
    list.forEach(function(btn){
      if(!seen[type+":"+out.length]){
        out.push(btn);
      }
    });
  });
  return out;
}

function actionButtons(){
  var list=$all("#printBtn,#downloadBtn,#pdfBtn,[data-action='print'],[data-action='download-pdf']");
  return list.filter(function(btn,i){return list.indexOf(btn)===i});
}

function setBusy(busy){
  state.loading=!!busy;
  typeButtons().concat(actionButtons()).forEach(function(btn){
    btn.disabled=!!busy;
    if(busy)btn.setAttribute("aria-busy","true");
    else btn.removeAttribute("aria-busy");
  });
}

function updateActiveType(){
  Object.keys(TYPES).forEach(function(type){
    var active=type===state.type;
    $all('[data-doc-type="'+type+'"],[data-type="'+type+'"],#type-'+type+',#btn-'+type).forEach(function(btn){
      if(active)btn.classList.add("active");
      else btn.classList.remove("active");
      btn.setAttribute("aria-pressed",active?"true":"false");
    });
  });
}

function replaceUrl(){
  try{
    var p=qs();
    if(state.bl)p.set("bl",state.bl);
    else p.delete("bl");
    p.set("type",state.type);
    // ⛔ 绝不把 token 写回地址栏 —— 会进浏览器历史、截图、以及任何被转发的链接。
    // token() 已从 query 读过一次(兼容带 token 的旧链接),这里一律抹掉,后续靠 localStorage。
    p.delete("token");
    history.replaceState(null,"",location.pathname+(p.toString()?"?"+p.toString():""));
  }catch(e){}
}

function docUrl(opts){
  opts=opts||{};
  var url="/api/db/shipping-plan-pdf?bl="+encodeURIComponent(state.bl)+"&type="+encodeURIComponent(state.type);
  if(opts.format)url+="&format="+encodeURIComponent(opts.format);
  if(opts.token&&state.token)url+="&token="+encodeURIComponent(state.token);
  return url;
}

function internalInfoUrl(){
  return "/api/db/hy-doc-internal?bl="+encodeURIComponent(state.bl);
}

function noData(v){
  if(Array.isArray(v))return v.length?v.join(", "):"无数据";
  v=clean(v);
  return v||"无数据";
}

function decodeWarnings(v){
  v=clean(v);
  if(!v)return [];
  return v.split(";").map(function(x){
    try{return decodeURIComponent(x)}catch(e){return x}
  }).map(clean).filter(Boolean);
}

function appendWarnings(el){
  if(!el||!state.docWarnings.length)return;
  Array.prototype.slice.call(el.querySelectorAll(".doc-warning")).forEach(function(n){n.parentNode.removeChild(n)});
  var warn=document.createElement("span");
  warn.className="doc-warning";
  warn.style.cssText="margin-left:12px;color:#b45309;font-size:12px;font-weight:600";
  warn.textContent="提示: "+state.docWarnings.join("; ");
  el.appendChild(warn);
}

function setDocWarnings(list){
  state.docWarnings=Array.isArray(list)?list:[];
  var el=$("#internalInfo");
  if(el)Array.prototype.slice.call(el.querySelectorAll(".doc-warning")).forEach(function(n){n.parentNode.removeChild(n)});
  appendWarnings($("#internalInfo"));
}

function setInternalInfo(data){
  var el=$("#internalInfo");
  if(!el)return;
  data=data||{};
  el.textContent="BL "+noData(data.bl_no)+" · CY "+noData(data.shipment_no)+" · 订单 "+noData(data.order_nos)+" · 出单公司 "+noData(data.issuing_companies);
  appendWarnings(el);
}

function loadInternalInfo(){
  var reqId,headers;
  if(!state.bl){
    setInternalInfo(null);
    return;
  }
  reqId=++state.internalRequestId;
  setInternalInfo(null);
  headers=state.token?{Authorization:"Bearer "+state.token}:{};
  fetch(internalInfoUrl(),{credentials:"same-origin",headers:headers})
    .then(function(res){
      if(reqId!==state.internalRequestId)return null;
      if(!res.ok)return null;
      return res.json();
    })
    .then(function(json){
      if(reqId!==state.internalRequestId)return;
      setInternalInfo(json&&json.success?json.data:null);
    })
    .catch(function(){
      if(reqId===state.internalRequestId)setInternalInfo(null);
    });
}

function setStatus(html,cls){
  var el=ensureRoot().status;
  el.className="doc-status"+(cls?" "+cls:"");
  el.innerHTML=html||"";
}

function clearViewer(){
  var viewer=ensureRoot().viewer;
  releaseBlobUrl();
  viewer.innerHTML="";
  state.iframe=null;
}

function releaseBlobUrl(){
  if(state.blobUrl){
    URL.revokeObjectURL(state.blobUrl);
    state.blobUrl="";
  }
}

function setEmpty(){
  clearViewer();
  setStatus('<div class="empty">未指定提单号</div>',"empty");
}

function setError(code,fallbackUrl){
  clearViewer();
  var msg="打不开";
  if(code)msg+=":"+code;
  setStatus(
    '<div class="error">'+esc(msg)+' <a target="_blank" rel="noopener" href="'+esc(fallbackUrl)+'">新标签页打开</a></div>',
    "error"
  );
}

function setFrame(html){
  var viewer=ensureRoot().viewer;
  releaseBlobUrl();
  viewer.innerHTML="";
  var frame=document.createElement("iframe");
  frame.className="doc-frame";
  frame.setAttribute("title",TYPES[state.type]||"单据");
  frame.style.width="100%";
  frame.style.minHeight="calc(100vh - 120px)";
  frame.style.border="0";
  frame.addEventListener("load",function(){
    try{
      var meta=frame.contentDocument&&frame.contentDocument.querySelector('meta[name="doc-warnings"]');
      setDocWarnings(decodeWarnings(meta&&meta.getAttribute("content")));
    }catch(e){}
  });
  frame.srcdoc=html;
  viewer.appendChild(frame);
  state.iframe=frame;
  setStatus("", "");
}

function setPdfFrame(blobUrl){
  var viewer=ensureRoot().viewer;
  releaseBlobUrl();
  viewer.innerHTML="";
  var frame=document.createElement("iframe");
  frame.className="doc-frame";
  frame.setAttribute("title",TYPES[state.type]||"单据");
  frame.style.width="100%";
  frame.style.minHeight="calc(100vh - 120px)";
  frame.style.border="0";
  frame.src=blobUrl;
  viewer.appendChild(frame);
  state.iframe=frame;
  state.blobUrl=blobUrl;
  setStatus("", "");
}

function loadDoc(){
  var reqId,headers,url;
  if(!state.bl){
    setEmpty();
    return;
  }
  if(!TYPES[state.type])state.type="fob_invoice";
  replaceUrl();
  updateActiveType();

  reqId=++state.requestId;
  setBusy(true);
  setStatus('<div class="loading">加载中...</div>',"loading");
  releaseBlobUrl();

  headers=state.token?{Authorization:"Bearer "+state.token}:{};
  url=docUrl();

  fetch(url,{credentials:"same-origin",headers:headers})
    .then(function(res){
      if(reqId!==state.requestId)return null;
      if(!res.ok){
        setDocWarnings([]);
        setError(res.status,docUrl({token:true}));
        return null;
      }
      setDocWarnings(decodeWarnings(res.headers.get("X-Doc-Warnings")));
      if((res.headers.get("Content-Type")||"").toLowerCase().indexOf("application/pdf")!==-1){
        return res.blob().then(function(blob){
          return {pdf:true,blobUrl:URL.createObjectURL(blob)};
        });
      }
      return res.text().then(function(html){
        return {html:html};
      });
    })
    .then(function(doc){
      if(reqId!==state.requestId||doc==null){
        if(doc&&doc.blobUrl)URL.revokeObjectURL(doc.blobUrl);
        return;
      }
      if(doc.pdf)setPdfFrame(doc.blobUrl);
      else setFrame(doc.html);
    })
    .catch(function(){
      if(reqId!==state.requestId)return;
      setError("",docUrl({token:true}));
    })
    .then(function(){
      if(reqId===state.requestId)setBusy(false);
    });
}

function switchType(type){
  if(state.loading)return;
  if(!TYPES[type])return;
  state.type=type;
  loadDoc();
}

function printDoc(){
  var w;
  if(state.loading)return;
  try{
    w=state.iframe&&state.iframe.contentWindow;
    if(w){
      w.focus();
      w.print();
    }
  }catch(e){
    window.open(docUrl({token:true}),"_blank","noopener");
  }
}

function downloadPdf(){
  if(state.loading)return;
  window.open(docUrl({token:true,format:"pdf"}),"_blank","noopener");
}

function bind(){
  Object.keys(TYPES).forEach(function(type){
    $all('[data-doc-type="'+type+'"],[data-type="'+type+'"],#type-'+type+',#btn-'+type).forEach(function(btn){
      btn.addEventListener("click",function(){switchType(type)});
    });
  });

  $all("#printBtn,[data-action='print']").forEach(function(btn){
    btn.addEventListener("click",printDoc);
  });
  $all("#downloadBtn,#pdfBtn,[data-action='download-pdf']").forEach(function(btn){
    btn.addEventListener("click",downloadPdf);
  });
}

function init(){
  var els=ensureRoot();

  state.bl=initialBl();
  state.type=initialType();
  state.token=token();

  if(els.loginHint){
    els.loginHint.innerHTML=state.token?"":'<span class="muted">未登录可能打不开</span>';
  }

  bind();
  updateActiveType();
  loadInternalInfo();
  loadDoc();
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);
else init();

window.HyDoc={
  validBl:validBl,
  reload:loadDoc,
  print:printDoc,
  downloadPdf:downloadPdf
};
})();
