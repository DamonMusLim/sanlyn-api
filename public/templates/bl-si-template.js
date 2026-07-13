/* bl-si-template.js — 提单确认件(SI) 可编辑模版:直接复用现有数据(shipping-transfer-data + orders + seller-profiles),不重建。*/
var TPL_VERSION = "v1 · 2026-07-10 17:38";
(function () {
  var VENDOR = "/templates/vendor/";
  function qp(k){ try{ return new URLSearchParams(location.search).get(k) || ""; }catch(e){ return ""; } }
  var PLAN = qp("plan_id") || qp("id") || qp("bl");
  var TOKEN = qp("token");
  var API = /(?:api|ai)\.sanlyn/.test(location.origin) ? "" : "https://api.sanlyn.cn";
  function api(path){ return API + path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(TOKEN); }
  function authH(){ return { Authorization: "Bearer " + TOKEN }; }
  function setT(id, v){ var e = document.getElementById(id); if(e) e.textContent = (v == null ? "" : String(v)); }
  function num(v){ var n = Number(v); return isFinite(n) ? n : 0; }
  function fmt(n, d){ return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: d || 0, maximumFractionDigits: (d == null ? 3 : d) }); }
  function up(s){ return String(s == null ? "" : s).toUpperCase(); }
  // SI 须全英文大写:货描含中文时回退英文默认(可编辑再改精确品名)
  function enGoods(s){ var v = up(s); return /[^\x00-\x7F]/.test(v) ? "CAT LITTER" : (v || "CAT LITTER"); }
  // 标准联系方式后缀: 有则加 TEL/EMAIL 行,空则省略(邮箱保持原样不大写)
  function contactSuffix(tel, email){
    var out=""; var t=(tel==null?"":String(tel)).trim(); var e=(email==null?"":String(email)).trim();
    if(t) out+="\nTEL: "+t; if(e) out+="\nEMAIL: "+e; return out;
  }
  function status(m){ setT("siStatus", m); }

  // ---- 自托管库(PDF/Excel),和其它模版一致 ----
  function loadS(src, cb){ var ex = document.querySelector('script[data-v="'+src+'"]'); if(ex){ if(ex.getAttribute("data-ok")==="1") return cb(); ex.addEventListener("load", cb); return; } var s=document.createElement("script"); s.src=src; s.setAttribute("data-v",src); s.onload=function(){ s.setAttribute("data-ok","1"); cb(); }; s.onerror=function(){ alert("库加载失败: "+src); }; document.head.appendChild(s); }
  function jsPDFc(){ return (window.jspdf && window.jspdf.jsPDF) || window.jsPDF || null; }
  function ensure(name, file, cb){ if(window[name] || (name==="jspdf" && jsPDFc())) return cb(); loadS(VENDOR+file, cb); }
  function baseName(){ return "提单确认件-" + (PLAN || "draft"); }

  window.siPrint = function(){ window.print(); };
  window.siSaveDraft = function(){ try{ localStorage.setItem("bl_si_"+PLAN, JSON.stringify({ html: document.getElementById("doc").innerHTML, ts: Date.now() })); status("✓ 草稿已保存"); setTimeout(function(){ status(""); }, 1500); }catch(e){ status("保存失败"); } };
  function restoreDraft(){ try{ var d = JSON.parse(localStorage.getItem("bl_si_"+PLAN) || "null"); if(d && d.html && confirm("发现本地草稿，是否恢复？")) document.getElementById("doc").innerHTML = d.html; }catch(e){} }
  window.siPdf = function(){
    var doc = document.getElementById("doc"), tb = document.querySelector(".cd-toolbar");
    if(tb) tb.style.display = "none"; function done(){ if(tb) tb.style.display = ""; }
    ensure("html2canvas", "html2canvas.min.js", function(){ ensure("jspdf", "jspdf.umd.min.js", function(){
      window.html2canvas(doc, { scale: 2, useCORS: true, backgroundColor: "#fff" }).then(function(c){
        var J = jsPDFc(); if(!J){ done(); return window.print(); }
        var pdf = new J("l","mm","a4"), pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
        var iw = pw, ih = c.height*pw/c.width, img = c.toDataURL("image/jpeg", 0.95);
        if(ih<=ph){ pdf.addImage(img,"JPEG",0,0,iw,ih); } else { var pos=0; while(pos<ih-0.5){ pdf.addImage(img,"JPEG",0,-pos,iw,ih); pos+=ph; if(pos<ih-0.5) pdf.addPage(); } }
        pdf.save(baseName()+".pdf"); done();
      }).catch(function(){ done(); window.print(); });
    }); });
  };
  window.siExcel = function(){
    ensure("XLSX", "xlsx.full.min.js", function(){ try{
      var aoa=[]; document.querySelectorAll("#doc table").forEach(function(t){ if(t.offsetParent===null) return; [].forEach.call(t.rows, function(tr){ aoa.push([].map.call(tr.cells, function(td){ return (td.textContent||"").replace(/\s+/g," ").trim(); })); }); aoa.push([]); });
      var wb = window.XLSX.utils.book_new(), ws = window.XLSX.utils.aoa_to_sheet(aoa);
      window.XLSX.utils.book_append_sheet(wb, ws, "提单确认件"); window.XLSX.writeFile(wb, baseName()+".xlsx");
    }catch(e){ alert("导出失败: "+e.message); } });
  };

  function fillContainers(containers){
    var tb = document.getElementById("si-rows"), tp=0, tg=0, tc=0, tv=0, pol="", goods="", hs="";
    tb.innerHTML = "";
    (containers||[]).forEach(function(c, i){
      var pieces=num(c.pieces), gw=num(c.gross_weight_kg), cbm=num(c.cbm), vgm=num(c.vgm_kg);
      tp+=pieces; tg+=gw; tc+=cbm; tv+=vgm; pol=pol||up(c.export_port); goods=goods||enGoods(c.goods_desc); hs=hs||c.hs_code;
      var tr=document.createElement("tr");
      var R=' data-row="'+i+'"';
      tr.innerHTML='<td data-field="seq"'+R+'>'+(i+1)+'</td>'
        +'<td class="ed" contenteditable data-field="container_no"'+R+'>'+up(c.container_no)+'</td>'
        +'<td class="ed" contenteditable data-field="seal_no"'+R+'>'+up(c.seal_no)+'</td>'
        +'<td class="ed" contenteditable data-field="container_type"'+R+'>'+up(c.container_type)+'</td>'
        +'<td class="r ed" contenteditable data-field="pieces"'+R+'>'+fmt(pieces)+'</td>'
        +'<td data-field="unit"'+R+'>CARTONS</td>'
        +'<td class="r ed" contenteditable data-field="gross_weight"'+R+'>'+fmt(gw,2)+'</td>'
        +'<td class="r ed" contenteditable data-field="cbm"'+R+'>'+fmt(cbm,3)+'</td>'
        +'<td class="r ed" contenteditable data-field="tare"'+R+'>'+fmt(num(c.tare_kg),2)+'</td>'
        +'<td class="r ed" contenteditable data-field="vgm"'+R+'>'+fmt(vgm,2)+'</td>';
      tb.appendChild(tr);
    });
    setT("si-t-pieces",fmt(tp)); setT("si-t-gw",fmt(tg,2)); setT("si-t-cbm",fmt(tc,3)); setT("si-t-vgm",fmt(tv,2));
    setT("si-pieces",fmt(tp)); setT("si-gw",fmt(tg,2)); setT("si-cbm",fmt(tc,3));
    setT("si-pol", pol||"XIAMEN, CHINA"); setT("si-goods", goods||"CAT LITTER"); setT("si-hs", hs||"");
  }

  function boot(){
    setT("tplVer", TPL_VERSION); setT("genTime", new Date().toLocaleString("zh-CN"));
    // 版本标记 data-audience(internal/customer/carrier,兼容旧carrier=1) + 红字仅船东版
    var _aud = qp("aud") || (qp("carrier")==="1" ? "carrier" : "internal");
    var _doc=document.getElementById("doc"); if(_doc) _doc.setAttribute("data-audience", _aud);
    var _req=document.querySelector(".req");
    if(_req) _req.style.display = (_aud==="carrier") ? "" : "none";
    if(!PLAN){ status("缺少 plan_id"); return; }
    status("加载中…");
    fetch(api("/api/db/shipping-transfer-data?plan_id="+encodeURIComponent(PLAN)), { headers: authH() }).then(function(r){ return r.json(); }).then(function(d){
      var plan=d.plan||{}, containers=d.containers||[];
      // 未录柜时可用链接参数临时填柜信息(ctn/seal/tare/vgm),仅覆盖首个"待定"柜,不写库
      var OV={ctn:qp("ctn"),seal:qp("seal"),tare:qp("tare"),vgm:qp("vgm")};
      if(containers[0] && (OV.ctn||OV.seal||OV.tare||OV.vgm)){
        var c0=containers[0];
        if(OV.ctn) c0.container_no=OV.ctn;
        if(OV.seal) c0.seal_no=OV.seal;
        if(OV.tare) c0.tare_kg=num(OV.tare);
        c0.vgm_kg = OV.vgm ? num(OV.vgm) : (num(c0.gross_weight_kg)+num(c0.tare_kg));
      }
      fillContainers(containers);
      setT("si-blno", up(plan.export_bl)); setT("si-issuemode", up(qp("issue"))||"SWB");
      setT("si-vessel", up((plan.vessel||"")+" "+(plan.voyage||"")).trim());
      var contract=(containers[0]||{}).contract_no||"";
      var op = contract ? fetch(api("/api/db/orders?contract_no="+encodeURIComponent(contract)), { headers: authH() }).then(function(r){ return r.json(); }).then(function(x){ return (x.data||[])[0]||{}; }).catch(function(){ return {}; }) : Promise.resolve({});
      var spf = fetch(api("/api/db/seller-profiles"), { headers: authH() }).then(function(r){ return r.json(); }).then(function(x){ return x.data||x||[]; }).catch(function(){ return []; });
      Promise.all([op, spf]).then(function(a){
        var order=a[0]||{}, sellers=Array.isArray(a[1])?a[1]:[];
        var s = sellers.find(function(x){ return x.name_cn===order.issuing_company || x.name_en===order.issuing_company; });
        var shipperEN = s ? up((s.name_en||"")+"\n"+(s.address_en||"")) : up(order.issuing_company||"");
        if(qp("sc")!=="0") shipperEN += s ? contactSuffix(s.tel||s.contact_phone||s.phone, s.email||s.contact_email) : "";
        setT("si-shipper", shipperEN);
        setT("si-marks", up(order.shipping_marks || order.marks || "") || "NO SHIPPING MARK");
        setT("si-pod", up(order.country||"")); setT("si-delivery", up(order.country||""));
        // 收货人/通知人带 邮箱+电话(客户联系方式, customers 表按 company_code 查)
        function setCons(phone, email){
          var out = up((order.customer||"")+"\n"+(order.customer_address||"")) + (qp("cc")!=="0" ? contactSuffix(phone, email) : "");
          setT("si-consignee", out); setT("si-notify", out);
        }
        var code = order.company_code || "";
        if(code){
          fetch(api("/api/db/customers?company_code="+encodeURIComponent(code)), { headers: authH() })
            .then(function(r){ return r.json(); })
            .then(function(x){ var c=((x.data||x||[])[0])||{}; setCons(c.contact_phone||"", c.contact_email||""); })
            .catch(function(){ setCons("",""); });
        } else { setCons("",""); }
        status("数据已加载(可编辑)"); restoreDraft();
      });
    }).catch(function(e){ status("加载失败: "+e.message); });
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
