import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { sendViaDM } from "../send-email.js";
import { writeRfqNotification } from "./lib/rfq-pricing.js";

const APP_BASE = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";

function pickEmail(row) {
  if (row.einvoice_email) return row.einvoice_email;
  const info = typeof row.compliance_info === "string" ? JSON.parse(row.compliance_info || "{}") : (row.compliance_info || {});
  const contacts = Array.isArray(info.contacts) ? info.contacts : [];
  return contacts.map(c => c && (c.email || c.contact_email)).find(Boolean) || null;
}

function text(row) {
  return `${row.name || "联系人"}您好，${row.pol}→${row.pod} ${row.ctnr_type}的运价麻烦补一下，点开30秒填完：${row.url}。客户在等价，今天给到还来得及订${row.etd || "近期"}的舱。`;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!requireAuth(req, res)) return;

  const send = (req.body || {}).send === true;
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT i.id AS item_id, r.id AS rfq_id, r.pol, r.pod, r.ctnr_type, r.etd,
            c.id AS company_id, COALESCE(c.name_cn, c.name_en, c.code, c.id::text) AS name,
            c.einvoice_email, c.compliance_info,
            sl.code
       FROM freight_rfq_items i
       JOIN freight_rfqs r ON r.id = i.rfq_id
       JOIN companies c ON c.id = i.forwarder_company_id
       LEFT JOIN LATERAL (
         SELECT code FROM freight_quote_shortlinks
          WHERE item_id = i.id AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
       ) sl ON TRUE
      WHERE r.status = 'open'
        AND COALESCE(i.status,'invited') = 'invited'
        AND r.created_at < NOW() - INTERVAL '24 hours'
        AND r.status <> 'void'
      ORDER BY c.id, r.created_at`
  );
  const groups = new Map();
  for (const r of rows) {
    r.url = `${APP_BASE}/freight-quote/${encodeURIComponent(r.code || r.item_id)}`;
    r.wechat_text = text(r);
    r.email = pickEmail(r);
    if (!groups.has(r.company_id)) groups.set(r.company_id, { forwarder_company_id: r.company_id, name: r.name, email: r.email, items: [], wechat_texts: [] });
    const g = groups.get(r.company_id);
    g.items.push({ rfq_id: r.rfq_id, item_id: r.item_id, pol: r.pol, pod: r.pod, ctnr_type: r.ctnr_type, etd: r.etd, url: r.url });
    g.wechat_texts.push(r.wechat_text);
  }
  const list = Array.from(groups.values());
  for (const g of list) {
    await writeRfqNotification(pool, g.items[0]?.rfq_id || "rfq", `RFQ催报: ${g.name}`, g.wechat_texts.join("\n\n"), {
      forwarder_company_id: g.forwarder_company_id, dry_run: !send,
    });
  }
  const canSend = send && process.env.RFQ_CHASE_SEND_ENABLED === "true";
  const sent = [];
  if (canSend) {
    for (const g of list) {
      if (!g.email) { sent.push({ forwarder_company_id: g.forwarder_company_id, skipped: "missing_email" }); continue; }
      const subject = g.items.length === 1
        ? `【Sanlyn询价】${g.items[0].pol}→${g.items[0].pod} ${g.items[0].ctnr_type} 运价提醒`
        : "【Sanlyn询价】运价提醒";
      const htmlBody = `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${g.wechat_texts.join("\n\n")}\n\nSanlyn</pre>`;
      sent.push({ forwarder_company_id: g.forwarder_company_id, result: await sendViaDM({
        fromAlias: "OB@sanlynos.com", fromName: "Sanlyn", to: g.email, subject, htmlBody,
      }) });
    }
  }
  return res.json({ ok: true, dry_run: !canSend, list, sent });
}
