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
  // ── 第5层 效期风险 ──
  l5: async function(){
    var d = await get("db/petstore-expiry-risk");
    if (d.error || d.ok===false) return verdict("🔴 "+(d.error||d.message||"取数失败"),"red"), "";
    var s = d.summary||{};
    verdict(d.verdict, /^🔴/.test(d.verdict) ? "red" : (/^🟡/.test(d.verdict) ? "warn" : "ok"));
    var money = function(x){ return "¥"+Number(x||0).toLocaleString("zh-CN"); };
    var TIER = {red:"d-red", yellow:"d-yel", green:"d-grn"};
    var h = '<div class="cov'+(s.dated_pct<50?' bad':'')+'">有货 <b>'+
      (s.in_stock||0).toLocaleString("zh-CN")+'</b> 个规格,其中 <b>'+(s.dated||0)+'</b> 个有日期('+
      (s.dated_pct||0)+'%),<b>'+(s.undated||0)+'</b> 个没有。'+
      '日期快照拉取于 <b>'+esc(s.captured||"?")+'</b>'+
      (s.stale_days>2 ? '(已停 '+s.stale_days+' 天,这段时间到的货不在里面)' : '')+'</div>';

    (d.groups||[]).forEach(function(g){
      if (!g.count) return;
      h += '<div class="grp"><h3><span class="dot '+(TIER[g.tier]||"d-gry")+'"></span>'+esc(g.label)+
        '<span class="c">'+g.count+'</span>'+
        '<span class="amt">占款 '+money(g.amount_by_price)+'</span></h3>'+
        '<p class="gwhy">'+esc(g.why)+'</p>';
      if (g.rows && g.rows.length) {
        h += '<div class="tw"><table class="g"><tr>'+
          ['商品编码','品名','规格','货位','状态','库存','到期日期','剩余','月销','占款(按售价)']
            .map(function(x){return '<th>'+x+'</th>'}).join("")+'</tr>'+
          g.rows.map(function(r){
            var dd = r.days_to_expire;
            var lf = (dd===null||dd===undefined) ? '<span class="todo">无日期</span>'
              : (dd<0 ? '<span class="pill2 p-none">已过期 '+(-dd)+' 天</span>'
              : (dd<=30 ? '<span class="pill2 p-none">'+dd+' 天</span>'
              : (dd<=90 ? '<span class="pill2 p-warn">'+dd+' 天</span>' : '<span class="dim">'+dd+' 天</span>')));
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
              '<td class="r">'+esc(r.month_sale==null?"—":r.month_sale)+'</td>'+
              '<td class="r">'+money(r.amount_by_price)+'</td></tr>';
          }).join("")+'</table></div>';
        if (g.truncated) h += '<p class="gwhy">只列了前 '+g.shown+' 条(共 '+g.count+' 条) —— '+
          '这一档太多,该做的是批量补录,不是一条条看。</p>';
      }
      h += '</div>';
    });
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
  $("ttl").textContent = ({list:"金枋店 · 商品明细",listall:"总商品库 · 全量(含 0 库存)",l5:"效期风险",cat:"库存概况",l4:"产品分析",l0:"第0层 表注册表",l1:"第1层 真源状态",l2:"第2层 身份对齐",l3:"第3层 资料缺口"})[p];
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
       '生产日期','到期日期','剩余','线下价','美团','饿了么','月销',
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

