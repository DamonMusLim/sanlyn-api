// jobs/order-collab-notify.js — 订单协同·客户版自动邮件 + 3 天视同确认（Damon 0926）
//
// Damon 原话：「超过3天没回复就自动下单」「系统自动发，不用你点」「全部自动」「后续看他们自己设置,把邮箱通知在这里也加上」
// 每 15 分钟看一遍客户版协同单（side='customer'，未作废/未采纳）：
//   link   ：建单后第一封（带客户页链接）
//   r1 / r2：发出满 24h / 48h 仍一个字没回 → 提醒
//   到期   ：满 3 天仍没回（sent/opened）→ 按 PI 条款视同确认 + 发确认通知(deemed)；
//            提了修改但没回签（submitted）→ ⛔ 不自动确认，给艾莎建任务
// 邮件只写进 mail_outbox（status='approved'、tpl_key=order_collab_*、sender_key=petbaby），
// 由 mini 上 email-agent 的白名单发信器按 pb@ 发出 —— ⛔ 这里不直接连邮箱。
//
// 🔴 上线闸（照 bl-confirmation-gate 的教训：新自动化别一上线就把存量单一次性引爆）
//   ① ORDER_COLLAB_NOTIFY_LIVE=true 才真写库，否则只演练记日志
//   ② 只管 sent_at >= ORDER_COLLAB_NOTIFY_CUTOVER（ISO 时间，未设 = 什么都不做）之后发出的客户单
//   ③ 每封邮件按 notify_log 去重，同一张单同一种信只发一次

import pg from "pg";
import dotenv from "dotenv";
import { genRaw, rawToHash, APP_BASE } from "../api/db/lib/collab-shared.js";
import { notifyRecipients, deemAccepted, escalateChangesPending, REPLY_DAYS } from "../api/db/lib/po-collab-customer-notify.js";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

const TAG = "[order-collab-notify]";
const LINK_DAYS = 14;
let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new pg.Pool({
      host: process.env.PG_HOST || "127.0.0.1", port: Number(process.env.PG_PORT || 5432),
      database: process.env.PG_DATABASE || "sanlyn_db", user: process.env.PG_USER || "sanlyn_admin",
      password: process.env.PG_PASSWORD, max: 3,
    });
    _pool.on("error", (e) => console.error(TAG, "pool error:", e.message));
  }
  return _pool;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const bj = (d) => new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " (GMT+8)";

