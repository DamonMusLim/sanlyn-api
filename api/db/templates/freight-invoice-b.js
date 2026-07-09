import { numberToRMB } from "../freight-invoice-b-data.js";

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function attr(v) {
  return esc(v).replace(/"/g, "&quot;");
}

function money(v) {
  if (v == null || v === "") return "待补";
  const n = Number(v);
  if (!isFinite(n)) return "待补";
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percent(v) {
  if (v == null || v === "") return "待补";
  const n = Number(v);
  if (!isFinite(n)) return "待补";
  return (n * 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
}

function copyValue(value, label, extraClass) {
  const missing = value == null || value === "";
  const shown = missing ? "待补" : String(value);
  return `<span class="${missing ? "missing-value" : ""}">${esc(shown)}</span><button class="copy-btn ${extraClass || ""}" data-copy="${attr(missing ? "" : shown)}" data-label="${attr(label)}">复制</button>`;
}

function td(value, label, cls) {
  return `<td class="${cls || ""}">${copyValue(value, label)}</td>`;
}

function plateList(lines) {
  return (lines || []).map(l => l.plate_no).filter(Boolean).join(",");
}

function renderPriceCheck(check) {
  if (!check) return "";
  const verdicts = Array.isArray(check.verdicts) ? check.verdicts : [];
  const hasDanger = verdicts.some(v => v.level === "danger");
  const hasWarn = verdicts.some(v => v.level === "warn");
  const badgeClass = hasDanger ? "danger" : (hasWarn ? "warn" : "ok");
  const badgeText = hasDanger ? "🔴 价格异常,需确认后开票" : (hasWarn ? "🟡 有提示,请复核" : "🟢 价格核对通过");
  const items = verdicts.length ? verdicts.map(v => `<li class="${attr(v.level || "ok")}">${esc(v.label)}</li>`).join("") : `<li class="ok">无异常</li>`;
  return `
  <section class="price-check">
    <div class="price-check-head">
      <div class="price-check-title">🔍 开票前价格核对(内部)</div>
      <div class="price-check-badge ${badgeClass}">${badgeText}</div>
    </div>
    <div class="price-check-grid">
      <div><span>开票额(含税)</span><b>¥${money(check.invoice_amount)}</b></div>
      <div><span>成本</span><b>¥${money(check.cost_amount)}</b></div>
      <div><span>毛利</span><b>¥${money(check.gross_profit)}</b></div>
      <div><span>毛利率</span><b>${percent(check.gross_margin)}</b></div>
      <div><span>报价</span><b>${check.quote_amount == null ? "—" : "¥" + money(check.quote_amount)}</b></div>
    </div>
    <ul class="price-check-verdicts">${items}</ul>
  </section>`;
}

export function renderInvoiceB(data) {
  const line = data.line || {};
  const seller = data.seller || {};
  const buyer = data.buyer || {};
  const missing = Array.isArray(data.missing) ? data.missing : [];
  const transports = Array.isArray(data.transport_lines) ? data.transport_lines : [];
  const amountIncl = line.amount_incl == null ? null : Number(line.amount_incl);
  const amountSmall = amountIncl == null ? "待补" : "¥" + money(amountIncl);
  const amountBig = amountIncl == null ? "待补" : numberToRMB(amountIncl);
  const plates = plateList(transports);
  const priceCheck = renderPriceCheck(data.price_check);
  const transportRows = transports.length ? transports.map((row, i) => `
    <tr>
      ${td(row.transport_type, "运输工具种类" + (i + 1))}
      ${td(row.plate_no, "牌号" + (i + 1))}
      ${td(row.origin, "起运地" + (i + 1))}
      ${td(row.destination, "到达地" + (i + 1))}
      ${td(row.cargo_name, "运输货物名称" + (i + 1))}
    </tr>`).join("") : `
    <tr>
      <td class="missing-value">待补</td>
      <td class="missing-value">待补</td>
      <td class="missing-value">待补</td>
      <td class="missing-value">待补</td>
      <td class="missing-value">待补</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>货物运输服务电子发票 - ${esc(data.bl_no || "")}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f4f6;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:13px}
.page{width:980px;margin:24px auto;padding:28px 32px;background:#fff;border:1px solid #d8d8d8}
.preview-banner{margin:-8px 0 14px;padding:10px 12px;border:1px solid #b91c1c;background:#fef2f2;color:#991b1b;font-weight:700}
.price-check{margin:0 0 16px;padding:12px;border:1px solid #cbd5e1;background:#f8fafc}
.price-check-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}
.price-check-title{font-size:15px;font-weight:800;color:#0f172a}
.price-check-badge{padding:4px 9px;border-radius:4px;font-weight:800}
.price-check-badge.danger{background:#fee2e2;color:#991b1b}
.price-check-badge.warn{background:#fef3c7;color:#92400e}
.price-check-badge.ok{background:#dcfce7;color:#166534}
.price-check-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
.price-check-grid>div{border:1px solid #e2e8f0;background:#fff;padding:8px}
.price-check-grid span{display:block;color:#64748b;font-size:12px;margin-bottom:4px}
.price-check-grid b{font-size:14px;font-variant-numeric:tabular-nums}
.price-check-verdicts{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0;padding:0;list-style:none}
.price-check-verdicts li{padding:4px 8px;border-radius:4px;font-weight:700}
.price-check-verdicts .danger{background:#fee2e2;color:#991b1b}
.price-check-verdicts .warn{background:#fef3c7;color:#92400e}
.price-check-verdicts .ok{background:#dcfce7;color:#166534}
.top{display:grid;grid-template-columns:1fr 2fr 1fr;align-items:start;margin-bottom:18px}
.kind{font-size:18px;font-weight:700}
.title{text-align:center;color:#8b0000;font-size:28px;font-weight:800;letter-spacing:2px}
.meta{text-align:right;line-height:1.8}
.row{display:flex;align-items:center;gap:6px;min-height:24px}
.party{display:grid;grid-template-columns:1fr 1fr;border:1.5px solid #222;margin-bottom:14px}
.party-box{padding:10px 12px;min-height:78px}
.party-box:first-child{border-right:1.5px solid #222}
.party-title{font-weight:700;margin-bottom:8px;color:#333}
.field{display:grid;grid-template-columns:128px 1fr;align-items:center;margin:4px 0}
table{width:100%;border-collapse:collapse;margin:0 0 14px}
th,td{border:1px solid #222;padding:8px 7px;text-align:left;vertical-align:middle}
th{background:#f6f6f6;text-align:center;font-weight:700}
.num{text-align:right;font-variant-numeric:tabular-nums}
.copy-btn,.copy-plates{border:1px solid #999;background:#fff;border-radius:3px;padding:2px 6px;margin-left:5px;font-size:12px;cursor:pointer;color:#111}
.copy-btn:hover,.copy-plates:hover{background:#f2f2f2}
.missing-value{background:#fff3bf;color:#7a4f00;padding:1px 4px;border-radius:2px;font-weight:700}
.transport-head{display:flex;justify-content:space-between;align-items:center;margin:14px 0 6px}
.transport-title{font-size:16px;font-weight:800}
.totals{display:grid;grid-template-columns:2fr 1fr;border:1.5px solid #222;margin-bottom:14px}
.totals>div{padding:10px 12px}
.totals>div:first-child{border-right:1.5px solid #222}
.remark{border:1px solid #222;padding:10px 12px;line-height:1.8;min-height:72px}
.footer{display:flex;justify-content:flex-end;margin-top:18px}
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111;color:#fff;padding:9px 14px;border-radius:4px;opacity:0;pointer-events:none;transition:opacity .15s}
#toast.show{opacity:1}
@media print{body{background:#fff}.page{width:auto;margin:0;border:0}.copy-btn,.copy-plates,.price-check{display:none}.preview-banner{border:1px solid #b91c1c}}
</style>
</head>
<body>
<div class="page">
  ${missing.length ? `<div class="preview-banner">⚠ 信息不全（${missing.length}项待补），当前为预览，不能作为正式发票</div>` : ""}
  ${priceCheck}
  <div class="top">
    <div class="kind">${copyValue("货物运输服务", "货物运输服务")}</div>
    <div class="title">电子发票(增值税专用发票)</div>
    <div class="meta">
      <div class="row">发票号码：${copyValue("待开", "发票号码")}</div>
      <div class="row">开票日期：${copyValue(data.issue_date, "开票日期")}</div>
    </div>
  </div>

  <div class="party">
    <div class="party-box">
      <div class="party-title">购买方信息</div>
      <div class="field"><span>名称</span><span>${copyValue(buyer.name, "购买方名称")}</span></div>
      <div class="field"><span>统一社会信用代码</span><span>${copyValue(buyer.tax_id, "购买方统一社会信用代码")}</span></div>
    </div>
    <div class="party-box">
      <div class="party-title">销售方信息</div>
      <div class="field"><span>名称</span><span>${copyValue(seller.name, "销售方名称")}</span></div>
      <div class="field"><span>纳税人识别号</span><span>${copyValue(seller.tax_id, "销售方纳税人识别号")}</span></div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>项目名称</th><th>数量</th><th>单价</th><th>金额(不含税)</th><th>税率</th><th>税额</th></tr>
    </thead>
    <tbody>
      <tr>
        ${td(line.name, "项目名称")}
        ${td(line.qty, "数量", "num")}
        ${td(line.amount_ex == null ? "" : money(line.amount_ex), "单价", "num")}
        ${td(line.amount_ex == null ? "" : money(line.amount_ex), "金额不含税", "num")}
        ${td("9%", "税率", "num")}
        ${td(line.tax == null ? "" : money(line.tax), "税额", "num")}
      </tr>
    </tbody>
  </table>

  <div class="transport-head">
    <div class="transport-title">🚚 运输工具明细</div>
    <button class="copy-plates" data-copy="${attr(plates)}" data-label="全部车牌">复制全部车牌</button>
  </div>
  <table>
    <thead>
      <tr><th>运输工具种类</th><th>牌号</th><th>起运地</th><th>到达地</th><th>运输货物名称</th></tr>
    </thead>
    <tbody>${transportRows}</tbody>
  </table>

  <div class="totals">
    <div>价税合计(大写)：${copyValue(amountBig, "价税合计大写")}</div>
    <div>小写：${copyValue(amountSmall, "价税合计小写")}</div>
  </div>

  <div class="remark">
    <div>备注：${copyValue(`开户银行：${seller.bank_name || ""}　账号：${seller.bank_account || ""}`, "备注")}</div>
    <div>提单号：${copyValue(data.bl_no, "提单号")}</div>
  </div>
  <div class="footer">开票人：${copyValue("管理员", "开票人")}</div>
</div>
<div id="toast"></div>
<script>
(function(){
  var toastTimer = null;
  function toast(msg){
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.classList.remove("show"); }, 2000);
  }
  function copy(text, label){
    if (!text) { toast("暂无可复制内容"); return; }
    navigator.clipboard.writeText(text).then(function(){
      toast("已复制：" + (label || text));
    }).catch(function(){ toast("复制失败"); });
  }
  document.addEventListener("click", function(e){
    var btn = e.target.closest(".copy-btn,.copy-plates");
    if (!btn) return;
    copy(btn.getAttribute("data-copy") || "", btn.getAttribute("data-label") || "");
  });
})();
</script>
</body>
</html>`;
}
