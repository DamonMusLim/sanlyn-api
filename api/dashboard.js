// api/dashboard.js — 私人实时数据看板（仅限 admin）
// GET /api/dashboard → 返回 HTML 页面，实时从 DB 拉数据

import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // 支持 token 放 query string（方便从 Trilium 直接打开）
  if (req.query.token) {
    req.headers.authorization = "Bearer " + req.query.token;
  }
  if (!requireAuth(req, res)) return;
  if (req.user.role !== "admin") return res.status(403).end();

  const pool = getPool();

  const [orders, ar, shipping, personalLoans, personalPayments] = await Promise.all([
    pool.query(`SELECT status, COUNT(*) n FROM orders GROUP BY status`),
    pool.query(`SELECT issuing_company, issuing_code,
                  SUM(amount) total, COUNT(*) cnt,
                  COUNT(*) FILTER (WHERE due_date < NOW()) overdue
                FROM finance_records
                WHERE direction='AR' AND status IN ('pending','partial')
                GROUP BY issuing_company, issuing_code
                ORDER BY total DESC LIMIT 10`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE eta > NOW()) in_transit,
                  COUNT(*) FILTER (WHERE eta < NOW() AND eta > NOW()-'30 days'::INTERVAL) arrived
                FROM shipping_plans`),
    pool.query(`SELECT pl.id, pl.borrower_name, pl.principal, pl.monthly_net,
                  pl.due_date, pl.status,
                  COUNT(pp.id) FILTER (WHERE pp.status='received') received_count,
                  COUNT(pp.id) FILTER (WHERE pp.status='overdue')  overdue_count,
                  COUNT(pp.id) FILTER (WHERE pp.status='pending')  pending_count,
                  COALESCE(SUM(pp.expected_amount) FILTER (WHERE pp.status='received'),0) received_total,
                  COALESCE(SUM(pp.expected_amount) FILTER (WHERE pp.status='overdue'),0)  overdue_total
                FROM personal_loans pl
                LEFT JOIN personal_loan_payments pp ON pp.loan_id = pl.id
                WHERE pl.owner='damon'
                GROUP BY pl.id ORDER BY pl.principal DESC`).catch(() => ({rows:[]})),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status='overdue') overdue,
                  COUNT(*) FILTER (WHERE status='pending' AND expected_date <= NOW()+'7 days'::INTERVAL) due_soon
                FROM personal_loan_payments pp
                JOIN personal_loans pl ON pl.id=pp.loan_id
                WHERE pl.owner='damon'`).catch(() => ({rows:[{}]})),
  ]);

  const statusMap = {};
  orders.rows.forEach(r => { statusMap[r.status] = parseInt(r.n); });
  const active = Object.entries(statusMap)
    .filter(([k]) => !["shipped","cancelled","delivered"].includes(k))
    .reduce((s,[,v]) => s+v, 0);

  const totalAR = ar.rows.reduce((s,r) => s + parseFloat(r.total||0), 0);
  const overdueTotal = ar.rows.reduce((s,r) => s + parseInt(r.overdue||0), 0);
  const inTransit = parseInt(shipping.rows[0]?.in_transit || 0);

  // 个人借款汇总
  const totalLent = personalLoans.rows.reduce((s,r) => s + parseFloat(r.principal||0), 0);
  const totalNet  = personalLoans.rows.reduce((s,r) => s + parseFloat(r.monthly_net||0), 0);
  const personalOverdue = parseInt(personalPayments.rows[0]?.overdue || 0);
  const personalDueSoon = parseInt(personalPayments.rows[0]?.due_soon || 0);

  const personalRows = personalLoans.rows.map(r => {
    const isOverdue = r.status === "overdue";
    const due = r.due_date ? new Date(r.due_date).toLocaleDateString("zh-CN") : "—";
    return `<tr>
      <td>${r.borrower_name}</td>
      <td class="num">¥${Math.round(parseFloat(r.principal||0)).toLocaleString()}</td>
      <td class="num" style="color:${parseFloat(r.monthly_net)<0?"#ef4444":"#10b981"}">¥${Math.round(parseFloat(r.monthly_net||0)).toLocaleString()}</td>
      <td>${r.received_count}/${r.overdue_count}/${r.pending_count}</td>
      <td>${due}</td>
      <td>${isOverdue ? `<span class="badge red">逾期</span>` : `<span class="badge green">正常</span>`}</td>
    </tr>`;
  }).join("");

  const arRows = ar.rows.map(r => `
    <tr>
      <td>${r.issuing_company || r.issuing_code || "—"}</td>
      <td class="num">$${Math.round(parseFloat(r.total||0)).toLocaleString()}</td>
      <td class="num">${r.cnt}</td>
      <td>${parseInt(r.overdue)>0
        ? `<span class="badge red">${r.overdue} 逾期</span>`
        : `<span class="badge green">正常</span>`}</td>
    </tr>`).join("");

  const statusRows = Object.entries(statusMap).map(([k,v]) => `
    <tr><td>${k}</td><td class="num">${v}</td></tr>`).join("");

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
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1120;color:#f1f5f9;min-height:100vh;padding:20px}
.wrap{max-width:720px;margin:0 auto}
h1{font-size:20px;font-weight:800;margin-bottom:4px}
.sub{font-size:11px;color:#475569;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
@media(max-width:500px){.grid{grid-template-columns:repeat(2,1fr)}}
.card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;text-align:center}
.card .icon{font-size:22px;margin-bottom:6px}
.card .val{font-size:24px;font-weight:800;color:#60a5fa}
.card .val.red{color:#ef4444}
.card .lbl{font-size:10px;color:#475569;margin-top:4px;font-weight:600;letter-spacing:.5px}
.section{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;overflow:hidden;margin-bottom:16px}
.section-title{padding:12px 16px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:1px;border-bottom:1px solid rgba(255,255,255,0.05);text-transform:uppercase}
table{width:100%;border-collapse:collapse}
td{padding:10px 16px;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.04)}
tr:last-child td{border-bottom:none}
.num{text-align:right;font-weight:700;color:#60a5fa;font-variant-numeric:tabular-nums}
.badge{padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700}
.badge.red{background:rgba(239,68,68,0.1);color:#ef4444}
.badge.green{background:rgba(16,185,129,0.1);color:#10b981}
.refresh{width:100%;padding:12px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);border-radius:8px;color:#a5b4fc;font-size:13px;font-weight:600;cursor:pointer;margin-top:4px}
.refresh:hover{background:rgba(99,102,241,0.2)}
</style>
</head>
<body>
<div class="wrap">
  <h1>📊 Sanlyn 实时总览</h1>
  <div class="sub">更新于 ${now} · <a href="javascript:location.reload()" style="color:#6366f1">刷新</a></div>

  <div class="grid">
    <div class="card"><div class="icon">📋</div><div class="val">${active}</div><div class="lbl">进行中订单</div></div>
    <div class="card"><div class="icon">🚢</div><div class="val">${inTransit}</div><div class="lbl">在途货柜</div></div>
    <div class="card"><div class="icon">💰</div><div class="val">$${Math.round(totalAR/1000)}K</div><div class="lbl">公司应收</div></div>
    <div class="card"><div class="icon">⚠️</div><div class="val ${overdueTotal>0?"red":""}">${overdueTotal}</div><div class="lbl">公司逾期</div></div>
  </div>

  <div style="font-size:14px;font-weight:700;color:#a5b4fc;margin:24px 0 12px;letter-spacing:1px">━━ 个人财务 ━━</div>
  <div class="grid">
    <div class="card"><div class="icon">💎</div><div class="val">¥${Math.round(totalLent/10000)}万</div><div class="lbl">借出本金</div></div>
    <div class="card"><div class="icon">📈</div><div class="val">¥${Math.round(totalNet/1000)}K</div><div class="lbl">月净收益</div></div>
    <div class="card"><div class="icon">⏰</div><div class="val ${personalDueSoon>0?"red":""}">${personalDueSoon}</div><div class="lbl">7天内到期</div></div>
    <div class="card"><div class="icon">🔴</div><div class="val ${personalOverdue>0?"red":""}">${personalOverdue}</div><div class="lbl">个人逾期</div></div>
  </div>

  <div class="section">
    <div class="section-title">个人借款明细</div>
    <table>
      <thead><tr>
        <td style="color:#475569;font-size:11px">借款人</td>
        <td class="num" style="color:#475569;font-size:11px">本金</td>
        <td class="num" style="color:#475569;font-size:11px">月净利</td>
        <td style="color:#475569;font-size:11px">已收/逾期/待收</td>
        <td style="color:#475569;font-size:11px">到期</td>
        <td style="color:#475569;font-size:11px">状态</td>
      </tr></thead>
      <tbody>${personalRows || '<tr><td colspan="6" style="text-align:center;color:#475569;padding:20px">暂无数据</td></tr>'}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">各公司待收款</div>
    <table>
      <thead><tr>
        <td style="color:#475569;font-size:11px">公司</td>
        <td class="num" style="color:#475569;font-size:11px">金额</td>
        <td class="num" style="color:#475569;font-size:11px">笔数</td>
        <td style="color:#475569;font-size:11px">状态</td>
      </tr></thead>
      <tbody>${arRows || '<tr><td colspan="4" style="text-align:center;color:#475569;padding:20px">暂无待收款数据</td></tr>'}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">订单状态分布</div>
    <table>
      <tbody>${statusRows || '<tr><td colspan="2" style="text-align:center;color:#475569;padding:20px">暂无数据</td></tr>'}</tbody>
    </table>
  </div>

  <button class="refresh" onclick="location.reload()">↻ 刷新数据</button>
</div>
</body>
</html>`);
}
