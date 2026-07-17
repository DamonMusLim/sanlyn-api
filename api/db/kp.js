// /api/db/kp.js — 工厂开票门户页(公开). 链接支持 ?o=订单号(初期无token) / ?c=短码 / ?t=hmac
import crypto from "crypto";
import { getPool, setCors } from "../db.js";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

function expiredHtml() {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>链接已失效 · Sanlyn</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;color:#1e293b;font-family:-apple-system,"PingFang SC",sans-serif}.card{width:min(420px,calc(100vw - 32px));background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center}.title{font-size:18px;font-weight:800;margin-bottom:8px}.msg{font-size:14px;color:#64748b;line-height:1.7}</style></head><body><div class="card"><div class="title">链接已失效</div><div class="msg">请联系 Sanlyn 重新获取</div></div></body></html>`;
}

function setFwdCookie(res, token) {
  var maxAge = 30 * 24 * 60 * 60;
  var parts = [
    "fwd_session=" + encodeURIComponent(token),
    "Max-Age=" + maxAge,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ];
  res.setHeader("Set-Cookie", parts.join("; "));
}

async function resolveForwarderCode(req, res) {
  var code = String((req.query && req.query.c) || "").trim();
  if (!/^[A-Za-z0-9]{10}$/.test(code)) return false;
  var pool = getPool();
  var hash = rawToHash(code);
  var linkRows = await pool.query(
    `SELECT meta
      FROM magic_links
     WHERE token_hash = $1
       AND recipient_role = 'fwd_portal'
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [hash]
  );
  if (!linkRows.rows.length) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(410).send(expiredHtml());
    return true;
  }
  var meta = linkRows.rows[0].meta || {};
  var companyId = Number(meta.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(410).send(expiredHtml());
    return true;
  }
  var tokenRows = await pool.query(
    `SELECT code
       FROM forwarder_portal_tokens
      WHERE company_id = $1
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT 1`,
    [companyId]
  );
  if (!tokenRows.rows.length) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(410).send(expiredHtml());
    return true;
  }
  var token = tokenRows.rows[0].code;
  setFwdCookie(res, token);
  res.status(302).setHeader("Location", "/forwarder-quote/" + encodeURIComponent(token));
  res.end();
  return true;
}
const HTML = `<!DOCTYPE html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>采购开票 · Sanlyn</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f1f5f9;color:#1e293b;padding:14px;max-width:760px;margin:0 auto}
.card{background:#fff;border-radius:12px;padding:18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:18px;margin-bottom:4px}.sub{color:#64748b;font-size:13px;margin-bottom:14px}
.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:13px}
.row label{color:#64748b}.row b{color:#0f172a}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}th,td{padding:7px 6px;text-align:left;border-bottom:1px solid #f1f5f9}th{color:#64748b;font-weight:600}td.r,th.r{text-align:right}
.tot{background:#f0fdf4;font-weight:700}.tax{color:#7c3aed}
.badge{display:inline-block;background:#ede9fe;color:#6d28d9;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:600}
.field{margin-bottom:12px}.field label{display:block;font-size:12px;color:#475569;margin-bottom:4px}
.field input{width:100%;padding:9px 11px;border:1px solid #cbd5e1;border-radius:7px;font-size:14px}
.field input[readonly]{background:#f8fafc;color:#64748b}
.btn{width:100%;padding:12px;border:none;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-size:15px;font-weight:700;cursor:pointer}
.btn:disabled{opacity:.5}.btn2{background:#fff;border:1px solid #cbd5e1;color:#1e293b}
.ok{background:#dcfce7;color:#166534;padding:12px;border-radius:8px;font-size:14px;text-align:center}
.err{background:#fee2e2;color:#991b1b;padding:10px;border-radius:8px;font-size:13px;margin-bottom:10px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.up{border:2px dashed #cbd5e1;border-radius:8px;padding:18px;text-align:center;color:#64748b;font-size:13px;cursor:pointer}
.up.has{border-color:#22c55e;color:#166534;background:#f0fdf4}
</style></head><body>
<div id="app"><div class="card"><div class="sub">加载中…</div></div></div>
<script>
var API="/api/db/invoice-portal";
// 透传 c=短码 / o=订单号 / t=hmac
var QS=new URLSearchParams(location.search), P={};
["c","o","t","token"].forEach(function(k){ if(QS.get(k)) P[k]=QS.get(k); });
if(!Object.keys(P).length && location.hash) P.t=location.hash.replace(/^#/,"");
var QSTR=new URLSearchParams(P).toString();
var DATA=null, fileB64=null, fileName=null;
function fmt(n){return Number(n||0).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2})}
function esc(s){return String(s==null?"":s).replace(/[<>&]/g,function(c){return{"<":"&lt;",">":"&gt;","&":"&amp;"}[c]})}
function load(){
  fetch(API+"?"+QSTR).then(function(r){return r.json()}).then(function(d){
    if(!d.success){document.getElementById("app").innerHTML='<div class="card"><div class="err">'+esc(d.error||"链接无效")+'</div></div>';return}
    DATA=d;render();
  }).catch(function(e){document.getElementById("app").innerHTML='<div class="card"><div class="err">加载失败:'+esc(e.message)+'</div></div>'});
}
function render(){
  var d=DATA, vatPct=Math.round(d.vat_rate*100);
  var rows=d.lines.map(function(l,i){return '<tr><td>'+(i+1)+'</td><td>'+esc(l.name)+(l.hs_code?'<br><small style="color:#94a3b8">HS '+esc(l.hs_code)+'</small>':'')+'</td><td class="r">'+Number(l.qty||0)+' 箱</td><td class="r">'+fmt(l.decl_total)+'</td></tr>'}).join("");
  var up=d.uploaded.length?'<div class="card"><b style="font-size:13px">已上传发票('+d.uploaded.length+')</b>'+d.uploaded.map(function(u){return '<div class="row"><label>'+esc(u.invoice_no)+' · '+esc(u.issue_date||"")+'</label><b>¥'+fmt(u.amount_incl_tax)+'</b></div>'}).join("")+'</div>':"";
  document.getElementById("app").innerHTML=
  '<div class="card"><h1>采购开票通知</h1><div class="sub">请按下表（报关申报价）开具 '+vatPct+'% 增值税专用发票给购买方</div>'
  +'<span class="badge">增值税专用发票 '+vatPct+'%</span>'
  +'<div style="margin-top:14px"><div class="row"><label>购买方（开票抬头）</label><b>'+esc(d.buyer.name)+'</b></div>'
  +'<div class="row"><label>购买方税号</label><b>'+esc(d.buyer.tax_id)+'</b></div>'
  +'<div class="row"><label>销售方（贵司）</label><b>'+esc(d.factory.name||"—")+'</b></div>'
  +'<div class="row"><label>订单号 / 合同号</label><b>'+esc(d.order_no)+' / '+esc(d.contract_no||"—")+'</b></div></div>'
  +'<table><thead><tr><th>#</th><th>货物名称/HS</th><th class="r">数量</th><th class="r">金额(报关价 CNY)</th></tr></thead><tbody>'+rows
  +'<tr class="tot"><td colspan="3" class="r">合计(不含税)</td><td class="r">'+fmt(d.invoice_excl)+'</td></tr>'
  +'<tr><td colspan="3" class="r tax">增值税('+vatPct+'%)</td><td class="r tax">'+fmt(d.vat_amt)+'</td></tr>'
  +'<tr class="tot"><td colspan="3" class="r">价税合计</td><td class="r">'+fmt(d.invoice_incl)+'</td></tr></tbody></table>'
  +'<button class="btn btn2" style="margin-top:12px" onclick="window.print()">⬇ 下载 / 打印开票申请</button></div>'
  +up
  +'<div class="card"><h1 style="font-size:16px">上传开好的发票</h1><div class="sub">开完票把信息填这里、PDF传上来，自动通知 Sanlyn 财务</div>'
  +'<div class="grid2"><div class="field"><label>发票号码 *</label><input id="i_no"></div><div class="field"><label>开票日期</label><input id="i_date" type="date"></div></div>'
  +'<div class="grid2"><div class="field"><label>金额(不含税)</label><input id="i_ex" type="number" value="'+d.invoice_excl.toFixed(2)+'"></div><div class="field"><label>税率</label><input id="i_rate" value="'+vatPct+'%" readonly></div></div>'
  +'<div class="grid2"><div class="field"><label>税额</label><input id="i_tax" type="number" value="'+d.vat_amt.toFixed(2)+'"></div><div class="field"><label>价税合计</label><input id="i_incl" type="number" value="'+d.invoice_incl.toFixed(2)+'"></div></div>'
  +'<div class="field"><label>发票 PDF</label><div class="up" id="up" onclick="document.getElementById(\\'f\\').click()">点击选择发票 PDF</div><input id="f" type="file" accept="application/pdf" style="display:none" onchange="pick(this)"></div>'
  +'<div id="msg"></div><button class="btn" id="sub" onclick="submit()">提交发票给 Sanlyn 财务</button></div>';
}
function pick(inp){var f=inp.files[0];if(!f)return;fileName=f.name;var r=new FileReader();r.onload=function(){fileB64=r.result.split(",")[1];var u=document.getElementById("up");u.className="up has";u.textContent="✅ "+f.name};r.readAsDataURL(f)}
function submit(){
  var no=document.getElementById("i_no").value.trim();
  if(!no){document.getElementById("msg").innerHTML='<div class="err">请填发票号码</div>';return}
  var btn=document.getElementById("sub");btn.disabled=true;btn.textContent="提交中…";
  var body=Object.assign({},P,{action:"upload",invoice_no:no,issue_date:document.getElementById("i_date").value||null,
    amount_ex_tax:document.getElementById("i_ex").value,total_tax:document.getElementById("i_tax").value,
    amount_incl_tax:document.getElementById("i_incl").value,tax_rate:DATA.vat_rate,file_b64:fileB64,filename:fileName});
  fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){
    if(d.success){document.getElementById("app").innerHTML='<div class="card"><div class="ok">✅ '+esc(d.message)+'<br><br>发票号 '+esc(d.invoice_no)+' 已提交。感谢！</div></div>'}
    else{document.getElementById("msg").innerHTML='<div class="err">'+esc(d.error||"提交失败")+'</div>';btn.disabled=false;btn.textContent="提交发票给 Sanlyn 财务"}
  }).catch(function(e){document.getElementById("msg").innerHTML='<div class="err">'+esc(e.message)+'</div>';btn.disabled=false;btn.textContent="提交发票给 Sanlyn 财务"})
}
if(!QSTR){document.getElementById("app").innerHTML='<div class="card"><div class="err">无效链接：缺少订单号/短码</div></div>'}else load();
</script></body></html>`;
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET" && await resolveForwarderCode(req, res)) return;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(HTML);
}