// 每封信都带一条新的客户页链接（只存 hash，原文只在这一刻有）；⛔ 不撤旧链接
async function freshLink(pool, sheet) {
  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1,'customer_order',$2,NOW() + ($3 || ' days')::interval,'[]'::jsonb,NOW())`,
    [rawToHash(raw), JSON.stringify({ order_no: sheet.order_no, sheet_id: sheet.id, side: "customer",
      party_company_id: sheet.party_company_id, issued_via: "order_collab_notify" }), String(LINK_DAYS)]);
  return `${process.env.ORDER_COLLAB_BASE || `${APP_BASE}/oc`}?c=${raw}`;
}

// 邮件正文（英文；署名厦门巴匕 —— pb@ 发信即巴匕抬头）⛔ 不出现内部单号/客户编号/工厂任何信息
// Damon 0927「文案简单点，没必要的事情不说」（DNA：先说要对方做什么，给关键值，不写背景/功能介绍）→ DeepSeek 改写
export function composeMail(kind, s, url) {
  const no = s.pi_no || s.contract_no || "";
  const due = s.reply_due_at ? bj(s.reply_due_at) : "";
  const hi = `<p>Dear ${esc(s.customer || "Customer")},</p>`;
  const sign = `<p>Best regards,<br>Xiamen Pet Baby Import and Export Co., Ltd.</p>`;
  const btn = (label) => url ? `<p><a href="${esc(url)}">${esc(label)}</a></p>` : "";
  if (kind === "link") return {
    subject: `PI ${no} – review and confirm`,
    html: `${hi}<p>Please review PI ${esc(no)} and confirm it, or request changes to quantity, delivery date or shipping marks on the page.</p>`
      + `${btn(`Review PI ${no}`)}<p>If we receive no reply within ${REPLY_DAYS} days (by ${esc(due)}), this PI is deemed accepted according to its terms.</p>${sign}`,
  };
  if (kind === "r1" || kind === "r2") return {
    subject: `PI ${no} – confirm by ${due}`,
    html: `${hi}<p>PI ${esc(no)} is still waiting for your confirmation.</p>`
      + `${btn(`Confirm PI ${no}`)}<p>If we receive no reply by ${esc(due)}, this PI is deemed accepted according to its terms.</p>${sign}`,
  };
  if (kind === "deemed") return {
    subject: `PI ${no} – deemed accepted`,
    html: `${hi}<p>We received no reply on PI ${esc(no)} by ${esc(due)}. According to its terms, the PI is now deemed accepted and we will proceed with your order.</p>`
      + `${btn(`PI ${no}`)}<p>If anything needs to be changed, contact us as soon as possible.</p>${sign}`,
  };
  throw new Error("unknown mail kind " + kind);
}

async function queueMail(pool, s, kind, rcpt, dryRun) {
  if (dryRun) return { dry: true };
  const url = await freshLink(pool, s);
  const m = composeMail(kind, s, url);
  const r = await pool.query(
    `INSERT INTO mail_outbox (tpl_key, sender_key, to_emails, cc_emails, subject, body_html, entity_type, entity_id,
                              related_contract_no, status, prepared_by, counterparty_code)
     VALUES ($1,'petbaby',$2::jsonb,$3::jsonb,$4,$5,'po_sheet',$6,$7,'approved','order-collab-notify',$8) RETURNING id`,
    [`order_collab_${kind}`, JSON.stringify(rcpt.to), JSON.stringify(rcpt.cc), m.subject, m.html, s.id, s.contract_no || null, s.company_code || null]);
  await pool.query(`UPDATE collab.po_sheet SET notify_log = notify_log || jsonb_build_object($2::text, jsonb_build_object('at', NOW(), 'outbox_id', $3::bigint, 'to', $4::jsonb)) WHERE id=$1`,
    [s.id, kind, r.rows[0].id, JSON.stringify(rcpt.to)]);
  return { outbox_id: r.rows[0].id };
}

// 这张单现在该做什么（纯函数，方便测）
export function nextActions(s, now = new Date()) {
  const log = s.notify_log || {};
  const sent = new Date(s.sent_at).getTime(), t = now.getTime();
  const silent = ["sent", "opened"].includes(s.status);
  const due = s.reply_due_at && t >= new Date(s.reply_due_at).getTime();
  const out = [];
  if (!log.link) out.push("link");
  if (silent && !log.r1 && t >= sent + 24 * 3600e3 && !due) out.push("r1");
  if (silent && !log.r2 && t >= sent + 48 * 3600e3 && !due) out.push("r2");
  if (silent && due && !s.deemed_at) out.push("deem");
  if (s.status === "submitted" && due && !log.escalated) out.push("escalate");
  return out;
}

export async function runOrderCollabNotify({ dryRun = true, now = new Date() } = {}) {
  const pool = getPool();
  const cutover = process.env.ORDER_COLLAB_NOTIFY_CUTOVER;
  const stats = { checked: 0, queued: 0, deemed: 0, escalated: 0, no_email: 0, dryRun };
  if (!cutover || isNaN(Date.parse(cutover))) { console.log(TAG, "CUTOVER 未设 → 什么都不做"); return stats; }
  const rows = (await pool.query(
    `SELECT s.id, s.order_no, s.status, s.sent_at, s.reply_due_at, s.deemed_at, s.notify_log, s.party_company_id,
            s.factory_name AS customer, o.pi_no, o.contract_no, o.company_code
       FROM collab.po_sheet s JOIN orders o ON o.order_no = s.order_no
      WHERE s.side='customer' AND s.status NOT IN ('void','adopted') AND s.sent_at >= $1
      ORDER BY s.id`, [cutover])).rows;
  for (const s of rows) {
    stats.checked++;
    const acts = nextActions(s, now);
    if (!acts.length) continue;
    const rcpt = await notifyRecipients(pool, s.party_company_id);
    for (const a of acts) {
      try {
        if (a === "deem") {
          if (!dryRun && await deemAccepted(pool, s.id)) {
            stats.deemed++;
            if (rcpt.to.length) { await queueMail(pool, s, "deemed", rcpt, dryRun); stats.queued++; }
          } else if (dryRun) stats.deemed++;
          continue;
        }
        if (a === "escalate") {
          if (!dryRun) {
            await escalateChangesPending(pool, s.id);
            await pool.query(`UPDATE collab.po_sheet SET notify_log = notify_log || jsonb_build_object('escalated', jsonb_build_object('at', NOW())) WHERE id=$1`, [s.id]);
          }
          stats.escalated++;
          continue;
        }
        if (!rcpt.to.length) {                // 没有任何可发邮箱 → 只记一次，交人工补
          if (!(s.notify_log || {}).no_email) {
            stats.no_email++;
            if (!dryRun) await pool.query(`UPDATE collab.po_sheet SET notify_log = notify_log || jsonb_build_object('no_email', jsonb_build_object('at', NOW())) WHERE id=$1`, [s.id]);
          }
          continue;
        }
        await queueMail(pool, s, a, rcpt, dryRun); stats.queued++;
      } catch (e) { console.error(TAG, `sheet ${s.id} ${a} failed:`, e.message); }
    }
  }
  console.log(TAG, "done:", JSON.stringify(stats));
  return stats;
}

export function scheduleOrderCollabNotify() {
  const live = process.env.ORDER_COLLAB_NOTIFY_LIVE === "true";
  if (!live) console.log(TAG, "LIVE=false → 只演练(dryRun)，不写库不排信");
  const every = 15 * 60 * 1000;
  const tick = () => runOrderCollabNotify({ dryRun: !live })
    .catch((e) => console.error(TAG, "error:", e.message))
    .finally(() => setTimeout(tick, every));
  setTimeout(tick, 60 * 1000);
}
