// api/db/invoice-confirmation-scan.js — 发票确认超时扫描器（cron 兼具手动触发）
//
// POST /api/db/invoice-confirmation-scan    (auth: admin/system, or x-cron-secret 头)
// GET  /api/db/invoice-confirmation-scan?dry=1  (admin, 只看不推)
//
// 规则：
//   订单 raw.invoiceTokenSentAt 存在但 raw.invoiceConfirmedAt 为空 →
//     - 超 24h  → WeCom L1 提醒 (nudge)
//     - 超 48h  → WeCom L2 升级 (escalate) + 加标 raw.invoiceAlert='L2'
//     - 超 72h  → 订单状态 invoice_blocked + 企微 L3 (hard_block)
//
// 去重: raw.lastInvoiceNotifyAt 存在且 <4h 前 → 本轮跳过（避免刷屏）
//
// 推荐触发：linux cron 每 30 分钟打一次 POST

import { getPool, setCors } from "../db.js";

const WEBHOOK_URL = () => process.env.WECOM_WEBHOOK_URL;
const CRON_SECRET = () => process.env.CRON_SECRET;

async function notifyWecom(markdown) {
  const url = WEBHOOK_URL();
  if (!url) { console.warn("[invoice-scan] no WECOM_WEBHOOK_URL"); return false; }
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content: markdown } }),
    });
    return r.ok;
  } catch (e) {
    console.error("[invoice-scan] wecom failed:", e.message);
    return false;
  }
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 3_600_000;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth: JWT (admin/system) OR x-cron-secret header
  const cronHeader = req.headers["x-cron-secret"];
  const okJwt = req.user && ["admin", "system"].includes(req.user.role);
  const okCron = CRON_SECRET() && cronHeader === CRON_SECRET();
  if (!okJwt && !okCron) return res.status(403).json({ error: "Forbidden" });

  const dry = req.method === "GET" || req.query?.dry === "1" || req.body?.dry === true;
  const pool = getPool();
  const now = new Date().toISOString();

  try {
    // Pull all orders that have a sent token but no confirmation yet
    const { rows } = await pool.query(
      `SELECT order_no, company_code, brand, factory,
              raw->>'invoiceTokenSentAt'      AS sent_at,
              raw->>'invoiceConfirmedAt'      AS confirmed_at,
              raw->>'invoiceAlert'            AS current_alert,
              raw->>'lastInvoiceNotifyAt'     AS last_notify,
              raw->>'reviewStatus'            AS review_status
         FROM orders
        WHERE raw ? 'invoiceTokenSentAt'
          AND (raw->>'invoiceConfirmedAt' IS NULL OR raw->>'invoiceConfirmedAt' = '')`
    );

    const results = { scanned: rows.length, l1: 0, l2: 0, l3: 0, skipped: 0, pushed: 0 };
    const detail = [];

    for (const r of rows) {
      const hrs = hoursSince(r.sent_at);
      const lastNotifyHrs = hoursSince(r.last_notify);
      // Debounce: only 1 notify per 4h
      if (lastNotifyHrs < 4) { results.skipped++; continue; }

      let level = null;
      if (hrs >= 72)       level = "L3";
      else if (hrs >= 48)  level = "L2";
      else if (hrs >= 24)  level = "L1";
      if (!level)          continue;

      // Don't downgrade — if already at L3 keep pushing L3
      if (r.current_alert === "L3" && level !== "L3") level = "L3";

      results[level.toLowerCase()]++;
      detail.push({ orderNo: r.order_no, hoursOverdue: +hrs.toFixed(1), level });

      if (dry) continue;

      // Compose & push WeCom
      const emoji = level === "L3" ? "🔴" : level === "L2" ? "🟠" : "🟡";
      const msg = [
        `${emoji} **发票确认超时告警 · ${level}**`,
        `订单: **${r.order_no}** (${r.company_code || "?"})`,
        `品牌/工厂: ${r.brand || "—"} / ${r.factory || "—"}`,
        `token 已发出 ${hrs.toFixed(1)} 小时，工厂还未确认发票信息`,
        level === "L3" ? "> ⚠️ 超 72h，订单已置 **invoice_blocked**，请立刻干预" :
        level === "L2" ? "> 超 48h，请直接电话工厂" :
                         "> 超 24h，请企微催一下",
      ].join("\n");

      const ok = await notifyWecom(msg);
      if (ok) results.pushed++;

      // Persist state on order
      const newAlert = level;
      const blockStatus = level === "L3" ? "invoice_blocked" : null;
      await pool.query(
        `UPDATE orders SET
           raw = raw
                 || jsonb_build_object('invoiceAlert', $1::text, 'lastInvoiceNotifyAt', $2::text),
           production_status = COALESCE($3, production_status),
           updated_at = NOW()
         WHERE order_no = $4`,
        [newAlert, now, blockStatus, r.order_no]
      );
    }

    return res.status(200).json({
      success: true, scanned: results.scanned, pushed: results.pushed,
      breakdown: { L1: results.l1, L2: results.l2, L3: results.l3, skipped: results.skipped },
      detail, dry
    });
  } catch (e) {
    console.error("[invoice-scan]", e);
    return res.status(500).json({ error: e.message });
  }
}
