// /api/db/doc-reminders.js
// One-click reminder for pending documents (BL / VC / pickup / loading / return photos / ...)
// 24-hour cooldown per docId to prevent spam. Notifies via WeCom.
//
//   POST /api/db/doc-reminders
//     body: { docId, docType, blNo, contractNo, customer, docLabel, message? }
//     -> 200 { ok, sentAt, row }
//     -> 429 { error: "cooldown", nextAllowedAt }  when last reminder <24h ago
//
//   GET /api/db/doc-reminders?docId=...   (list history for that doc)
//   GET /api/db/doc-reminders?blNo=...    (all reminders on a BL)

import { getPool, setCors } from "../db.js";

const COOLDOWN_HOURS = 24;

async function notifyWecom({ docLabel, docType, blNo, contractNo, customer, remindedBy, message }) {
  const url = process.env.WECOM_WEBHOOK_URL;
  if (!url) return { skipped: true };
  const title = `🔔 Reminder — ${docLabel || docType || "document"} pending`;
  const lines = [
    `**${title}**`,
    blNo       ? `BL: \`${blNo}\`` : null,
    contractNo ? `Order: \`${contractNo}\`` : null,
    customer   ? `Customer: ${customer}` : null,
    `Requested by: ${remindedBy || "user"}`,
    message ? `> ${message}` : "_Please update this document as soon as possible._",
  ].filter(Boolean);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content: lines.join("\n") },
      }),
    });
    return { ok: true };
  } catch (e) {
    console.error("[doc-reminders] wecom failed:", e.message);
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  try {
    if (req.method === "GET") {
      const { docId, blNo, limit = 50 } = req.query || {};
      const conds = [], vals = [];
      if (docId) { vals.push(docId); conds.push("doc_id = $" + vals.length); }
      if (blNo)  { vals.push(blNo);  conds.push("bl_no = $"  + vals.length); }
      if (!conds.length) return res.status(400).json({ error: "docId or blNo required" });
      vals.push(parseInt(limit));
      const r = await pool.query(
        `SELECT * FROM document_reminders
         WHERE ${conds.join(" AND ")}
         ORDER BY sent_at DESC
         LIMIT $${vals.length}`,
        vals
      );
      return res.status(200).json({ data: r.rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      // ── ETD delay notification (type='etd_delay') ───────────────
      if (b.type === "etd_delay") {
        const { order_id, order_no, old_etd, new_etd, customer } = b;
        if (!order_no || !old_etd || !new_etd)
          return res.status(400).json({ error: "order_no, old_etd, new_etd required for etd_delay" });

        // 1. WeCom push
        const webhook = process.env.WECOM_WEBHOOK_URL;
        if (webhook) {
          const msg = `**⚠ ETD 推迟通知**\n订单: \`${order_no}\`\n客户: ${customer || "—"}\n原 ETD: ${old_etd}\n新 ETD: ${new_etd}\n> 请及时跟进装期安排`;
          await fetch(webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msgtype: "markdown", markdown: { content: msg } }),
          }).catch(e => console.error("[doc-reminders etd_delay] wecom:", e.message));
        }

        // 2. Append to orders.raw.etd_history[]
        if (order_id) {
          const entry = JSON.stringify({ from: old_etd, to: new_etd, changed_at: new Date().toISOString() });
          await pool.query(
            `UPDATE orders
             SET raw = jsonb_set(
               COALESCE(raw,'{}'),
               '{etd_history}',
               COALESCE(raw->'etd_history','[]'::jsonb) || $1::jsonb
             )
             WHERE id = $2`,
            [entry, order_id]
          ).catch(e => console.error("[doc-reminders etd_delay] db:", e.message));
        }

        return res.status(200).json({ ok: true, type: "etd_delay", order_no, old_etd, new_etd });
      }

      if (!b.docId) return res.status(400).json({ error: "docId required" });

      // Cooldown check: latest reminder for this docId
      const last = await pool.query(
        `SELECT sent_at FROM document_reminders
         WHERE doc_id = $1
         ORDER BY sent_at DESC LIMIT 1`,
        [b.docId]
      );
      if (last.rows.length) {
        const lastAt = new Date(last.rows[0].sent_at);
        const elapsedH = (Date.now() - lastAt.getTime()) / 3600000;
        if (elapsedH < COOLDOWN_HOURS) {
          const nextAt = new Date(lastAt.getTime() + COOLDOWN_HOURS * 3600000);
          return res.status(429).json({
            error: "cooldown",
            message: `Already reminded ${Math.round(elapsedH * 10) / 10}h ago. Next allowed at ${nextAt.toISOString()}`,
            lastSentAt: last.rows[0].sent_at,
            nextAllowedAt: nextAt.toISOString(),
            cooldownHours: COOLDOWN_HOURS,
          });
        }
      }

      const remindedBy = b.remindedBy || req.user?.name || req.user?.email || "system";

      // Send WeCom first — if it fails we still record (for audit), just flag result
      const notify = await notifyWecom({
        docLabel: b.docLabel,
        docType: b.docType,
        blNo: b.blNo,
        contractNo: b.contractNo,
        customer: b.customer,
        remindedBy,
        message: b.message,
      });

      const ins = await pool.query(
        `INSERT INTO document_reminders
           (doc_id, doc_type, bl_no, contract_no, customer, reminded_by, channel, message)
         VALUES ($1,$2,$3,$4,$5,$6,'wecom',$7)
         RETURNING *`,
        [b.docId, b.docType || null, b.blNo || null, b.contractNo || null,
         b.customer || null, remindedBy, b.message || null]
      );

      return res.status(200).json({
        ok: true,
        row: ins.rows[0],
        notify,
        nextAllowedAt: new Date(Date.now() + COOLDOWN_HOURS * 3600000).toISOString(),
        cooldownHours: COOLDOWN_HOURS,
      });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("[doc-reminders] error:", err);
    return res.status(500).json({ error: "internal", detail: err.message });
  }
}
