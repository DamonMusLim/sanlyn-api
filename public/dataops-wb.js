// 数据加工中心 前端。⛔ fetch 一律相对路径(绝对 /api/... 会 404,模块标准里栽过两次)
var API = "./api/";
var $ = function(i){return document.getElementById(i)};
var esc = function(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
var num = function(n){return n==null?"—":Number(n).toLocaleString("zh-CN")};  // ⛔ null 显示"—"不是 0
var DOT = {red:"d-red",yellow:"d-yel",warn:"d-yel",green:"d-grn",gray:"d-gry"};
var cache = {};

async function get(path){
  if (cache[path]) return cache[path];
  // 鉴权:照 jdc 前端的做法从同域 localStorage 取(⛔不自己发明第二套)
  var tk = "";
  try { tk = localStorage.getItem("jdc_token") || localStorage.getItem("token") || ""; } catch(e){}
  var hd = {"accept":"application/json"};
  if (tk) hd["Authorization"] = tk.indexOf("Bearer")===0 ? tk : ("Bearer " + tk);
  var r = await fetch(API + path, {headers:hd, credentials:"include"});
  if (r.status===401){ verdict("🔴 没登录 —— 先在 /jdc/ 登录一次,再回来刷新本页","red"); return {error:"Unauthorized"}; }
  var j = await r.json().catch(function(){return {error:"HTTP "+r.status}});
  cache[path] = j; return j;
}
function verdict(txt, lv){
  var el = $("vd"); el.textContent = txt;
  el.className = "verdict " + (lv||"");
}
function grp(title, count, rows){ // 注:调用方在每组开始前 resetWhy()
  return '<div class="grp"><h3>'+esc(title)+'<span class="c">'+count+'</span></h3>'+rows+'</div>';
}
// 同一组里重复的 why 只显示第一次 —— 42 行同一句话是噪音不是信息(DeepSeek 0903 警告过)
var _seenWhy = {};
function resetWhy(){ _seenWhy = {}; }
function item(lv, nm, v, why){
  var dup = why && _seenWhy[why];
  if (why) _seenWhy[why] = 1;
  return '<div class="it'+(dup?" dupwhy":"")+'"><span class="dot '+(DOT[lv]||"d-gry")+'"></span>'+
   '<span class="nm">'+esc(nm)+'</span><span class="v">'+esc(v)+'</span>'+
   (why?'<span class="wy">'+esc(why)+'</span>':'')+'</div>';
}

var PAGES = {
  l0: async function(){
    var d = await get("db/petstore-table-registry");
    if (d.error) return verdict("🔴 "+d.error,"red"), "";
    $("n0").textContent = d.total;
    var bad = (d.groups.filter(function(g){return g.status==="采集缺口"})[0]||{}).count||0;
    verdict(d.total+" 张表 · "+(bad?("🔴 "+bad+" 张采集缺口(有人读、从没写过)"):"无采集缺口"), bad?"red":"ok");
    var LV = {"采集缺口":"red","孤儿":"red","无人读取":"yellow","路线图":"yellow","占位/废弃候选":"gray","生产中":"green"};
    return d.groups.map(function(g){ resetWhy();
      return grp(g.status, g.count, g.tables.slice(0,40).map(function(t){
        return item(LV[g.status]||"gray", t.table_name,
          "读 "+num(t.read_total)+" · 写 "+num(t.write_total),
          g.status==="生产中"?"":t.evidence);
      }).join("") + (g.tables.length>40?'<div class="it"><span class="wy">…还有 '+(g.tables.length-40)+' 张</span></div>':""));
    }).join("");
  },
  l1: async function(){
    var d = await get("db/petstore-source-health");
    if (d.error) return verdict("🔴 "+d.error,"red"), "";
    $("n1").textContent = d.acute.length + d.chronic.length;
    verdict(d.verdict, d.acute.length?"red":(d.chronic.length?"warn":"ok"));
    var h = "";
    if (d.acute.length) h += grp("🔴 急性 · 今天出的事", d.acute.length,
      d.acute.map(function(a){return item("red",a.src,a.rows!=null?("行 "+num(a.rows)):"",a.why)}).join(""));
    if (d.chronic.length) h += grp("🟡 慢性 · 已知待治理", d.chronic.length,
      d.chronic.map(function(c){return item("yellow",c.src,c.value||"",c.why+" · "+(c.detail||""))}).join(""));
    h += grp("正常", d.normal.length, d.normal.map(function(n){
      return item(n.level,n.src,"行 "+num(n.rows)+" · Δ "+num(n.row_delta),n.why)}).join(""));
    if (d.known_blind_spot) h += '<div class="blind">'+esc(d.known_blind_spot)+'</div>';
    return h;
  },
  l2: async function(){
    var d = await get("db/petstore-identity-align?storeCode=63350001");
    if (d.error) return verdict("🔴 "+d.error,"red"), "";
    var red = d.findings.filter(function(f){return f.level==="red"}).length;
    $("n2").textContent = d.findings.length;
    verdict(d.verdict, red?"red":"ok");
    var c = d.counts;
    var h = grp("对齐概况", 4,
      item("gray","商品主表", num(c.master_products)+" 个","") +
      item("gray","门店在售", num(c.store_products)+" 个","") +
      item("gray","主表有条码", num(c.master_has_upc)+" 个","") +
      item("gray","条码表覆盖", num(c.barcode_products)+" 个 / "+num(c.barcode_rows)+" 行",""));
    h += grp("发现", d.findings.length, d.findings.map(function(f){
      return item(f.level, f.title, num(f.value), f.why)}).join(""));
    if (d.note) h += '<div class="blind">'+esc(d.note)+'</div>';
    return h;
  },
  // ── 总商品库:逐条真实数据 ──
  // 🔴 数据口径(别糊成一列):
  //    库存快照 = petstore_skus.stock_num(果冻橙,每日拉)
  //    门店在册 = petstore_ops_row.cur_stock(工作台自己的行)
  //    两边不等 = 真实存在的差,标出来给人看,⛔不许挑一个显示假装一致
  //    效期 warn_status 是果冻橙标的,实测「快过期」只有12%准、「已过期」50% ——
  //    页面上必须写成「待核」,⛔不许当结论
  //    成本红线:本接口不返回任何成本/毛利字段,页面也不留位置
  // ── 比价罗盘 ──
  l7: async function(){
    var d = await get("db/petstore-price-compass");
    if (d.error || d.ok===false) return verdict("🔴 "+(d.error||d.message||"取数失败"),"red"), "";
    var c = d.coverage||{};
    verdict(d.verdict, /^🔴/.test(d.verdict) ? "red" : "ok");
    var TIER = {red:"d-red", yellow:"d-yel", green:"d-grn", gray:"d-gry"};
    var na = '<span class="na">—</span>';
    var v = function(x){ return (x===null||x===undefined||x==="") ? na : esc(x); };
    var raw = function(x){ return (x===null||x===undefined||x==="") ? "—" : String(x); };
    var money = function(x){ return (x===null||x===undefined||x==="") ? na : "¥"+Number(x).toFixed(2); };
    var moneyText = function(x){ return (x===null||x===undefined||x==="") ? "—" : "¥"+Number(x).toFixed(2); };
    var pill = function(x){
      var cls = "p-grade";
      if (x==="自营") cls = "p-own";
      else if (x==="倒闭款清仓") cls = "p-clear";
      else if (x==="临期") cls = "p-exp";
      else if (x==="热销" || x==="主推") cls = "p-hot";
      return '<span class="pill2 '+cls+'">'+esc(x)+'</span>';
    };
    if (!$("cmpstyle")) {
      var st = document.createElement("style");
      st.id = "cmpstyle";
      st.textContent = ".cmprow{cursor:pointer}.cmprow.clear{background:#fff1f0}.cmprow:hover{background:#f8fafc}.tagbox{display:flex;gap:4px;flex-wrap:wrap}.pill2.p-own{background:#e8f1ff;color:#1455a3;border-color:#bad3ff}.pill2.p-clear{background:#ffe8e8;color:#b4232a;border-color:#ffc4c4}.pill2.p-exp{background:#fff0d9;color:#a45a00;border-color:#ffd89a}.pill2.p-hot{background:#e6f6ed;color:#167347;border-color:#b9e6ca}.pill2.p-grade{background:#f1f3f5;color:#58606d;border-color:#d8dee6}.cmpgrid{display:grid;grid-template-columns:minmax(260px,36%) 1fr;gap:14px}.cmpcol{min-width:0}.cmpcol h4{margin:0 0 10px;font-size:14px}.gate{display:grid;grid-template-columns:24px 1fr;gap:8px;margin:0 0 12px}.gico{font-weight:800;font-size:18px;line-height:20px;text-align:center}.g-ok{color:#17915a}.g-warn{color:#c78405}.g-bad{color:#ce2f36}.g-idle{color:#8b96a8}.gttl{font-weight:700}.gdet{color:#6b7280;font-size:12px;margin-top:2px}.peerrow{border-left:3px solid transparent;padding:8px 9px;border-top:1px solid #edf0f4}.peerrow:first-child{border-top:0}.peerrow.badprice{opacity:.52;text-decoration:line-through}.peerrow.multipack{border-left-color:#f59e0b;background:#fff8ed}.peerline{display:grid;grid-template-columns:64px 72px minmax(130px,1fr) auto;gap:8px;align-items:center}.peerprice{font-weight:800}.peershop{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.peersales{color:#6b7280;text-align:right}.peertags{margin-top:4px;display:flex;gap:4px;flex-wrap:wrap}.peerraw{margin-top:4px;color:#6b7280;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ptag{font-size:12px;border:1px solid #d8dee6;background:#f8fafc;border-radius:4px;padding:1px 5px;color:#4b5563}.ptag.red{background:#ffe8e8;border-color:#ffc4c4;color:#b4232a}.ptag.org{background:#fff0d9;border-color:#ffd89a;color:#a45a00}.ptag.gray{background:#f1f3f5;color:#6b7280}.cmpstat{margin-top:12px;color:#374151}.traffic.ok{color:#137a4b;font-weight:700}.traffic.no{color:#6b7280;font-size:12px}.caveat{margin-top:8px;color:#a45a00}.nextstep{margin-top:10px;background:#fff4c2;border:1px solid #f4d35e;border-radius:6px;padding:9px 11px;font-weight:800}.recheck{margin-bottom:10px;background:#ffe8e8;border-left:4px solid #ce2f36;padding:8px 10px;font-weight:700}.cmpempty{color:#8b96a8;padding:12px}@media(max-width:760px){.cmpgrid{grid-template-columns:1fr}.peerline{grid-template-columns:54px 68px 1fr}.peersales{grid-column:1/-1;text-align:left}}";
      document.head.appendChild(st);
    }

    // 覆盖率和渠道摆在最上面 —— ⛔ 不许让人以为这 65 个能代表全店
    var h = '<div class="cov bad">对标覆盖 <b>'+(c.matched_sku||0)+'/'+(c.all_sku||0)+'</b>('+
      (c.pct||0)+'%),其中有货 '+(c.matched_instock||0)+' 个。'+
      '<b>剩下的 '+((c.all_sku||0)-(c.matched_sku||0)).toLocaleString("zh-CN")+
      ' 个不是「没问题」,是「没看过」。</b>'+
      ' 采于 <b>'+esc(c.captured||"?")+'</b>'+(c.stale_days>3?'(已停采 '+c.stale_days+' 天)':'')+
      // 0908:匹配是自动跑的,v2 抽样 5 条错 1 条(跨品类,如猫粮配成主食罐)。
      // ⛔ 不许让人以为这些行是核过的 —— 拿去定价前必须点开看一眼。
      '<br><b>⚠️ 对上的这些是机器自动配的,抽样约 1/5 会配错品类</b>(例:猫粮配成主食罐)。'+
      '拿去定价前点开核一眼,别直接信。</div>';

    var extra = '另有 '+num(d.hidden_offshelf)+' 个已下架/无库存的没显示 —— 想看要去「总商品库」';
    if (d.excluded_hook!==undefined || d.unverifiable_cnt!==undefined) {
      extra += ' 本页已剔除 '+num(d.excluded_hook)+' 条钩子价 · 另有 '+num(d.unverifiable_cnt)+' 条无划线价无从判断';
    }
    h += '<p class="why">'+esc(extra)+'</p>';

    if (d.shops && d.shops.length) h += '<p class="why">在采的附近门店:'+
      d.shops.map(function(s){ return esc(s.competitor_name)+'('+esc(s["品"]==null?"—":s["品"])+'品)'; }).join(" · ")+'</p>';

    h += '<div class="chan">'+(d.channels||[]).map(function(x){
      var bad = String(x.status||"").indexOf("未开")>=0;
      return '<span class="ch'+(bad?" off":"")+'"><b>'+esc(x.name)+'</b> '+v(x.status)+
             '<i>'+v(x.detail)+'</i></span>'; }).join("")+'</div>';

    (d.groups||[]).forEach(function(g){
      if (!g.count) return;
      h += '<div class="grp"><h3><span class="dot '+(TIER[g.tier]||"d-gry")+'"></span>'+esc(g.label)+
        '<span class="c">'+g.count+'</span>'+
        '<span class="amt">'+(Number(g.amount_by_price)>0?'占款 '+moneyText(g.amount_by_price):'')+'</span></h3>'+
        (g.why?'<p class="gwhy">'+esc(g.why)+'</p>':'');
      h += '<div class="tw"><table class="g"><tr>'+
        ['商品编码','品名','我方价','附近最低','价差','标签','基准家数','货位']
          .map(function(x){return '<th>'+x+'</th>'}).join("")+'</tr>'+
        (g.rows||[]).map(function(r, ri){
          var gp = r.gap_pct;
          var gcls = gp==null ? "" : (gp > 20 ? "hi" : (gp < -20 ? "lo" : ""));
          var key = g.key + "-" + ri;
          if (!window.__CMP) window.__CMP = {};
          window.__CMP[key] = r;
          var tags = (r.labels||[]).map(pill).join("") || na;
          var lo = r.lo==null ? '<span class="na" title="没有同品牌的可比报价">—</span>' : money(r.lo);
          var basis = r.basis_shops==null ? na : esc(r.basis_shops);
          if (r.basis_shops===0 && r.excluded_brand>0) {
            basis = '<span title="附近 '+esc(r.excluded_brand)+' 家同行卖的都不是这个牌子,不能作为基准">0('+esc(r.excluded_brand)+'家不同牌)</span>';
          }
          return '<tr class="cmprow'+(r.is_clearing?' clear':'')+'" data-k="'+key+'">'+
            '<td class="mono"><span class="cx">▸</span>'+v(r.product_code)+'</td>'+
            '<td class="nm" title="'+esc(r.product_name||"")+'">'+(r.is_clearing?'🏷清仓 ':'')+v(r.product_name)+'</td>'+
            '<td class="r">'+money(r.store_price)+'</td>'+
            '<td class="r">'+lo+'</td>'+
            '<td class="r '+gcls+'">'+(gp==null?na:(gp>0?'+':'')+esc(gp)+'%')+'</td>'+
            '<td><div class="tagbox">'+tags+'</div></td>'+
            '<td class="r">'+basis+'</td>'+
            '<td class="mono">'+(r.shelf_code?v(r.shelf_code):'<span class="todo">无</span>')+'</td></tr>';
        }).join("")+'</table></div>';
      if (g.truncated) h += '<p class="gwhy">只列了前 '+g.shown+' 条(共 '+g.count+' 条)。</p>';
      h += '</div>';
    });
    h += '<div class="blind"><b>这张罗盘能信到什么程度</b><ul>'+
      (d.caveats||[]).map(function(x){return '<li>'+esc(x)+'</li>'}).join("")+'</ul></div>';
    return h;
  },

  l8: async function(){
    var d = await get("db/petstore-rival-catalog");
    if (d.error || d.ok===false) return verdict("🔴 "+(d.error||d.message||"取数失败"),"red"), "";
    verdict(d.verdict, /^🔴/.test(d.verdict) ? "red" : "ok");
    if (!$("rivalstyle")) {
      var st = document.createElement("style");
      st.id = "rivalstyle";
      st.textContent = ".rivals{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:10px;margin:10px 0 12px}.rvcard{border:1px solid #d8dee6;background:#fff;border-radius:6px;padding:10px;cursor:pointer}.rvcard.on{border-color:#1d72d2;box-shadow:0 0 0 2px #dcebff;background:#f8fbff}.rvtop{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.rvname{font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rvdate{color:#6b7280;font-size:12px;white-space:nowrap}.rvnums{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:8px}.rvnums b{display:block;font-size:18px}.rvnums span{color:#6b7280;font-size:12px}.rvmini{margin-top:8px;color:#6b7280;font-size:12px}.rvbar{background:#fff4df;border-left:4px solid #f59e0b;padding:9px 11px;margin:0 0 10px;font-weight:700;color:#8a4b00}.rvfilters{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.rvfilters button{border:1px solid #d8dee6;background:#fff;border-radius:5px;padding:6px 10px;cursor:pointer}.rvfilters button.on{background:#e8f1ff;border-color:#9fc3ff;color:#1455a3;font-weight:700}.strike{text-decoration:line-through;color:#8b96a8}.soldref{color:#8b96a8}.rvprod{max-width:300px}.rvprod b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rvprod small{display:block;color:#6b7280;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.shoplist{font-size:12px;line-height:1.5;max-width:240px}.shoplist div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rvtbl{min-width:900px}.rvtbl td.r,.rvtbl th.r{white-space:nowrap}.checkbad{background:#ffe8e8;border-left:4px solid #ce2f36;padding:8px 10px;margin-top:10px;font-weight:700}.checkok{background:#e6f6ed;border-left:4px solid #17915a;padding:8px 10px;margin-top:10px;font-weight:700}.tier-green{color:#17915a}.tier-yellow{color:#c78405}.tier-red{color:#ce2f36}@media(max-width:980px){.rivals{grid-template-columns:repeat(2,1fr)}}@media(max-width:620px){.rivals{grid-template-columns:1fr}}";
      document.head.appendChild(st);
    }
    var shops = d.shops||[], ov = d.overview||{}, na = '<span class="na">—</span>';
    var v = function(x){ return (x===null||x===undefined||x==="") ? na : esc(x); };
    var raw = function(x){ return (x===null||x===undefined||x==="") ? "—" : String(x); };
    var money = function(x){ return (x===null||x===undefined||x==="") ? na : "¥"+Number(x).toFixed(2); };
    var band = function(a,b){ if (a===null||a===undefined||a==="") return na; return Number(a)===Number(b) ? money(a) : money(a)+" ~ "+money(b); };
    $("n8").textContent = ov["总品数"]==null ? shops.length : ov["总品数"];
    var cur = shops[0] ? shops[0].shop_name : "";
    var detail = cur ? await get("db/petstore-rival-catalog?shop="+encodeURIComponent(cur)) : {rows:[]};
    if (detail.error || detail.ok===false) return verdict("🔴 "+(detail.error||detail.message||"取数失败"),"red"), "";
    var h = "";
    if (Number(ov.stale_days)>30) h += '<div class="rvbar">'+esc("数据导出于 "+raw(ov.export_date_min)+" · 距今 "+raw(ov.stale_days)+" 天 —— 价格和月销都可能变了,当参考不当今天行情")+'</div>';
    h += '<div class="rivals">'+shops.map(function(s,i){
      return '<div class="rvcard'+(i===0?' on':'')+'" data-shop="'+esc(s.shop_name||"")+'"><div class="rvtop"><div class="rvname" title="'+esc(raw(s.shop_name))+'">'+v(s.shop_name)+'</div><div class="rvdate">'+v(s.export_date)+'</div></div>'+
        '<div class="rvnums"><div><b>'+v(s["品"])+'</b><span>'+esc("在架品")+'</span></div>'+
        (s["月销合计"]==null?'':'<div><b>'+v(s["月销合计"])+'</b><span>'+esc("月销合计")+'</span></div>')+
        '<div><b>'+v(s["月销20plus"])+'</b><span>'+esc("月销20+")+'</span></div>'+
        '<div><b>'+v(s["我们有"])+'</b><span>'+esc("我们有")+'</span></div></div>'+
        '<div class="rvmini">'+esc("有月销")+" "+v(s["有月销"])+" · "+esc("多档价")+" "+v(s["多链接"])+" · "+esc("疑钩子")+" "+v(s["疑钩子"])+'</div></div>';
    }).join("")+'</div>';
    h += '<div class="rvfilters">'+["全部","月销20+","我们没有","多档价·钩子"].map(function(x,i){
      return '<button data-f="'+i+'" class="'+(i===0?'on':'')+'">'+esc(x)+'</button>';
    }).join("")+'</div><div id="rvdetail"></div>';
    h += '<div class="blind"><b>'+esc("这层盲区")+'</b><ul>'+(d.caveats||[]).map(function(x){return '<li>'+esc(x)+'</li>'}).join("")+'</ul></div>';
    var draw = function(dd, f){
      var rows = dd.rows||[];
      if (f===1) rows = rows.filter(function(r){ return Number(r["月销"])>=20; });
      if (f===2) rows = rows.filter(function(r){ return r["我方有没有"]===false; });
      if (f===3) rows = rows.filter(function(r){ return r.flag==="三档价" || r.flag==="疑钩子价"; });
      return '<div class="tw"><table class="g rvtbl"><tr>'+["商品","月销","已售","链接","实付","标价","提示","我方","店内分类"].map(function(x){return '<th>'+esc(x)+'</th>'}).join("")+'</tr>'+
        rows.map(function(r){
          var flag = r.flag==="三档价" ? '<span class="pill2 p-exp">'+esc("多档价")+'</span>' : (r.flag==="疑钩子价" ? '<span class="pill2 p-none">'+esc("疑钩子价")+'</span>' : na);
          var mine = r["我方有没有"]===true ? '<span class="pill2 p-up">'+esc("我们有")+'</span>' : (r["我方有没有"]===false ? '<span class="pill2 p-grade">'+esc("没有")+'</span>' : na);
          return '<tr><td class="rvprod"><b title="'+esc(raw(r["品名"]))+'">'+v(r["品名"])+'</b><small>'+v(r["规格"])+' · '+v(r["条码"])+'</small></td>'+
            '<td class="r">'+v(r["月销"])+'</td><td class="r soldref">'+v(r["已售"])+'</td><td class="r">'+v(r["链接数"])+'</td>'+
            '<td class="r">'+band(r["实付最低"],r["实付最高"])+'</td><td class="r strike">'+band(r["标价最低"],r["标价最高"])+'</td>'+
            '<td>'+flag+'</td><td>'+mine+'</td><td>'+v(r["店内分类"])+'</td></tr>';
        }).join("")+'</table></div>'+(dd.truncated?'<p class="gwhy">'+esc("只列了前 "+raw(dd.shown)+" 条(共 "+raw(dd.total)+" 条)。")+'</p>':'');
    };
    setTimeout(function(){
      var dd = detail, f = 0;
      $("rvdetail").innerHTML = draw(dd,f);
      document.querySelectorAll(".rvfilters button").forEach(function(b){ b.onclick=function(){
        f = Number(this.dataset.f);
        document.querySelectorAll(".rvfilters button").forEach(function(x){x.classList.toggle("on", x===b)});
        $("rvdetail").innerHTML = draw(dd,f);
      };});
      document.querySelectorAll(".rvcard[data-shop]").forEach(function(c){ c.onclick=async function(){
        document.querySelectorAll(".rvcard").forEach(function(x){x.classList.toggle("on", x===c)});
        dd = await get("db/petstore-rival-catalog?shop="+encodeURIComponent(c.dataset.shop));
        $("rvdetail").innerHTML = (dd.error || dd.ok===false) ? '<div class="blind">'+esc("🔴 "+(dd.error||dd.message||"取数失败"))+'</div>' : draw(dd,f);
      };});
    },0);
    return h;
  },

  l9: async function(){
    var d = await get("db/petstore-rival-pk");
    if (d.error || d.ok===false) return verdict("🔴 "+(d.error||d.message||"取数失败"),"red"), "";
    verdict(d.verdict, /^🔴/.test(d.verdict) ? "red" : "ok");
    if (!$("rivalstyle")) {
      var st = document.createElement("style");
      st.id = "rivalstyle";
      st.textContent = ".rivals{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:10px;margin:10px 0 12px}.rvcard{border:1px solid #d8dee6;background:#fff;border-radius:6px;padding:10px;cursor:pointer}.rvcard.on{border-color:#1d72d2;box-shadow:0 0 0 2px #dcebff;background:#f8fbff}.rvtop{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.rvname{font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rvdate{color:#6b7280;font-size:12px;white-space:nowrap}.rvnums{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:8px}.rvnums b{display:block;font-size:18px}.rvnums span{color:#6b7280;font-size:12px}.rvmini{margin-top:8px;color:#6b7280;font-size:12px}.rvbar{background:#fff4df;border-left:4px solid #f59e0b;padding:9px 11px;margin:0 0 10px;font-weight:700;color:#8a4b00}.rvfilters{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.rvfilters button{border:1px solid #d8dee6;background:#fff;border-radius:5px;padding:6px 10px;cursor:pointer}.rvfilters button.on{background:#e8f1ff;border-color:#9fc3ff;color:#1455a3;font-weight:700}.strike{text-decoration:line-through;color:#8b96a8}.soldref{color:#8b96a8}.rvprod{max-width:300px}.rvprod b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rvprod small{display:block;color:#6b7280;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.shoplist{font-size:12px;line-height:1.5;max-width:240px}.shoplist div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rvtbl{min-width:900px}.rvtbl td.r,.rvtbl th.r{white-space:nowrap}.checkbad{background:#ffe8e8;border-left:4px solid #ce2f36;padding:8px 10px;margin-top:10px;font-weight:700}.checkok{background:#e6f6ed;border-left:4px solid #17915a;padding:8px 10px;margin-top:10px;font-weight:700}.tier-green{color:#17915a}.tier-yellow{color:#c78405}.tier-red{color:#ce2f36}@media(max-width:980px){.rivals{grid-template-columns:repeat(2,1fr)}}@media(max-width:620px){.rivals{grid-template-columns:1fr}}";
      document.head.appendChild(st);
    }
    var ov = d.overview||{}, na = '<span class="na">—</span>';
    var v = function(x){ return (x===null||x===undefined||x==="") ? na : esc(x); };
    var raw = function(x){ return (x===null||x===undefined||x==="") ? "—" : String(x); };
    var money = function(x){ return (x===null||x===undefined||x==="") ? na : "¥"+Number(x).toFixed(2); };
    var band = function(a,b){ if (a===null||a===undefined||a==="") return na; return Number(a)===Number(b) ? money(a) : money(a)+" ~ "+money(b); };
    var yn = function(x){ return x===true ? '<span class="pill2 p-up">'+esc("能报")+'</span>' : (x===false ? '<span class="pill2 p-grade">'+esc("不能报")+'</span>' : na); };
    $("n9").textContent = ov.pk_total==null ? "" : ov.pk_total;
    var h = '<p class="why">'+esc("竞店 "+raw(ov["采于_竞店"])+" · 活动表 "+raw(ov["采于_活动"])+" · 我方实时")+'</p>';
    (d.groups||[]).forEach(function(g){
      h += '<div class="grp"><h3><span class="dot '+(g.tier==="green"?"d-grn":(g.tier==="yellow"?"d-yel":(g.tier==="red"?"d-red":"d-gry")))+'"></span><span class="tier-'+esc(g.tier||"gray")+'">'+esc(raw(g.label))+'</span><span class="c">'+v(g.count)+'</span></h3>';
      h += '<div class="tw"><table class="g rvtbl"><tr>'+["商品","附近月销","几家","附近实付","活动价上限","我方","价差","各家在卖"].map(function(x){return '<th>'+esc(x)+'</th>'}).join("")+'</tr>'+
        (g.rows||[]).map(function(r){
          var mine = r["我方品名"] ? esc(raw(r["我方品名"]))+'<br>'+money(r["我方售价"])+' · '+esc("库存")+v(r["我方库存"]) : '<span class="pill2 p-grade">'+esc("我们没有")+'</span>';
          var gp = r["价差百分比"], gcls = gp==null ? "" : (Number(gp)>0 ? "hi" : (Number(gp)<0 ? "lo" : ""));
          var sellers = (r["各家在卖"]||[]).map(function(s){
            var shop = raw(s.shop), shortShop = shop.length>14 ? shop.slice(0,14)+"…" : shop;
            return '<div title="'+esc(shop)+'">'+esc(shortShop)+" "+(s.price==null?esc("—"):"¥"+esc(Number(s.price).toFixed(2)))+" · "+v(s.ms)+esc("件")+'</div>';
          }).join("") || na;
          return '<tr><td class="rvprod"><b title="'+esc(raw(r["平台在推"]))+'">'+v(r["平台在推"])+'</b><small>'+v(r["条码"])+'</small></td>'+
            '<td class="r">'+v(r["附近月销"])+'</td><td class="r">'+v(r["几家在卖"])+'</td><td class="r">'+band(r["附近最低实付"],r["附近最高实付"])+'</td>'+
            '<td class="r">'+money(r["活动价上限"])+'<br>'+yn(r["能不能报"])+'</td><td>'+mine+'</td>'+
            '<td class="r '+gcls+'">'+(gp==null?na:(Number(gp)>0?'+':'')+esc(gp)+'%')+'</td><td class="shoplist">'+sellers+'</td></tr>';
        }).join("")+'</table></div>';
      if (g.truncated) h += '<p class="gwhy">'+esc("只列了前 "+raw(g.shown)+" 条(共 "+raw(g.count)+" 条)。")+'</p>';
      h += '</div>';
    });
    var sc = ov.self_check||{}, ok = sc.ok===true;
    h += '<div class="'+(ok?'checkok':'checkbad')+'">'+esc("自校验:三档合计 "+raw(sc["三档计数相加"])+" = 能对上条码且附近有销量的 "+raw(sc["能对上条码且附近月销大于0的活动数"])+" "+(ok?"✅":"🔴"))+'</div>';
    h += '<div class="blind"><b>'+esc("这层盲区")+'</b><ul>'+(d.caveats||[]).map(function(x){return '<li>'+esc(x)+'</li>'}).join("")+'</ul></div>';
    return h;
  },

  l11: async function(){
    var d = await get("db/petstore-rival-merged?filter=hot&limit=300");
    if (d.error || d.ok===false) return verdict("🔴 "+(d.error||d.message||"取数失败"),"red"), "";
    verdict(d.verdict, /^🔴/.test(d.verdict) ? "red" : "ok");

    function addStyle(){
      if ($("#cm-l11-style")) return;
      var s = document.createElement("style");
      s.id = "cm-l11-style";
      s.textContent = ".cm-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 12px}.cm-tab{border:1px solid #d7dde8;background:#fff;border-radius:8px;padding:7px 10px;cursor:pointer;color:#334155}.cm-tab.cm-on{background:#0f172a;color:#fff;border-color:#0f172a}.cm-tab b{font-weight:700}.cm-meta{color:#64748b;font-size:12px;margin:0 0 8px}.cm-wrap{overflow-x:auto}.cm-table{width:100%;min-width:1180px;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}.cm-table th,.cm-table td{border-bottom:1px solid #e2e8f0;padding:10px 12px;text-align:left;vertical-align:top}.cm-table th{background:#f8fafc;color:#334155;font-size:12px;font-weight:700;white-space:nowrap}.cm-table tr:last-child td{border-bottom:0}.cm-product{font-weight:700;color:#0f172a;max-width:330px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cm-sub{font-size:12px;color:#64748b;margin-top:3px}.cm-shop-line{line-height:1.45;margin-bottom:4px;white-space:nowrap}.cm-shop-line.cm-extra{display:none}.cm-shop-list.cm-open .cm-extra{display:block}.cm-shop-list.cm-open .cm-cats{display:block}.cm-price-bad{text-decoration:line-through;color:#94a3b8}.cm-fake{color:#dc2626;font-size:12px;margin-left:5px}.cm-cats{display:none;color:#94a3b8;font-size:12px;margin:1px 0 4px 0;white-space:normal}.cm-more{border:0;background:#eef2ff;color:#3730a3;border-radius:6px;padding:3px 7px;cursor:pointer;font-size:12px}.cm-low{font-size:20px;font-weight:800;color:#0f172a;white-space:nowrap}.cm-low-shop{font-size:12px;color:#64748b;margin-top:2px}.cm-miss,.cm-dash{color:#94a3b8}.cm-red{color:#dc2626;font-weight:700}.cm-green{color:#16a34a;font-weight:700}.cm-yellow{color:#a16207;font-weight:700}.cm-tag{display:inline-block;border-radius:6px;padding:3px 7px;font-size:12px;font-weight:700}.cm-hook{background:#fee2e2;color:#991b1b}.cm-volume{background:#dcfce7;color:#166534}.cm-profit{background:#dbeafe;color:#1e40af}.cm-empty{padding:24px;color:#64748b;text-align:center}.cm-head-small{display:block;color:#94a3b8;font-size:11px;font-weight:400;margin-top:2px}";
      document.head.appendChild(s);
    }
    function text(x){ return x == null ? "—" : esc(String(x)); }
    function fmt(x){
      if (x == null) return "—";
      var n = Number(x);
      if (!isFinite(n)) return esc(String(x));
      return String(Math.round(n * 100) / 100);
    }
    function money(x){ return x == null ? "—" : "¥" + fmt(x); }
    function pct(x){
      if (x == null) return "—";
      var n = Number(x);
      if (!isFinite(n)) return "—";
      n = Math.round(Math.abs(n) * 10) / 10;
      return fmt(n) + "%";
    }
    function hasCost(rows){
      var i;
      for (i=0;i<rows.length;i++) if (rows[i] && ("mine_cost" in rows[i])) return true;
      return false;
    }
    function tabNum(o, key){
      return o && o[key] != null ? fmt(o[key]) : "—";
    }
    function shopRank(s){
      var x = s && s.shop_short != null ? String(s.shop_short) : "";
      if (x === "邻小虎") return 0;
      if (x === "爪壮壮") return 1;
      return 2;
    }
    function shopsHtml(row){
      var shops = row.shops || [];
      var arr = shops.slice(0).sort(function(a,b){
        var ra = shopRank(a), rb = shopRank(b);
        if (ra !== rb) return ra - rb;
        return String(a.shop_short || a.shop || "").localeCompare(String(b.shop_short || b.shop || ""));
      });
      var out = '<div class="cm-shop-list">';
      var i, s, cls, p, cats;
      for (i=0;i<arr.length;i++){
        s = arr[i] || {};
        cls = i >= 2 ? " cm-extra" : "";
        p = money(s.real_price);
        if (s.price_usable === false) p = '<span class="cm-price-bad">' + p + '</span>';
        out += '<div class="cm-shop-line' + cls + '"><b>' + text(s.shop_short || s.shop) + '</b> ' + p + ' <span class="cm-sub">(月销' + text(s.month_sale) + ')</span>';
        if (s.fake_reason) out += '<span class="cm-fake">' + text(s.fake_reason) + '</span>';
        out += '</div>';
        cats = s.shop_cats && s.shop_cats.length ? s.shop_cats.slice(0,3).join("，") : "";
        if (cats) out += '<div class="cm-cats' + cls + '">' + text(cats) + '</div>';
      }
      if (arr.length > 2) out += '<button class="cm-more" data-closed="+' + (arr.length - 2) + '家 ▾">+' + (arr.length - 2) + '家 ▾</button>';
      out += '</div>';
      return out;
    }
    function lowHtml(row){
      var title = row.low_price == null && row.low_fake_reason ? ' title="' + text(row.low_fake_reason) + '"' : "";
      return '<div' + title + '><div class="cm-low">' + money(row.low_price) + '</div><div class="cm-low-shop">' + text(row.low_shop) + '</div></div>';
    }
    function mineHtml(row){
      if (row.mine_code == null) return '<span class="cm-miss">我们没有</span>';
      return '<div>' + money(row.mine_price) + '<div class="cm-sub">库存 ' + text(row.mine_stock) + ' / ' + text(row.mine_status) + '</div></div>';
    }
    function gapHtml(row){
      var n = row.gap_pct;
      if (n == null) return '<span class="cm-dash">—</span>';
      n = Number(n);
      if (!isFinite(n)) return '<span class="cm-dash">—</span>';
      if (n > 0) return '<span class="cm-red">贵' + pct(n) + '</span>';
      if (n < 0) return '<span class="cm-green">便宜' + pct(n) + '</span>';
      return "持平";
    }
    function tierHtml(t){
      if (t == null) return '<span class="cm-dash">—</span>';
      if (t === "hook") return '<span class="cm-tag cm-hook">钩子</span>';
      if (t === "volume") return '<span class="cm-tag cm-volume">走量</span>';
      if (t === "profit") return '<span class="cm-tag cm-profit">利润</span>';
      return text(t);
    }
    function canHtml(x){
      if (x == null) return '<span class="cm-dash">—</span>';
      var c = String(x), cls = "";
      if (c === "可跟") cls = "cm-green";
      else if (c.indexOf("破成本") >= 0) cls = "cm-red";
      else cls = "cm-yellow";
      return '<span class="' + cls + '">' + text(c) + '</span>';
    }
    function render(x, active){
      var o = x.overview || {}, rows = x.rows || [], cost = hasCost(rows), h = "";
      h += '<div class="cm-tabs">';
      h += '<button class="cm-tab ' + (active==="hot"?"cm-on":"") + '" data-filter="hot">可比且热销 <b>' + tabNum(o,"可比且热销") + '</b></button>';
      h += '<button class="cm-tab ' + (active==="shared"?"cm-on":"") + '" data-filter="shared">两家以上共有 <b>' + tabNum(o,"两家以上共有") + '</b></button>';
      h += '<button class="cm-tab ' + (active==="mine"?"cm-on":"") + '" data-filter="mine">我方也有 <b>' + tabNum(o,"我方也有") + '</b></button>';
      h += '<button class="cm-tab ' + (active==="nomine"?"cm-on":"") + '" data-filter="nomine">我们没有 <b>—</b></button>';
      h += '<button class="cm-tab ' + (active==="all"?"cm-on":"") + '" data-filter="all">全部 <b>' + tabNum(o,"去重后商品数") + '</b></button>';
      h += '</div><div class="cm-meta">导出日期 ' + text(x.export_date) + ' · 原始行数 ' + tabNum(o,"原始行数") + ' · 条码数 ' + tabNum(o,"条码数") + '</div>';
      h += '<div class="cm-wrap" style="overflow-x:auto"><table class="cm-table"><thead><tr><th>商品</th><th>附近各店</th><th>最低价</th><th>淘宝<span class="cm-head-small">待接</span></th><th>拼多多<span class="cm-head-small">待接</span></th><th>我方</th><th>价差</th>';
      if (cost) h += '<th>成本</th><th>跟价后毛利</th><th>能不能跟</th>';
      h += '<th>月销合计</th><th>层</th></tr></thead><tbody>';
      if (!rows.length) h += '<tr><td colspan="' + (cost ? 12 : 9) + '" class="cm-empty">暂无数据</td></tr>';
      for (var i=0;i<rows.length;i++){
        var r = rows[i] || {};
        h += '<tr><td><div class="cm-product" title="' + text(r.name) + '">' + text(r.name) + '</div><div class="cm-sub">' + text(r.barcode) + '</div><div class="cm-sub">' + text(r.spec) + '</div></td>';
        h += '<td>' + shopsHtml(r) + '</td><td>' + lowHtml(r) + '</td><td><span class="cm-dash">—</span></td><td><span class="cm-dash">—</span></td>';
        h += '<td>' + mineHtml(r) + '</td><td>' + gapHtml(r) + '</td>';
        if (cost) h += '<td>' + money(("mine_cost" in r) ? r.mine_cost : null) + '</td><td>' + (r.margin_if_match == null ? '<span class="cm-dash">—</span>' : pct(r.margin_if_match)) + '</td><td>' + canHtml(r.can_match) + '</td>';
        h += '<td>' + text(r.month_sale_total) + '</td><td>' + tierHtml(r.tier) + '</td></tr>';
      }
      h += '</tbody></table></div>';
      return h;
    }
    function bind(){
      var root = $("#cm-l11");
      if (!root) return;
      var tabs = root.querySelectorAll(".cm-tab");
      for (var i=0;i<tabs.length;i++) tabs[i].onclick = function(){
        var f = this.getAttribute("data-filter");
        get("db/petstore-rival-merged?filter=" + encodeURIComponent(f) + "&limit=300").then(function(nd){
          if (nd.error || nd.ok===false) return verdict("🔴 "+(nd.error||nd.message||"取数失败"),"red");
          verdict(nd.verdict, /^🔴/.test(nd.verdict) ? "red" : "ok");
          root.innerHTML = render(nd, f);
          bind();
        });
      };
      var more = root.querySelectorAll(".cm-more");
      for (var j=0;j<more.length;j++) more[j].onclick = function(){
        var list = this.parentNode;
        var open = list.className.indexOf("cm-open") < 0;
        list.className = open ? "cm-shop-list cm-open" : "cm-shop-list";
        this.innerHTML = open ? "收起 ▴" : this.getAttribute("data-closed");
      };
    }
    addStyle();
    setTimeout(function(){ bind(); },0);
    return '<div id="cm-l11">' + render(d, "hot") + '</div>';
  },
  l10: async function(){
    var d = await get("db/petstore-nearby-live");
    if (d.error || d.ok===false) return verdict("🔴 "+(d.error||d.message||"取数失败"),"red"), "";
    verdict(d.verdict, /^🔴/.test(d.verdict) ? "red" : "ok");
    var ov = d.overview||{}, groups = d.groups||[], na = '<span class="na">—</span>';
    var v = function(x){ return (x===null||x===undefined||x==="") ? na : esc(String(x)); };
    var money = function(x){ return (x===null||x===undefined||x==="") ? na : esc("¥"+Number(x).toFixed(2)); };
    var cut = function(x,n){ x = (x===null||x===undefined) ? "" : String(x); return x.length>n ? x.slice(0,n)+"…" : x; };
    var dist = function(x){
      if (x===null||x===undefined||x==="") return na;
      x = Number(x);
      return x<1000 ? esc(String(Math.round(x))+"m") : esc(String((x/1000).toFixed(1))+"km");
    };
    var dot = function(t){ return t==="red" ? "d-red" : (t==="orange" ? "d-yel" : "d-gry"); };
    var flavor = function(a){
      a = a||[];
      return a.length ? a.map(function(x){ return '<span class="pill2 p-grade">'+esc(String(x))+'</span>'; }).join("") : '<span class="dim">'+esc("未标口味")+'</span>';
    };
    var doubt = function(r){
      var rv = r.review||null, s = "";
      if (rv) {
        if (rv.verdict==="real_gap") s = '<span class="pill2 p-grade">'+esc("✅确认差价")+'</span>';
        if (rv.verdict==="spec_mismatch") s = '<span class="pill2 p-warn">'+esc("规格对错了→")+'</span>'+v(rv.correct_spec);
        if (rv.verdict==="our_sku_dirty") s = '<span class="pill2 p-warn">'+esc("🔧我方档案要修")+'</span>';
        if (rv.verdict==="not_same_product") s = '<span class="pill2 p-none">'+esc("非同一品")+'</span>';
        if (rv.verdict==="cannot_verify") s = '<span class="pill2 p-none">'+esc("核不了")+'</span>';
        if (rv.price_changed) s += ' <span class="todo">'+esc("价已变")+'</span>';
        return s || '<span class="dim">'+esc("—")+'</span>';
      }
      if (r.mine_level!=="exact") return '<span class="dim">'+esc("—")+'</span>';
      if (r.doubt_level==="high") return '<span class="pill2 p-none">'+esc((r.doubts||[]).join("/"))+'</span>';
      if (r.doubt_level==="warn") return '<span class="pill2 p-warn">'+esc((r.doubts||[]).join("/"))+'</span>';
      return "";
    };
    if ($("n10")) $("n10").textContent = ov["商品数"]==null ? "" : String(ov["商品数"]);
    var h = '<div class="cov">'+esc("附近 "+String(ov["店数"]||0)+" 家店 · "+String(ov["商品数"]||0)+" 个商品("+String(ov["有月销的商品数"]||0)+" 个有月销) · 3km 内 "+String(ov["三公里内店数"]||0)+" 家 | 我方对上 "+String(ov["我方exact命中数"]||0)+" 个(同规格) + "+String(ov["我方brand命中数"]||0)+" 个(同品牌) | 已核查 "+String(ov["已核查数"]||0)+" 个 · 确认真差价 "+String(ov["确认真差价数"]||0)+" 个 · 档案要修 "+String(ov["我方档案要修数"]||0)+" 个 | 采于 ")+v(d.captured_at)+(Number(d.stale_days)>3?' <span class="todo">'+esc("(已过 "+String(d.stale_days)+" 天,价格可能变了)")+'</span>':'')+'</div>';
    var order = {confirmed_gap:0, need_verify:1, sku_dirty:2, red:3, orange:4, gray:5};
    groups.sort(function(a,b){ return (order[a.key]||order[a.tier]||9)-(order[b.key]||order[b.tier]||9); }).forEach(function(gp){
      if (!Number(gp.count)) return;
      var rows = gp.rows||[];
      var tbl = '<div class="grp"><div class="h3"><span class="dot '+dot(gp.tier)+'"></span>'+v(gp.label)+' <span class="c">'+esc(String(gp.count))+'</span></div>'+
        (gp.key==="confirmed_gap"?'<p class="gwhy">'+esc("这些是核查过、确认同品同规格的真差价 —— 可以据此调价")+'</p>':(gp.key==="sku_dirty"?'<p class="gwhy">'+esc("我方商品档一个码挂了多个规格,价格只有一个 —— 匹配算法再准也对不上,要先修档案")+'</p>':(gp.key==="need_verify"?'<p class="gwhy">'+esc("这些是自动匹配存疑的,⛔ 别直接照价差调价 —— 要先用 ADB+OCR 实地核一遍")+'</p>':'')))+
        '<div class="tw"><table class="g"><tr>'+["月销","附近价","划线价","店(距离)","我方","疑点","价差","口味","商品"].map(function(x){return '<th>'+esc(x)+'</th>';}).join("")+'</tr>'+
        rows.map(function(r){
          var nearby = r.price_usable===false ? '<s>'+money(r.price)+'</s> <span class="todo">'+v(r.fake_reason)+'</span>' : money(r.price);
          var mine = na;
          if (r.mine_level==="exact") mine = '<div class="amt">'+money(r.mine_price)+' · '+esc("存")+v(r.mine_stock)+'</div><div class="dim nm" title="'+esc(String(r.mine_name||""))+'">'+esc(cut(r.mine_name,18))+'</div>';
          if (r.mine_level==="brand") mine = '<span class="pill2 p-none">'+esc("同牌不同规")+'</span>';
          if (r.mine_level==="none") mine = '<span class="pill2 p-none">'+esc("我们没有")+'</span>';
          var gap = na;
          if (r.price_gap!==null && r.price_gap!==undefined && r.price_gap!=="") {
            var pg = Number(r.price_gap), p = Number(r.price), pct = p ? Math.round(Math.abs(pg)/p*100) : 0;
            gap = pg>0 ? '<span class="r p-up">'+esc("+¥"+Math.abs(pg).toFixed(2)+" (贵"+String(pct)+"%)")+'</span>' : (pg<0 ? '<span class="r p-dn">'+esc("-¥"+Math.abs(pg).toFixed(2)+" (便宜"+String(pct)+"%)")+'</span>' : esc("¥0.00 (0%)"));
          }
          return '<tr><td class="r mono">'+v(r.month_sales)+'</td><td class="r amt">'+nearby+'</td><td class="r">'+money(r.orig_price)+'</td>'+
            '<td><div class="nm" title="'+esc(String(r.shop||""))+'">'+esc(cut(r.shop,12))+'</div><div class="dim">'+dist(r.distance_m)+'</div></td>'+
            '<td>'+mine+'</td><td>'+doubt(r)+'</td><td>'+gap+'</td><td>'+flavor(r.flavors)+'</td><td><div class="nm" title="'+esc(String(r.title||""))+'">'+(r.picture?'<img src="'+esc(String(r.picture))+'" onerror="this.style.display=\'none\'" style="width:28px;height:28px;object-fit:cover;vertical-align:middle;margin-right:6px;border-radius:4px">':'')+v(r.title)+'</div><div class="dim">'+v(r.keyword)+'</div></td></tr>';
        }).join("")+'</table></div>'+(gp.truncated?'<p class="gwhy">'+esc("只列了前 "+String(rows.length)+" 条(共 "+String(gp.count)+" 条)。")+'</p>':'')+'</div>';
      h += gp.tier==="gray" ? '<details><summary>'+v(gp.label)+' <span class="c">'+esc(String(gp.count))+'</span></summary>'+tbl+'</details>' : tbl;
    });
    h += '<div class="blind"><b>'+esc("这层盲区")+'</b><ul>'+(d.caveats||[]).map(function(x){return '<li>'+esc(String(x))+'</li>';}).join("")+'</ul></div>';
    return h;
  },

  // ── 第6层 问题商品 ──
  l6: async function(){
    var d = await get("db/petstore-problem-goods");
    if (d.error || d.ok===false) return verdict("🔴 "+(d.error||d.message||"取数失败"),"red"), "";
    verdict(d.verdict + " · 全店 "+(d.total||0).toLocaleString("zh-CN")+" 个规格,有货 "+(d.in_stock||0),
      /^🔴/.test(d.verdict) ? "red" : "ok");
    var money = function(x){ return "¥"+Number(x||0).toLocaleString("zh-CN"); };
    var TIER = {red:"d-red", yellow:"d-yel", green:"d-grn"};
    var na = '<span class="na">—</span>';
    var h = "";
    (d.groups||[]).forEach(function(g){
      if (!g.count) return;
      h += '<div class="grp"><h3><span class="dot '+(TIER[g.tier]||"d-gry")+'"></span>'+esc(g.label)+
        '<span class="c">'+g.count+'</span>'+
        '<span class="amt">'+(Number(g.amount_by_price)>0?'占款 '+money(g.amount_by_price)+' · ':'')+
        '该做:'+esc(g.todo)+'</span></h3><p class="gwhy">'+esc(g.why)+'</p>';
      h += '<div class="tw"><table class="g"><tr>'+
        ['商品编码','品名','规格','货位','状态','库存<sup>快照/在册</sup>','品类','到期日期','月销','占款']
          .concat(g.key==="data_gap"?['缺什么']:[])
          .map(function(x){return '<th>'+x+'</th>'}).join("")+'</tr>'+
        g.rows.map(function(r){
          var a=r.stock_num, b=r.cur_stock;
          var stk = (a===null&&b===null) ? na
            : (Number(a||0)!==Number(b||0)
               ? '<span class="diff">'+(a===null?"—":a)+' <b>/</b> '+(b===null?"—":b)+'</span>'
               : (Number(a||0)<0 ? '<span class="neg">'+a+'</span>' : String(a===null?0:a)));
          return '<tr>'+
            '<td class="mono">'+esc(r.product_code)+'</td>'+
            '<td class="nm" title="'+esc(r.product_name||"")+'">'+esc(r.product_name)+'</td>'+
            '<td>'+(r.spec_text?esc(r.spec_text):na)+'</td>'+
            '<td class="mono">'+(r.shelf_code?esc(r.shelf_code):'<span class="todo">无货位</span>')+'</td>'+
            '<td>'+(r.product_status==="UP"?'<span class="pill2 p-up">在售</span>'
                  :(r.product_status?'<span class="pill2 p-dn">'+esc(r.product_status)+'</span>'
                  :'<span class="pill2 p-none">无状态</span>'))+'</td>'+
            '<td class="r">'+stk+'</td>'+
            '<td>'+(r.category_l1?esc(r.category_l1):na)+'</td>'+
            '<td class="mono">'+(r.expiration_date?esc(String(r.expiration_date).slice(0,10))
                  :'<span class="todo">未录</span>')+'</td>'+
            '<td class="r">'+(r.month_sale==null?na:esc(r.month_sale))+'</td>'+
            '<td class="r">'+money(r.amount_by_price)+'</td>'+
            (g.key==="data_gap"?'<td>'+((r["缺什么"]||[]).map(function(x){return '<span class="pill2 p-none">'+esc(x)+'</span>';}).join(""))+'</td>':'')+
            '</tr>';
        }).join("")+'</table></div>';
      if (g.truncated) h += '<p class="gwhy">只列了前 '+g.shown+' 条(共 '+g.count+' 条) —— 这一档该批量处理。</p>';
      h += '</div>';
    });
    // ⛔「没问题」和「没查」必须分得开 —— 查过是 0 的也要显示出来
    if (d.clean && d.clean.length) {
      h += '<div class="grp"><h3><span class="dot d-grn"></span>查过 · 当前没问题'+
        '<span class="c">'+d.clean.length+'</span></h3><div class="okrow">'+
        d.clean.map(function(c){ return '<span class="ok'+(c.count?" bad":"")+'">'+
          (c.count?"🔴 ":"✅ ")+esc(c.label)+' '+c.count+'</span>'; }).join("")+'</div></div>';
    }
    h += '<div class="blind"><b>这层怎么算的</b><ul>'+
      (d.caveats||[]).map(function(c){return '<li>'+esc(c)+'</li>'}).join("")+'</ul></div>';
    return h;
  },
  // ── 第5层 效期风险 ──
  l5: async function(){
    var d = await get("db/petstore-expiry-risk");
    if (d.error || d.ok===false) return verdict("🔴 "+(d.error||d.message||"取数失败"),"red"), "";
    var s = d.summary||{};
    verdict(d.verdict, /^🔴/.test(d.verdict) ? "red" : (/^🟡/.test(d.verdict) ? "warn" : "ok"));
    var money = function(x){ return "¥"+Number(x||0).toLocaleString("zh-CN"); };
    var TIER = {red:"d-red", yellow:"d-yel", green:"d-grn"};
    var hasPerishable = s.perishable!==undefined && s.perishable!==null;
    var h;
    if (hasPerishable) {
      var inStock = Number(s.in_stock||0);
      var perishable = Number(s.perishable||0);
      var supplies = inStock - perishable;
      // 覆盖率分母是会坏的品(perishable),不是全部有货规格;用品不看保质期。
      h = '<div class="cov'+(s.dated_pct<50?' bad':'')+'">有货 <b>'+
        esc(String(inStock.toLocaleString("zh-CN")))+'</b> 个规格,其中【会坏的】<b>'+esc(String(perishable.toLocaleString("zh-CN")))+'</b> 个;这 '+
        esc(String(perishable.toLocaleString("zh-CN")))+' 个里 <b>'+esc(String(s.dated||0))+'</b> 个有日期('+
        esc(String(s.dated_pct||0))+'%),<b>'+esc(String(s.undated||0))+'</b> 个没有。'+
        '其余 <b>'+esc(String(supplies.toLocaleString("zh-CN")))+'</b> 个是用品,不看保质期。'+
        '日期快照拉取于 <b>'+esc(s.captured||"?")+'</b>'+
        (s.stale_days>2 ? '(已停 '+esc(String(s.stale_days))+' 天,这段时间到的货不在里面)' : '')+'</div>';
    } else {
      // 旧后端没有 perishable 时不能算分母,只显示有货数和快照日期。
      h = '<div class="cov'+(s.dated_pct<50?' bad':'')+'">有货 <b>'+
        esc(String((s.in_stock||0).toLocaleString("zh-CN")))+'</b> 个规格。'+
        '日期快照拉取于 <b>'+esc(s.captured||"?")+'</b></div>';
    }

    (d.groups||[]).forEach(function(g){
      if (!g.count) return;
      h += '<div class="grp"><h3><span class="dot '+(TIER[g.tier]||"d-gry")+'"></span>'+esc(g.label)+
        '<span class="c">'+esc(String(g.count))+'</span>'+
        '<span class="c'+(g.up_count_tier==="red"?' bad':"")+'">其中在售 '+esc(String(g.up_count||0))+'</span>'+
        '<span class="amt">占款 '+money(g.amount_by_price)+'</span></h3>'+
        '<p class="gwhy">'+esc(g.why)+'</p>';
      if (g.rows && g.rows.length) {
        h += '<div class="tw"><table class="g"><tr>'+
          ['商品编码','品名','规格','货位','状态','库存','到期日期','剩余','月销','占款(按售价)']
            .map(function(x){return '<th>'+x+'</th>'}).join("")+'</tr>'+
          g.rows.map(function(r){
            var dd = r.days_to_expire;
            var lf = (dd===null||dd===undefined) ? '<span class="todo">无日期</span>'
              : (dd<0 ? '<span class="pill2 p-none">已过期 '+esc(String(-dd))+' 天</span>'
              : (dd<=30 ? '<span class="pill2 p-none">'+esc(String(dd))+' 天</span>'
              : (dd<=90 ? '<span class="pill2 p-warn">'+esc(String(dd))+' 天</span>' : '<span class="dim">'+esc(String(dd))+' 天</span>')));
            return '<tr>'+
              '<td class="mono">'+esc(r.product_code)+'</td>'+
              '<td class="nm" title="'+esc(r.product_name||"")+'">'+esc(r.product_name)+'</td>'+
              '<td>'+esc(r.spec_text||"")+'</td>'+
              '<td class="mono">'+(r.shelf_code?esc(r.shelf_code):'<span class="todo">无货位</span>')+'</td>'+
              '<td>'+(r.product_status==="UP"?'<span class="pill2 p-up">在售</span>'
                    :'<span class="pill2 p-dn">'+esc(r.product_status||"—")+'</span>')+'</td>'+
              '<td class="r">'+esc(r.stk)+'</td>'+
              '<td class="mono">'+(r.expiration_date?esc(String(r.expiration_date).slice(0,10))
                    :'<span class="todo">未录</span>')+'</td>'+
              '<td class="r">'+lf+'</td>'+
              '<td class="r">'+esc(r.month_sale==null?"—":String(r.month_sale))+'</td>'+
              '<td class="r">'+money(r.amount_by_price)+'</td></tr>';
          }).join("")+'</table></div>';
        if (g.truncated) h += '<p class="gwhy">只列了前 '+esc(String(g.shown))+' 条(共 '+esc(String(g.count))+' 条) —— '+
          '这一档太多,该做的是批量补录,不是一条条看。</p>';
      }
      h += '</div>';
    });
    var sc = d.summary && d.summary.self_check;
    if (sc) h += '<div class="'+(sc.ok===true?'checkok':'checkbad')+'">'+esc(sc.verdict)+'</div>';
    h += '<div class="blind"><b>这层数字能信到什么程度</b><ul>'+
      (d.caveats||[]).map(function(c){return '<li>'+esc(c)+'</li>'}).join("")+'</ul></div>';
    return h;
  },

  list: function(){ return renderList("shop"); },
  listall: function(){ return renderList("all"); },

  cat: async function(){
    var d = await get("db/petstore-catalog-overview?storeCode=63350001");
    if (d.error) return verdict("🔴 "+d.error,"red"), "";
    verdict(d.headline, d.verdict==="red"?"red":"ok");
    var s = d.scale, c = d.completeness || {};
    var money=function(n){return n==null?"—":Number(n).toLocaleString("zh-CN")};
    var h = '<div class="big">'+
      '<div><div class="k">商品主表</div><div class="v">'+money(s.master)+'</div><div class="s">SPU '+money(s.spu)+' 个</div></div>'+
      '<div><div class="k">门店在册</div><div class="v">'+money(s.store_rows)+'</div><div class="s">条码表 '+money(s.barcode_rows)+' 行</div></div>'+
      '<div><div class="k">上架</div><div class="v '+(c.listed_pct<50?"warn":"ok")+'">'+money(c.listed)+'</div>'+
        '<div class="s">'+(c.listed_pct==null?"—":c.listed_pct+"% · 没上架的搜不到")+'</div></div>'+
      '<div><div class="k">有货</div><div class="v">'+money(c.in_stock)+'</div>'+
        '<div class="s">'+(c.in_stock_pct==null?"—":c.in_stock_pct+"%")+'</div></div></div>';
    // 每日更新 —— Damon 要的就是这个
    resetWhy();
    h += grp("每日更新状态", d.daily_update.length,
      d.daily_update.map(function(u){return item(u.level, u.src, u.value, u.why)}).join(""));
    resetWhy();
    h += grp("商品库完整度", 4,
      item(c.listed_pct<50?"yellow":"green","上架", money(c.listed)+" / "+money(c.total)+" ("+c.listed_pct+"%)","没上架的顾客搜不到")+
      item("gray","有货", money(c.in_stock)+" ("+c.in_stock_pct+"%)","")+
      item(c.has_barcode>0?"green":"red","门店侧有条码", money(c.has_barcode)+" ("+(c.barcode_pct||0)+"%)","0 = 店员扫不了码,只能手输")+
      item(c.pic_pct!=null&&c.pic_pct<80?"yellow":"green","有图片", money(c.has_pic)+" ("+(c.pic_pct==null?"—":c.pic_pct+"%")+")","无图商品在外卖端基本不进搜索结果"));
    if (d.last_snapshot_at) h += '<div class="blind">最后一次快照:'+esc(String(d.last_snapshot_at).slice(0,16).replace("T"," "))+' UTC<br>'+esc(d.note||"")+'</div>';
    return h;
  },
  l4: async function(){
    var d = await get("db/petstore-product-insight?storeCode=63350001");
    if (d.error) return verdict("🔴 "+d.error,"red"), "";
    verdict(d.headline, d.verdict==="red"?"red":"ok");
    var v = {}; d.velocity.forEach(function(x){v[x.tier]=x});
    var pick=function(k){return v[k]||{n:0,stock_value:0,pct:0}};
    var money=function(n){return n==null?"—":"¥"+Number(n).toLocaleString("zh-CN")};
    // 大数:钱压在哪
    var h = '<div class="big">'+
      '<div><div class="k">库存总值</div><div class="v">'+money(d.total_stock_value)+'</div>'+
        '<div class="s">有货商品的进货价合计</div></div>'+
      '<div><div class="k">卖得动(fast+steady)</div><div class="v ok">'+(pick("fast").n+pick("steady").n)+'</div>'+
        '<div class="s">'+money(pick("fast").stock_value+pick("steady").stock_value)+'</div></div>'+
      '<div><div class="k">死货 dead</div><div class="v red">'+pick("dead").n+'</div>'+
        '<div class="s">'+money(pick("dead").stock_value)+' · '+pick("dead").pct+'%</div></div>'+
      '<div><div class="k">慢销 slow+stale</div><div class="v warn">'+(pick("slow").n+pick("stale").n)+'</div>'+
        '<div class="s">'+money(pick("slow").stock_value+pick("stale").stock_value)+'</div></div></div>';
    // 动销分层条
    var tot = d.velocity.reduce(function(a,x){return a+x.n},0);
    var COL={fast:"#17915a",steady:"#5aa87a",stale:"#e0a63c",slow:"#e08a3c","dead":"#ce2f36"};
    h += '<div class="grp"><h3>动销分层<span class="c">'+tot+' 个有货</span></h3><div style="padding:11px 13px">'+
      '<div class="bar">'+d.velocity.map(function(x){
        return '<i style="width:'+(x.pct||0)+'%;background:'+(COL[x.tier]||"#c3cbd8")+'"></i>'}).join("")+'</div>'+
      '<table class="t"><tr><th>分层</th><th class="r">个数</th><th class="r">占比</th><th class="r">占款</th></tr>'+
      d.velocity.map(function(x){return '<tr><td class="nm">'+esc(x.tier)+'</td><td class="r">'+x.n+
        '</td><td class="r">'+x.pct+'%</td><td class="r">'+money(x.stock_value)+'</td></tr>'}).join("")+
      '</table></div></div>';
    // 品牌
    h += '<div class="grp"><h3>自有品牌 vs 他人品牌<span class="c">'+d.brand.length+'</span></h3>'+
      '<div style="padding:0 13px 11px"><table class="t">'+
      '<tr><th>品牌</th><th class="r">SKU</th><th class="r">有货</th><th class="r">动销</th><th class="r">动销率</th><th class="r">占款</th></tr>'+
      d.brand.map(function(b){return '<tr><td class="nm">'+esc(b.name)+'</td><td class="r">'+b.skus+
        '</td><td class="r">'+b.in_stock+'</td><td class="r">'+b.moving+'</td><td class="r">'+
        (b.moving_pct==null?"—":b.moving_pct+"%")+'</td><td class="r">'+money(b.stock_value)+'</td></tr>'}).join("")+
      '</table></div></div>';
    // 品类
    h += '<div class="grp"><h3>品类结构<span class="c">'+d.category.length+'</span></h3>'+
      '<div style="padding:0 13px 11px"><table class="t">'+
      '<tr><th>品类</th><th class="r">SKU</th><th class="r">有货</th><th class="r">动销</th><th class="r">动销率</th><th class="r">占款</th></tr>'+
      d.category.map(function(c){
        var w = c.moving_pct!=null && c.moving_pct<10 ? ' style="color:#ce2f36;font-weight:700"' : '';
        return '<tr><td class="nm">'+esc(c.name)+'</td><td class="r">'+c.skus+'</td><td class="r">'+c.in_stock+
        '</td><td class="r">'+c.moving+'</td><td class="r"'+w+'>'+(c.moving_pct==null?"—":c.moving_pct+"%")+
        '</td><td class="r">'+money(c.stock_value)+'</td></tr>'}).join("")+
      '</table></div></div>';
    var cm = d.completeness;
    h += '<div class="grp"><h3>商品完整度<span class="c">'+cm.total+'</span></h3>'+
      item("yellow","上架", cm.listed+" / "+cm.total+" ("+cm.listed_pct+"%)", "没上架的顾客搜不到")+
      item(cm.no_barcode>0?"red":"green","无条码", cm.no_barcode, "门店侧扫不了码,店员只能手输")+
      item(cm.listed_but_oos>0?"yellow":"green","上架但缺货", cm.listed_but_oos, "顾客点进来是空的")+
      '</div>';
    if (d.note) h += '<div class="blind">'+esc(d.note)+'</div>';
    return h;
  },
  l3: async function(){
    var d = await get("db/petstore-health-issues?storeCode=63350001&pageSize=1");
    if (d.error) return verdict("🔴 "+d.error+" —— 第3层归组接口待建","warn"), "";
    verdict("第3层归组接口待建 —— 底层 petstore_health 已有 2,799 行","warn");
    return grp("现状", 1, item("yellow","petstore_health","已有数据","归组接口未建,先看第0-2层"));
  }
};

async function show(p){
  document.querySelectorAll(".snav").forEach(function(a){a.classList.toggle("on", a.dataset.p===p)});
  $("ttl").textContent = ({list:"金枋店 · 商品明细",listall:"总商品库 · 全量(含 0 库存)",l5:"效期风险",l6:"问题商品",l7:"比价罗盘",l10:"附近实时 · 美团H5",l11:"竞争品研究中心 · 四家店合并",l8:"竞店商品档",l9:"竞争商品档案 · PK",cat:"库存概况",l4:"产品分析",l0:"第0层 表注册表",l1:"第1层 真源状态",l2:"第2层 身份对齐",l3:"第3层 资料缺口"})[p];
  $("body").innerHTML = '<div class="verdict">读取中…</div>';
  try { $("body").innerHTML = await PAGES[p](); }
  catch(e){ verdict("🔴 "+e.message,"red"); $("body").innerHTML=""; }
}
document.addEventListener("click", function(e){
  var a = e.target.closest(".snav[data-p]"); if(a) show(a.dataset.p);
});
$("bsub").textContent = new Date().toISOString().slice(0,16).replace("T"," ")+" UTC";
$("ft").innerHTML = "数据源：腾讯 PG · petstore-api:9010 · 三个接口只读<br>" +
  "第0层每天 01:10 落一次快照(cron PET-0052)，次日起才有读写增量";
show("list");   // 默认打开产品分析 —— Damon 0903「加工层平时不用看」

// 金枋店(默认只看有货) 与 总商品库·全量(加工层) 共用这一个渲染器。
// mode="shop" → stock=instock,带「显示0库存」开关;mode="all" → 不加库存筛选。
// ⛔ 两个入口各自独立的筛选状态,互不串味。
async function renderList(mode){
  var SHOP = mode === "shop";
  var KEY = SHOP ? "__LQ" : "__LQA";
  if (!window[KEY]) window[KEY] = {page:1, pageSize:50, keyword:"", category:"", product_status:"",
                                   showZero: false};
  var q = window[KEY];
  var re = function(){ return renderInto(mode); };

    // 🔴 只有 shop 且没勾「显示0库存」时才加 stock=instock。全量页永不加。
    var onlyInStock = SHOP && !q.showZero;
    var base = "db/petstore-goods-list?page="+q.page+"&pageSize="+q.pageSize+
      "&keyword="+encodeURIComponent(q.keyword)+"&category="+encodeURIComponent(q.category)+
      "&product_status="+encodeURIComponent(q.product_status);
    var qs = base + (onlyInStock ? "&stock=instock" : "");
    delete cache[qs];
    var d = await get(qs);
    // 藏了多少必须说出来 —— ⛔不许静默过滤(店员漏补货的根)
    var hiddenTotal = null;
    if (onlyInStock) {
      var sig = "db/petstore-goods-list?page=1&pageSize=1"+
        "&keyword="+encodeURIComponent(q.keyword)+"&category="+encodeURIComponent(q.category)+
        "&product_status="+encodeURIComponent(q.product_status);
      var all = await get(sig);   // 走 cache,同筛选只查一次
      if (all && !all.error && typeof all.total === "number") hiddenTotal = all.total;
    }
    if (d.error || d.ok===false) return verdict("🔴 "+(d.error||d.message||"取数失败"),"red"), "";
    var rows = d.rows||[], sm = d.summary||{}, tot = d.total||0;
    // 🔴 接口是【按 SPU 分页】的:一页取 pageSize 个商品(SPU),再展开成它底下所有规格行,
    //    这样同一商品的多个规格永远不会被切到两页。所以页数分母是 SPU 数,不是 SKU 数。
    //    0907 实证:按 SKU 算得 59 页,而第 26 页起全空 —— 真实只有 ceil(1208/50)=25 页。
    var spu = sm.spu_total || 0;
    var pages = Math.max(1, Math.ceil(spu/q.pageSize));
    var filtered = !!(q.keyword||q.category||q.product_status);
    verdict(tot.toLocaleString("zh-CN")+" 个规格 / "+spu.toLocaleString("zh-CN")+" 个商品"+
      (filtered?"(已筛选)":"")+" · 第 "+q.page+"/"+pages+" 页 · 本页 "+rows.length+" 行",
      tot?"ok":"warn");

    var v  = function(x){ return (x===null||x===undefined||x==="") ? '<span class="na">—</span>' : esc(x); };
    var money = function(x){ return (x===null||x===undefined||x==="") ? '<span class="na">—</span>'
      : "¥"+Number(x).toFixed(2); };
    var bc = function(x){ return x ? esc(x) : '<span class="todo">待补录</span>'; };
    var st = function(x){ return x==="UP" ? '<span class="pill2 p-up">在售</span>'
      : x==="LOWER" ? '<span class="pill2 p-dn">下架</span>'
      : x ? '<span class="pill2 p-dn">'+esc(x)+'</span>' : '<span class="pill2 p-none">无状态</span>'; };
    var ws = function(x){ if(!x) return '<span class="na">—</span>';
      var cls = /过期/.test(x) ? (/已/.test(x)?"p-none":"p-warn") : "p-dn";
      return '<span class="pill2 '+cls+'" title="果冻橙标的,快过期仅12%准、已过期50%准,只当待核信号">'+esc(x)+'</span>'; };
    // 日期:完整 YYYY-MM-DD(年月日都要看得见)。没录到就说「未录」,⛔不许填今天/0/空
    var dt = function(x){
      if (!x) return '<span class="todo" title="效期模块里没有这个商品的日期">未录</span>';
      return '<span class="date">'+esc(String(x).slice(0,10))+'</span>';
    };
    // 剩余天数:负数=已过期。⛔不 clamp,过期多久要看得见
    var left = function(d, ed){
      if (d===null || d===undefined || !ed) return '<span class="na">—</span>';
      d = Number(d);
      if (d < 0)   return '<span class="pill2 p-none">已过期 '+(-d)+' 天</span>';
      if (d <= 30) return '<span class="pill2 p-none">'+d+' 天</span>';
      if (d <= 90) return '<span class="pill2 p-warn">'+d+' 天</span>';
      return '<span class="dim">'+d+' 天</span>';
    };
    // 两个库存源不一致 → 并排显示 + 标注,不挑一个假装一致
    var stk = function(r){
      var a=r.stock_num, b=r.cur_stock;
      var na=(a===null||a===undefined), nb=(b===null||b===undefined);
      if (na && nb) return '<span class="na">—</span>';
      var f=function(x,n){ return n?"—":(Number(x)<0?'<span class="neg" title="负库存 = 账实不符,该盘点">'+x+'</span>':String(x)); };
      if (na||nb||Number(a)!==Number(b))
        return '<span class="diff" title="快照(果冻橙)/门店在册 两源不一致">'+
               f(a,na)+' <b>/</b> '+f(b,nb)+'</span>';
      return f(a,false);
    };

    var h = '<div class="flt">'+
      '<input id="fq" placeholder="品名 / 商品编码 / 条码" value="'+esc(q.keyword)+'">'+
      '<input id="fc" placeholder="品类" value="'+esc(q.category)+'" style="min-width:118px">'+
      '<select id="fs"><option value="">全部状态</option>'+
        '<option value="UP"'+(q.product_status==="UP"?" selected":"")+'>在售</option>'+
        '<option value="LOWER"'+(q.product_status==="LOWER"?" selected":"")+'>下架</option></select>'+
      '<button class="go" id="fgo">筛选</button><button id="fcl">清空</button>'+
      (SHOP ? '<label class="sw" title="平时不显示没货的;要补货时勾上,它们就跳出来">'+
        '<input type="checkbox" id="fz"'+(q.showZero?" checked":"")+'>显示 0 库存(补货用)</label>' : '')+
      '<button id="fex">导出本页 CSV</button>'+
      '<span class="sp">库存合计 '+(sm.stock_total||0).toLocaleString("zh-CN")+
        ' 件 · 按线下价计货值 ¥'+Math.round(sm.sale_total||0).toLocaleString("zh-CN")+'</span></div>';
    // 🔴 过滤掉的必须报数 —— 静默过滤是店员漏补货的根
    if (SHOP) {
      if (onlyInStock) {
        var hid = (hiddenTotal!==null) ? (hiddenTotal - tot) : null;
        h += '<div class="cov">只看<b>有货</b>的:'+tot.toLocaleString("zh-CN")+' 个规格 / '+
          (sm.spu_total||0).toLocaleString("zh-CN")+' 个商品。'+
          (hid!==null && hid>0 ? '另有 <b>'+hid.toLocaleString("zh-CN")+'</b> 个 0 库存的没显示' : '0 库存的没显示')+
          ' —— 要补货就勾上面的「显示 0 库存」,它们会跳出来。'+
          '<br>判据:果冻橙快照 / 门店在册 <b>任一边有货</b>就算有货(两源有 47 行互相矛盾,宁可多显示也不误藏)。</div>';
      } else {
        h += '<div class="cov bad">已勾「显示 0 库存」——<b>没货的也在里面了</b>,'+
          '共 '+tot.toLocaleString("zh-CN")+' 个规格。补完记得取消勾选。</div>';
      }
    }
    // 效期覆盖率 + 快照新鲜度:数字必须自己说话,⛔不许只画一列日期让人以为都有
    if (sm.expiry_covered !== undefined) {
      var cov = sm.expiry_covered||0, pct = tot ? Math.round(cov*1000/tot)/10 : 0;
      var cap = sm.expiry_captured ? String(sm.expiry_captured).slice(0,10) : null;
      var stale = cap ? Math.floor((Date.now()-new Date(cap+"T00:00:00+08:00").getTime())/86400000) : null;
      h += '<div class="cov'+(pct<50?' bad':'')+'">效期日期覆盖 <b>'+cov.toLocaleString("zh-CN")+'/'+
        tot.toLocaleString("zh-CN")+'</b>('+pct+'%) —— 其余 '+(tot-cov).toLocaleString("zh-CN")+
        ' 条显示「未录」,是<b>真的没有</b>,不是页面没取到。'+
        (cap ? ' 日期快照拉取于 <b>'+cap+'</b>'+(stale>2?'(已停 '+stale+' 天,新到的货不在里面)':'') : '')+
        '</div>';
    }

    h += '<div class="tw"><table class="g"><tr>'+
      // 列序:日期是主角,放第一屏(0907 截图实测「剩余」原来被挤出屏幕外)
      ['商品编码','条码','品名','规格','状态','@@STK@@',
       '生产日期','到期日期','剩余','线下价','美团','饿了么','月销','附近怎么卖',
       '一级类','二级类','效期标(待核)','货位','供应商','外卖','SPU','最后改动']
        .map(function(x){ return x==="@@STK@@"
             ? '<th class="two">库存<small>快照 / 在册</small></th>' : '<th>'+x+'</th>'; }).join("")+'</tr>'+
      rows.map(function(r){
        return '<tr>'+
          '<td class="mono">'+v(r.product_code)+'</td>'+
          '<td class="mono">'+bc(r.barcode)+'</td>'+
          '<td class="nm" title="'+esc(r.product_name||"")+'">'+v(r.product_name)+'</td>'+
          '<td>'+v(r.spec_text)+'</td>'+
          '<td>'+st(r.product_status)+'</td>'+
          '<td class="r">'+stk(r)+'</td>'+
          '<td class="mono">'+dt(r.produce_date)+'</td>'+
          '<td class="mono">'+dt(r.expiration_date)+'</td>'+
          '<td class="r">'+left(r.days_to_expire, r.expiration_date)+'</td>'+
          '<td class="r">'+money(r.out_price)+'</td>'+
          '<td class="r">'+money(r.mt_price)+'</td>'+
          '<td class="r">'+money(r.ele_price)+'</td>'+
          '<td class="r">'+v(r.month_sale)+'</td>'+
          '<td class="mkt" data-code="'+esc(r.product_code)+'"><span class="na">…</span></td>'+
          '<td>'+v(r.category_l1)+'</td>'+
          '<td>'+v(r.category_l2)+'</td>'+
          '<td>'+ws(r.warn_status)+'</td>'+
          '<td class="mono">'+v(r.shelf_code)+'</td>'+
          '<td>'+v(r.supplier)+'</td>'+
          '<td>'+(r.take_out===true?'上':r.take_out===false?'<span class="na">否</span>':'<span class="na">—</span>')+'</td>'+
          '<td class="mono">'+v(r.spu_code)+'</td>'+
          '<td class="na">'+esc(String(r.gdc_updated_at||"").slice(0,10))+' '+esc(r.gdc_updated_by||"")+'</td>'+
          '</tr>';
      }).join("")+'</table></div>';

    h += '<div class="pg"><button id="pp"'+(q.page<=1?" disabled":"")+'>← 上一页</button>'+
      '<span>'+q.page+' / '+pages+'</span>'+
      '<button id="pn"'+(q.page>=pages?" disabled":"")+'>下一页 →</button>'+
      '<select id="ps" style="margin-left:12px">'+[50,100,200].map(function(n){
        return '<option value="'+n+'"'+(q.pageSize===n?" selected":"")+'>每页'+n+'</option>'}).join("")+'</select></div>';
    if (!SHOP) h += '<p class="why" style="margin-top:0">这是<b>不过滤的全量</b>:含 0 库存、含下架、含已停售。'+
      '日常看「金枋店」那一页 —— 这页是核对/导数据用的。</p>';
    h += '<p class="why">分页按<b>商品(SPU)</b>走,一页 '+q.pageSize+' 个商品、展开成它底下全部规格行'+
      '(所以行数比 '+q.pageSize+' 多) —— 同一商品的多个规格永远在同一页,不会被切开。<br>'+
      '口径:<b>库存</b>两列 = 果冻橙每日快照 / 工作台门店在册,'+
      '不一致时并排显示并标灰底 —— 这是真实存在的差,不是显示错。'+
      '<b>条码</b>空标「待补录」。<b>生产/到期日期</b>来自果冻橙效期模块(每商品只存一条生产日期,进新货若没更新,'+
      '显示的仍是老批次)。<b>效期标</b>是果冻橙自己标的,实测「快过期」12% 准、「已过期」50% 准,'+
      '只当待核信号,别拿它下架 —— 有真日期时以日期为准。<b>成本/毛利不出库</b>,本页不设该列。</p>';

    setTimeout(function(){
      fillMarket(rows);
      var go=function(){ q.keyword=$("fq").value.trim(); q.category=$("fc").value.trim();
        q.product_status=$("fs").value; q.page=1; re(); };
      $("fgo").onclick=go;
      $("fq").onkeydown=function(e){ if(e.key==="Enter") go(); };
      $("fc").onkeydown=function(e){ if(e.key==="Enter") go(); };
      $("fcl").onclick=function(){ window[KEY]={page:1,pageSize:q.pageSize,keyword:"",category:"",
        product_status:"",showZero:false}; re(); };
      if (SHOP) $("fz").onchange=function(){ q.showZero=this.checked; q.page=1; re(); };
      $("pp").onclick=function(){ if(q.page>1){q.page--; re();} };
      $("pn").onclick=function(){ if(q.page<pages){q.page++; re();} };
      $("ps").onchange=function(){ q.pageSize=Number(this.value); q.page=1; re(); };
      $("fex").onclick=function(){
        var cols=["product_code","barcode","product_name","spec_text","category_l1","category_l2",
          "product_status","stock_num","cur_stock","out_price","mt_price","ele_price","month_sale",
          "produce_date","expiration_date","days_to_expire","warn_status",
          "shelf_code","supplier","take_out","spu_code","gdc_updated_at","gdc_updated_by"];
        var q2=function(x){ return '"'+String(x===null||x===undefined?"":x).replace(/"/g,'""')+'"'; };
        var csv="﻿"+cols.join(",")+"\n"+rows.map(function(r){
          return cols.map(function(c){return q2(r[c])}).join(",")}).join("\n");
        var a=document.createElement("a");
        a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
        a.download="总商品库_第"+q.page+"页_"+new Date().toISOString().slice(0,10)+".csv";
        a.click(); setTimeout(function(){URL.revokeObjectURL(a.href)},2000);
      };
    },0);
    return h;
}
// 重画:show() 会把 innerHTML 换掉,这里复用它
async function renderInto(mode){
  $("body").innerHTML = '<div class="verdict">读取中…</div>';
  try { $("body").innerHTML = await renderList(mode); }
  catch(e){ verdict("🔴 "+e.message,"red"); $("body").innerHTML=""; }
}

// ── 商品行下面那一排「附近怎么卖」(0908) ──
// 口径由 deepseek 按实测数据定的,⛔改口径前先看 api/db/petstore-market-row.js 顶部注释:
//   价格只给区间不给点(同编码混过不同规格) · 每家竞店只取最新一条(⛔不 sum)
//   「验证低价」= 月销≥50 的店里的最低价(⛔不用「最高月销那家的价」,月销200疑似封顶)
//   没数据显示「未采集」—— ⛔不隐藏(会让人以为没竞品而瞎定价),⛔不拿同品类中位价顶替
async function fillMarket(rows){
  var cells = document.querySelectorAll("td.mkt[data-code]");
  if (!cells.length) return;
  var codes = Array.prototype.map.call(cells, function(c){ return c.dataset.code; });
  var uniq = codes.filter(function(v,i){ return codes.indexOf(v)===i; });
  var d = await get("db/petstore-market-row?codes=" + encodeURIComponent(uniq.join(",")));
  if (!d || d.ok === false || d.error) {
    Array.prototype.forEach.call(cells, function(c){ c.innerHTML = '<span class="na">—</span>'; });
    return;
  }
  var mine = {};
  (rows||[]).forEach(function(r){ mine[r.product_code] = r.out_price; });
  window.__MKT = d.rows;

  Array.prototype.forEach.call(cells, function(c){
    var m = d.rows[c.dataset.code];
    if (!m || !m.has_data) { c.innerHTML = '<span class="todo" title="这个品还没采到附近门店的价">未采集</span>'; return; }
    var band = m.price_min === m.price_max ? ("¥" + m.price_min)
             : ("¥" + m.price_min + "~" + m.price_max);
    // 我方 vs 验证低价:只有在有验证低价时才下结论,⛔没有就不下
    var pos = "";
    var my = Number(mine[c.dataset.code]);
    if (m.verified_low != null && isFinite(my) && my > 0) {
      var gap = Math.round((my - m.verified_low) * 100) / 100;
      pos = gap > 0 ? '<b class="hi">高¥' + gap + '</b>'
          : (gap < 0 ? '<b class="lo">低¥' + (-gap) + '</b>' : '<b class="eq">持平</b>');
    }
    c.innerHTML = '<span class="mktcell" title="点开看各家">' +
      '<b>' + m.shops + '家</b> ' + band +
      (m.verified_low != null ? ' · 验证 ¥' + m.verified_low : '') +
      (pos ? ' · ' + pos : '') + '</span>';
  });
}

// 点「附近」格 → 在这一行【下面】展开各家明细(Damon 要的那一排)
document.addEventListener("click", function(e){
  var c = e.target.closest && e.target.closest("td.mkt[data-code]");
  if (!c) return;
  var tr = c.closest("tr");
  if (tr.nextElementSibling && tr.nextElementSibling.classList.contains("mktrow")) {
    tr.nextElementSibling.remove(); return;
  }
  var m = (window.__MKT || {})[c.dataset.code];
  var td = document.createElement("tr");
  td.className = "mktrow";
  var cols = tr.querySelectorAll("td").length;
  var body;
  if (!m || !m.has_data) {
    body = '<span class="todo">未采集</span> —— 附近门店还没采到这个品。' +
           '⛔ 别把「没采到」当成「附近没人卖」。';
  } else {
    body = '<table class="mini"><tr><th>竞店</th><th>售价</th><th>月销</th><th>每100g</th></tr>' +
      (m.detail||[]).map(function(x){
        return '<tr><td>' + esc(x.shop) + '</td><td class="r">¥' + x.price + '</td>' +
          '<td class="r">' + (x.sales == null ? '—' : x.sales) +
          (x.sales >= 200 ? ' <span class="cap" title="平台可能显示的是200+,真实更高">封顶</span>' : '') + '</td>' +
          '<td class="r">' + (x.unit_100g == null ? '—' : '¥' + x.unit_100g) + '</td></tr>';
      }).join("") + '</table>' +
      '<div class="mktnote">总月销 <b>' + m.sales_total + '</b>' +
      (m.sales_capped ? '(有店月销封顶,真实更高,只能当下限看)' : '') +
      ' · 采于 <b>' + esc(m.captured) + '</b>' +
      (m.verified_low != null
        ? ' · <b>验证低价 ¥' + m.verified_low + '</b>(月销≥50 的 ' + m.verified_shops + ' 家里最低,'
          + '高于它要有理由,低于它是白让利)'
        : ' · <b>没有验证低价</b> —— 这几家月销都不到 50,谁的价都不算被市场验证过') +
      '</div>';
  }
  td.innerHTML = '<td colspan="' + cols + '"><div class="mktbox">' + body + '</div></td>';
  tr.parentNode.insertBefore(td, tr.nextSibling);
});

// 比价罗盘:点一行 → 往【下面】展开四道闸和附近证据。
// 🔴 必须显示竞店原始标题 —— 判「是不是匹配错」只能靠它。
document.addEventListener("click", function(e){
  var tr = e.target.closest && e.target.closest("tr.cmprow");
  if (!tr) return;
  var nx = tr.nextElementSibling;
  if (nx && nx.classList.contains("cmpdet")) {
    nx.remove(); tr.querySelector(".cx").textContent = "▸"; return;
  }
  var r = (window.__CMP || {})[tr.dataset.k];
  if (!r) return;
  tr.querySelector(".cx").textContent = "▾";
  var cols = tr.querySelectorAll("td").length;
  var raw = function(x){ return (x===null||x===undefined||x==="") ? "—" : String(x); };
  var money = function(x){ return (x===null||x===undefined||x==="") ? "—" : "¥"+Number(x).toFixed(2); };
  var stateMap = {ok:["✓","g-ok"], warn:["·","g-warn"], bad:["✗","g-bad"], idle:["·","g-idle"]};
  var gates = (r.gates||[]).map(function(g){
    var m = stateMap[g.state] || stateMap.idle;
    return '<div class="gate"><div class="gico '+m[1]+'">'+m[0]+'</div><div>'+
      '<div class="gttl">'+esc(raw(g.label))+'</div>'+
      '<div class="gdet">'+esc(raw(g.detail))+'</div></div></div>';
  }).join("") || '<div class="cmpempty">未采到闸卡</div>';
  var peers = (r.shops_detail||[]).map(function(x){
    var cls = 'peerrow'+(x.price_usable===false?' badprice':'')+(x.multi_pack?' multipack':'');
    var shop = raw(x.shop);
    var shortShop = shop.length>14 ? shop.slice(0,14)+'…' : shop;
    var tags = '<span class="ptag">'+(x.peer?'同行':'超市')+'</span>';
    if (x.same_brand===false) tags += '<span class="ptag gray">不同牌</span>';
    if (x.price_usable===false) tags += '<span class="ptag red">'+esc(raw(x.price_why))+'</span>';
    if (x.pack_n!=null) tags += '<span class="ptag org">'+esc(x.pack_n)+'件装 · 单包'+money(x.unit_price)+'</span>';
    else if (x.multi_pack) tags += '<span class="ptag org" title="标题里看不出几件,要点进详情页才知道 —— 这个价不能直接和我方单包比">多件价 · 件数未知</span>';
    if (x.price_unverifiable===true) tags += '<span class="ptag gray">无划线价 · 真伪无从判断</span>';
    return '<div class="'+cls+'"><div class="peerline">'+
      '<span>'+esc(raw(x.dist_txt))+'</span><span class="peerprice">'+money(x.price)+'</span>'+
      '<span class="peershop" title="'+esc(shop)+'">'+esc(shortShop)+'</span>'+
      '<span class="peersales">'+esc(raw(x.shop_sales))+'</span></div>'+
      '<div class="peertags">'+tags+'</div>'+
      '<div class="peerraw" title="'+esc(raw(x.title))+'">'+esc(raw(x.title))+'</div></div>';
  }).join("") || '<div class="cmpempty">未采到附近门店报价</div>';
  var body = '';
  if (r.needs_recheck) {
    body += '<div class="recheck">🔁 之前定过「'+esc(raw(r.verdict))+'」,当时附近最低 '+money(r.lo_at_decision)+
      ',现在 '+money(r.lo)+' —— 要重新看</div>';
  }
  body += '<div class="cmpgrid"><div class="cmpcol"><h4>四道闸</h4>'+gates+'</div>'+
    '<div class="cmpcol"><h4>附近怎么卖(按距离,近的在前)</h4>'+peers+'</div></div>';
  body += '<div class="cmpstat">附近总月销 '+esc(raw(r.rival_sales))+' · 我们月销 '+esc(raw(r.my_sales))+
    ' · '+esc(raw(r.sales_shops_with_data))+' 家给出月销'+
    (r.rival_sales_max>=200?' (有店月销到200封顶,分不清卖200和卖爆)':'')+'</div>';
  if (r.traffic_candidate===true) body += '<div class="traffic ok">🟢 这个品可以作为流量品 —— '+esc(raw(r.traffic_reason))+'</div>';
  else body += '<div class="traffic no">'+esc(raw(r.traffic_reason))+'</div>';
  if (r.my_sales_caveat) body += '<div class="caveat">⚠️ '+esc(r.my_sales_caveat)+'</div>';
  body += '<div class="nextstep">下一步&nbsp;&nbsp;'+esc(raw(r.next_step))+'</div>';
  var d = document.createElement("tr");
  d.className = "cmpdet";
  d.innerHTML = '<td colspan="'+cols+'"><div class="mktbox">'+body+'</div></td>';
  tr.parentNode.insertBefore(d, tr.nextSibling);
});
