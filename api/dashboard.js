// api/dashboard.js — 私人实时数据看板（React Bits 风格）

import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.query.token) {
    req.headers.authorization = "Bearer " + req.query.token;
  }
  if (!requireAuth(req, res)) return;
  if (req.user.role !== "admin") return res.status(403).end();

  const pool = getPool();

  const [orders, ar, shipping, personalLoans, paymentSchedule, paymentTotals] = await Promise.all([
    pool.query(`SELECT status, COUNT(*) n FROM orders GROUP BY status`),
    pool.query(`SELECT issuing_company, SUM(amount) total, COUNT(*) cnt,
                  COUNT(*) FILTER (WHERE due_date < NOW()) overdue
                FROM finance_records
                WHERE direction='AR' AND status IN ('pending','partial')
                GROUP BY issuing_company ORDER BY total DESC LIMIT 10`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE eta > NOW()) in_transit
                FROM shipping_plans`),
    pool.query(`SELECT pl.id, pl.borrower_name, pl.principal, pl.monthly_interest,
                  pl.monthly_cost, pl.monthly_net, pl.due_date, pl.status,
                  COUNT(pp.id) FILTER (WHERE pp.status='received') received_count,
                  COUNT(pp.id) FILTER (WHERE pp.status='overdue')  overdue_count,
                  COUNT(pp.id) FILTER (WHERE pp.status='pending')  pending_count,
                  COALESCE(SUM(pp.expected_amount) FILTER (WHERE pp.status='received'),0) received_total,
                  COALESCE(SUM(pp.expected_amount) FILTER (WHERE pp.status='overdue'),0)  overdue_total
                FROM personal_loans pl
                LEFT JOIN personal_loan_payments pp ON pp.loan_id = pl.id
                WHERE pl.owner='damon'
                GROUP BY pl.id ORDER BY pl.principal DESC`).catch(() => ({rows:[]})),
    pool.query(`SELECT pp.id, pp.expected_date, pp.expected_amount, pp.cost,
                  pp.net_profit, pp.status, pp.received_date,
                  pl.borrower_name, pl.id loan_id
                FROM personal_loan_payments pp
                JOIN personal_loans pl ON pl.id=pp.loan_id
                WHERE pl.owner='damon'
                ORDER BY pp.expected_date ASC`).catch(() => ({rows:[]})),
    pool.query(`SELECT
                  COALESCE(SUM(pp.expected_amount) FILTER (WHERE pp.status='received'), 0) total_received,
                  COALESCE(SUM(pp.cost) FILTER (WHERE pp.status='received'), 0) total_cost_received,
                  COALESCE(SUM(pp.net_profit) FILTER (WHERE pp.status='received'), 0) total_net_received,
                  COALESCE(SUM(pp.expected_amount) FILTER (WHERE pp.status='overdue'), 0) total_overdue,
                  COALESCE(SUM(pp.cost) FILTER (WHERE pp.status='overdue'), 0) total_cost_overdue,
                  COALESCE(SUM(pp.expected_amount) FILTER (WHERE pp.status='pending'), 0) total_pending
                FROM personal_loan_payments pp
                JOIN personal_loans pl ON pl.id=pp.loan_id
                WHERE pl.owner='damon'`).catch(() => ({rows:[{}]})),
  ]);

  // 业务数据
  const statusMap = {};
  orders.rows.forEach(r => { statusMap[r.status] = parseInt(r.n); });
  const active = Object.entries(statusMap).filter(([k]) => !["shipped","cancelled","delivered"].includes(k)).reduce((s,[,v]) => s+v, 0);
  const totalAR = ar.rows.reduce((s,r) => s + parseFloat(r.total||0), 0);
  const overdueAR = ar.rows.reduce((s,r) => s + parseInt(r.overdue||0), 0);
  const inTransit = parseInt(shipping.rows[0]?.in_transit || 0);

  // 个人财务总览
  const totals = paymentTotals.rows[0] || {};
  const totalLent = personalLoans.rows.reduce((s,r) => s + parseFloat(r.principal||0), 0);
  const monthlyNet = personalLoans.rows.reduce((s,r) => s + parseFloat(r.monthly_net||0), 0);
  const totalReceived = parseFloat(totals.total_received || 0);
  const totalCostReceived = parseFloat(totals.total_cost_received || 0);
  const totalNetReceived = parseFloat(totals.total_net_received || 0);
  const totalOverdue = parseFloat(totals.total_overdue || 0);
  const totalCostOverdue = parseFloat(totals.total_cost_overdue || 0);
  const totalPending = parseFloat(totals.total_pending || 0);

  // 月度调度（按月分组）
  const byMonth = {};
  const today = new Date();
  paymentSchedule.rows.forEach(p => {
    const d = new Date(p.expected_date);
    const key = d.toISOString().slice(0, 7);
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push({
      ...p,
      day: d.getDate(),
      isPast: d < today,
      isThisMonth: d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear(),
    });
  });

  // 借款人汇总
  const borrowerRows = personalLoans.rows.map(r => {
    const isOverdue = r.status === "overdue";
    const due = r.due_date ? new Date(r.due_date).toLocaleDateString("zh-CN") : "—";
    const net = parseFloat(r.monthly_net||0);
    return `<div class="loan-card${isOverdue?' overdue':''}" data-loan="${r.id}">
      <div class="loan-head">
        <div class="loan-name">${r.borrower_name}</div>
        <div class="loan-status ${isOverdue?'red':'green'}">${isOverdue?'⚠ 全部逾期':'✓ 正常'}</div>
      </div>
      <div class="loan-principal">¥${(parseFloat(r.principal)/10000).toFixed(0)}<span>万</span></div>
      <div class="loan-stats">
        <div><span class="lbl">月净利</span><span class="val ${net<0?'red':'green'}">¥${Math.round(net).toLocaleString()}</span></div>
        <div><span class="lbl">已收/逾期/待</span><span class="val">${r.received_count}/${r.overdue_count}/${r.pending_count}</span></div>
        <div><span class="lbl">到期</span><span class="val">${due}</span></div>
      </div>
      <button class="loan-toggle" onclick="toggleSchedule(${r.id})">📅 月度明细 ▼</button>
    </div>`;
  }).join("");

  // 月度调度表（每个借款人独立）
  const scheduleSection = personalLoans.rows.map(loan => {
    const pmts = paymentSchedule.rows.filter(p => p.loan_id === loan.id);
    const rows = pmts.map(p => {
      const d = new Date(p.expected_date);
      const isPast = d < today;
      const dateStr = d.toLocaleDateString("zh-CN", { year:"numeric", month:"2-digit", day:"2-digit" });
      const stClass = p.status === "received" ? "rec" : p.status === "overdue" ? "od" : "pn";
      const stLabel = p.status === "received" ? "✓ 已收" : p.status === "overdue" ? "⚠ 逾期" : (isPast?"○ 待收":"⏳ 未到");
      return `<div class="row ${stClass}">
        <div class="date">${dateStr}</div>
        <div class="amt">¥${parseFloat(p.expected_amount).toLocaleString()}</div>
        <div class="cost">-¥${parseFloat(p.cost).toLocaleString()}</div>
        <div class="net ${parseFloat(p.net_profit)<0?'red':'green'}">${parseFloat(p.net_profit)<0?'':'+'}¥${parseFloat(p.net_profit).toLocaleString()}</div>
        <div class="st">${stLabel}</div>
      </div>`;
    }).join("");
    return `<div id="sched-${loan.id}" class="schedule" style="display:none">
      <div class="sched-title">📅 ${loan.borrower_name} 月度明细 · 共 ${pmts.length} 笔</div>
      <div class="sched-head">
        <div>日期</div><div>应收</div><div>成本</div><div>净利</div><div>状态</div>
      </div>
      ${rows}
    </div>`;
  }).join("");

  // 接下来 30 天的还款日
  const next30 = paymentSchedule.rows
    .filter(p => {
      const d = new Date(p.expected_date);
      const diff = (d - today) / 86400000;
      return diff >= 0 && diff <= 30 && p.status !== "received";
    })
    .map(p => {
      const d = new Date(p.expected_date);
      return `<div class="upcoming-row">
        <div class="up-date"><div class="up-day">${d.getDate()}</div><div class="up-mon">${d.getMonth()+1}月</div></div>
        <div class="up-info">
          <div class="up-name">${p.borrower_name}</div>
          <div class="up-amt">¥${parseFloat(p.expected_amount).toLocaleString()} · 净 ¥${parseFloat(p.net_profit).toLocaleString()}</div>
        </div>
        <div class="up-status ${p.status==='overdue'?'red':'amber'}">${p.status==='overdue'?'已逾期':'待收'}</div>
      </div>`;
    }).join("");

  const arRows = ar.rows.map(r => `<div class="ar-row">
    <div class="ar-co">${r.issuing_company || "—"}</div>
    <div class="ar-amt">$${Math.round(parseFloat(r.total||0)).toLocaleString()}</div>
    <div class="ar-st ${parseInt(r.overdue)>0?'red':'green'}">${parseInt(r.overdue)>0?`${r.overdue}逾期`:"正常"}</div>
  </div>`).join("");

  const now = new Date().toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sanlyn · 实时总览</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;
  background:#000;
  color:#f1f5f9;
  min-height:100vh;
  overflow-x:hidden;
  position:relative;
}
/* 渐变背景 + 光斑 */
body::before{
  content:"";
  position:fixed;
  inset:0;
  background:
    radial-gradient(900px 600px at 10% -10%, rgba(99,102,241,.18), transparent 50%),
    radial-gradient(700px 500px at 90% 10%, rgba(168,85,247,.15), transparent 50%),
    radial-gradient(800px 600px at 50% 100%, rgba(59,130,246,.15), transparent 50%),
    linear-gradient(180deg, #050816 0%, #0a0f1f 50%, #0c0a1c 100%);
  z-index:-1;
}
/* 粒子动画 */
@keyframes float{
  0%,100%{transform:translateY(0) rotate(0deg)}
  50%{transform:translateY(-20px) rotate(5deg)}
}
@keyframes pulse{
  0%,100%{opacity:.4;transform:scale(1)}
  50%{opacity:.8;transform:scale(1.1)}
}
@keyframes shimmer{
  0%{background-position:-200% center}
  100%{background-position:200% center}
}
@keyframes fadeIn{
  from{opacity:0;transform:translateY(20px)}
  to{opacity:1;transform:translateY(0)}
}
@keyframes slideIn{
  from{opacity:0;transform:translateX(-20px)}
  to{opacity:1;transform:translateX(0)}
}

.wrap{max-width:1100px;margin:0 auto;padding:24px 20px 60px;animation:fadeIn .6s ease-out}

/* Header */
.head{margin-bottom:32px}
.h-title{
  font-size:28px;
  font-weight:800;
  background:linear-gradient(90deg,#a5b4fc,#c4b5fd,#f0abfc);
  background-size:200% auto;
  -webkit-background-clip:text;
  -webkit-text-fill-color:transparent;
  background-clip:text;
  animation:shimmer 4s linear infinite;
  letter-spacing:-0.5px;
}
.h-sub{font-size:12px;color:#64748b;margin-top:4px}
.h-sub a{color:#818cf8;text-decoration:none}
.h-sub a:hover{color:#c4b5fd}

/* Section title */
.section-bar{
  display:flex;align-items:center;gap:12px;
  margin:32px 0 16px;
}
.section-bar h2{
  font-size:13px;font-weight:700;color:#a5b4fc;
  letter-spacing:2px;text-transform:uppercase;
}
.section-bar .line{
  flex:1;height:1px;
  background:linear-gradient(90deg,rgba(99,102,241,.3),transparent);
}

/* Hero metric — 月度净利 */
.hero{
  background:linear-gradient(135deg,rgba(99,102,241,.1),rgba(168,85,247,.05));
  border:1px solid rgba(99,102,241,.2);
  border-radius:20px;
  padding:24px;
  position:relative;
  overflow:hidden;
  margin-bottom:20px;
}
.hero::before{
  content:"";
  position:absolute;
  top:-50%;left:-50%;width:200%;height:200%;
  background:radial-gradient(circle at center,rgba(99,102,241,.1) 0%,transparent 70%);
  animation:pulse 6s ease-in-out infinite;
}
.hero-content{position:relative;z-index:1}
.hero-label{font-size:12px;color:#94a3b8;letter-spacing:1px;font-weight:600}
.hero-value{
  font-size:48px;font-weight:900;
  background:linear-gradient(135deg,#10b981,#06b6d4);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
  margin:8px 0;
  font-variant-numeric:tabular-nums;
}
.hero-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:16px}
.hero-stat{padding:12px;background:rgba(0,0,0,.3);border-radius:12px;border:1px solid rgba(255,255,255,.05)}
.hero-stat .lbl{font-size:10px;color:#64748b;letter-spacing:.5px}
.hero-stat .val{font-size:18px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
.green{color:#10b981}.red{color:#ef4444}.amber{color:#f59e0b}.blue{color:#60a5fa}

/* Stat cards grid */
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
@media(max-width:640px){.grid{grid-template-columns:repeat(2,1fr)}.hero-grid{grid-template-columns:1fr}.hero-value{font-size:36px}}

.card{
  background:rgba(255,255,255,.03);
  backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
  border:1px solid rgba(255,255,255,.06);
  border-radius:16px;
  padding:18px;
  text-align:center;
  position:relative;
  transition:all .3s ease;
  animation:fadeIn .6s ease-out backwards;
}
.card:hover{
  transform:translateY(-2px);
  border-color:rgba(99,102,241,.3);
  background:rgba(99,102,241,.05);
}
.card .icon{font-size:24px;margin-bottom:8px;display:block}
.card .val{font-size:24px;font-weight:800;font-variant-numeric:tabular-nums;color:#60a5fa}
.card .val.red{color:#ef4444}
.card .lbl{font-size:10px;color:#64748b;margin-top:6px;font-weight:600;letter-spacing:.5px}

/* 借款卡片 */
.loan-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:20px}
.loan-card{
  background:linear-gradient(135deg,rgba(255,255,255,.04),rgba(255,255,255,.02));
  backdrop-filter:blur(10px);
  border:1px solid rgba(255,255,255,.08);
  border-radius:16px;
  padding:18px;
  position:relative;
  transition:all .3s ease;
  animation:fadeIn .6s ease-out backwards;
}
.loan-card:hover{transform:translateY(-2px);border-color:rgba(99,102,241,.3)}
.loan-card.overdue{border-color:rgba(239,68,68,.3);background:linear-gradient(135deg,rgba(239,68,68,.06),rgba(255,255,255,.02))}
.loan-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.loan-name{font-size:14px;font-weight:700;color:#e2e8f0}
.loan-status{font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px}
.loan-status.green{background:rgba(16,185,129,.1);color:#10b981}
.loan-status.red{background:rgba(239,68,68,.1);color:#ef4444}
.loan-principal{font-size:32px;font-weight:900;color:#f1f5f9;font-variant-numeric:tabular-nums;margin-bottom:12px}
.loan-principal span{font-size:14px;color:#64748b;font-weight:600;margin-left:4px}
.loan-stats{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.loan-stats > div{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed rgba(255,255,255,.05)}
.loan-stats > div:last-child{border-bottom:none}
.loan-stats .lbl{font-size:10px;color:#64748b}
.loan-stats .val{font-size:11px;font-weight:700;color:#cbd5e1;font-variant-numeric:tabular-nums}
.loan-toggle{
  width:100%;padding:8px;
  background:rgba(99,102,241,.1);
  border:1px solid rgba(99,102,241,.2);
  border-radius:8px;
  color:#a5b4fc;font-size:11px;font-weight:600;
  cursor:pointer;transition:all .2s;
}
.loan-toggle:hover{background:rgba(99,102,241,.2);color:#c4b5fd}

/* Schedule */
.schedule{
  background:rgba(0,0,0,.3);
  border:1px solid rgba(255,255,255,.05);
  border-radius:14px;
  padding:16px;
  margin-bottom:14px;
  animation:fadeIn .3s ease-out;
}
.sched-title{font-size:13px;font-weight:700;color:#a5b4fc;margin-bottom:12px}
.sched-head, .schedule .row{
  display:grid;
  grid-template-columns:90px 1fr 1fr 1fr 70px;
  gap:8px;
  padding:8px 4px;
  font-size:11px;
}
.sched-head{color:#64748b;font-weight:700;letter-spacing:.5px;border-bottom:1px solid rgba(255,255,255,.06)}
.schedule .row{border-bottom:1px solid rgba(255,255,255,.03);transition:background .2s}
.schedule .row:hover{background:rgba(255,255,255,.02)}
.schedule .date{color:#94a3b8;font-variant-numeric:tabular-nums}
.schedule .amt,.schedule .cost,.schedule .net{font-variant-numeric:tabular-nums;font-weight:600}
.schedule .amt{color:#cbd5e1}
.schedule .cost{color:#f59e0b}
.schedule .st{font-size:10px;font-weight:600}
.schedule .row.rec .st{color:#10b981}
.schedule .row.od .st{color:#ef4444}
.schedule .row.od{background:rgba(239,68,68,.04)}
.schedule .row.pn .st{color:#94a3b8}

/* Upcoming */
.upcoming{
  background:rgba(255,255,255,.03);
  border:1px solid rgba(255,255,255,.06);
  border-radius:16px;
  padding:18px;
  margin-bottom:20px;
}
.upcoming-row{
  display:flex;align-items:center;gap:14px;
  padding:10px 0;
  border-bottom:1px solid rgba(255,255,255,.04);
}
.upcoming-row:last-child{border:none}
.up-date{
  width:48px;height:48px;
  background:rgba(99,102,241,.08);
  border:1px solid rgba(99,102,241,.2);
  border-radius:10px;
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  flex-shrink:0;
}
.up-day{font-size:18px;font-weight:800;color:#a5b4fc;line-height:1}
.up-mon{font-size:9px;color:#64748b;margin-top:2px}
.up-info{flex:1;min-width:0}
.up-name{font-size:13px;font-weight:700;color:#e2e8f0}
.up-amt{font-size:11px;color:#64748b;margin-top:2px;font-variant-numeric:tabular-nums}
.up-status{font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px}
.up-status.amber{background:rgba(245,158,11,.1);color:#f59e0b}
.up-status.red{background:rgba(239,68,68,.1);color:#ef4444}

/* AR section */
.ar-section{
  background:rgba(255,255,255,.03);
  border:1px solid rgba(255,255,255,.06);
  border-radius:16px;
  padding:18px;
}
.ar-row{
  display:grid;grid-template-columns:1fr auto auto;gap:14px;
  padding:10px 0;
  border-bottom:1px solid rgba(255,255,255,.04);
  font-size:13px;
}
.ar-row:last-child{border:none}
.ar-co{color:#cbd5e1;font-weight:600}
.ar-amt{color:#60a5fa;font-weight:700;font-variant-numeric:tabular-nums}
.ar-st{font-size:10px;font-weight:700;padding:3px 8px;border-radius:5px}
.ar-st.green{background:rgba(16,185,129,.1);color:#10b981}
.ar-st.red{background:rgba(239,68,68,.1);color:#ef4444}

/* Refresh button */
.refresh{
  width:100%;padding:14px;
  background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(168,85,247,.1));
  border:1px solid rgba(99,102,241,.3);
  border-radius:12px;
  color:#a5b4fc;font-size:13px;font-weight:700;
  cursor:pointer;transition:all .3s;
  margin-top:14px;
  letter-spacing:1px;
}
.refresh:hover{
  background:linear-gradient(135deg,rgba(99,102,241,.25),rgba(168,85,247,.2));
  transform:translateY(-1px);
  box-shadow:0 8px 24px rgba(99,102,241,.2);
}
.empty{text-align:center;color:#64748b;padding:30px;font-size:13px}
</style>
</head>
<body>
<div class="wrap">

  <div class="head">
    <div class="h-title">📊 Sanlyn 实时总览</div>
    <div class="h-sub">${now} · <a href="javascript:location.reload()">↻ 刷新</a></div>
  </div>

  <!-- Hero: 个人财务核心指标 -->
  <div class="hero">
    <div class="hero-content">
      <div class="hero-label">💎 累计净收益（已收）</div>
      <div class="hero-value">¥${Math.round(totalNetReceived).toLocaleString()}</div>
      <div class="hero-grid">
        <div class="hero-stat">
          <div class="lbl">累计已收利息</div>
          <div class="val green">¥${Math.round(totalReceived).toLocaleString()}</div>
        </div>
        <div class="hero-stat">
          <div class="lbl">累计支付银行成本</div>
          <div class="val amber">-¥${Math.round(totalCostReceived).toLocaleString()}</div>
        </div>
        <div class="hero-stat">
          <div class="lbl">逾期未收（含潜在损失）</div>
          <div class="val red">¥${Math.round(totalOverdue+totalCostOverdue).toLocaleString()}</div>
        </div>
      </div>
    </div>
  </div>

  <!-- 月度运转 -->
  <div class="grid">
    <div class="card" style="animation-delay:.05s"><span class="icon">💰</span><div class="val green">¥${Math.round(monthlyNet/1000)}K</div><div class="lbl">月净收益</div></div>
    <div class="card" style="animation-delay:.1s"><span class="icon">📦</span><div class="val">¥${Math.round(totalLent/10000)}万</div><div class="lbl">借出本金</div></div>
    <div class="card" style="animation-delay:.15s"><span class="icon">⏳</span><div class="val">¥${Math.round(totalPending/1000)}K</div><div class="lbl">待收（未到期）</div></div>
    <div class="card" style="animation-delay:.2s"><span class="icon">⚠️</span><div class="val red">¥${Math.round(totalOverdue/1000)}K</div><div class="lbl">已逾期</div></div>
  </div>

  <!-- 借款人卡片 -->
  <div class="section-bar"><h2>借款人</h2><div class="line"></div></div>
  <div class="loan-grid">${borrowerRows}</div>

  <!-- 月度调度（折叠） -->
  ${scheduleSection}

  <!-- 接下来 30 天 -->
  <div class="section-bar"><h2>接下来 30 天还款日</h2><div class="line"></div></div>
  <div class="upcoming">
    ${next30 || '<div class="empty">未来 30 天没有待收/逾期款项</div>'}
  </div>

  <!-- 公司应收 -->
  <div class="section-bar"><h2>公司应收账款</h2><div class="line"></div></div>
  <div class="ar-section">
    ${arRows || '<div class="empty">暂无公司应收账款</div>'}
  </div>

  <button class="refresh" onclick="location.reload()">↻ 刷新数据</button>
</div>

<script>
function toggleSchedule(id){
  const el = document.getElementById('sched-'+id);
  if(!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
  if(el.style.display === 'block') el.scrollIntoView({behavior:'smooth', block:'center'});
}
</script>
</body>
</html>`);
}
