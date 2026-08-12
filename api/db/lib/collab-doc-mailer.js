// 海运单据自动发信 —— 发件人固定 OCEANBABY <ob@sanlynos.com>（海运都由 ob 发）。
// 触发：协同各方「填写/确认」后 → 把该票单据（托书/排载单/保函）发到对方业务+财务邮箱，
//        并记 shipping_plans.raw.doc_sends 去重（同一 doc_type+email 不重复发）。
// 发信通道复用 app SMTP env（ob@，见 .env SMTP_*）。附件从内部 file 代理自取（与用户下载完全一致的字节）。
// 安全闸：默认 dry-run；仅 opts.live===true 或 env DOC_MAIL_LIVE=1 才真发。绝不自造 SMTP、绝不猜收件人。
import { generateToken } from "../../auth.js";

const APP_PORT = process.env.PORT || 9000;
const DEFAULT_DOCS = ["booking_note", "bl_sample"]; // 托书 + 排载单/SO（保函 telex 按需另传）

function deepGet(o, path) { return String(path).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o); }
function fillVars(tpl, ctx) {
  return String(tpl || "").replace(/{{\s*([\w.]+)\s*}}/g, (_m, k) => { const v = deepGet(ctx, k); return v == null ? "" : String(v); });
}

// 内部渲染单据：与 handleFileProxy 同法——铸内部 svc-agent JWT 直调 documents，
// 拿到的字节与货代/客户下载完全一致（同一渲染路径）。telex 按 release_type 选模板。
async function fetchDocByPlan(pool, planId, type) {
  const jwt = generateToken({ uid: 90, username: "svc-agent", role: "admin", tv: 1 });
  let docType = type;
  if (type === "telex") {
    const rr = await pool.query(`SELECT release_type FROM shipping_plans WHERE id=$1`, [planId]);
    const rt = (rr.rows[0] && rr.rows[0].release_type) || "";
    docType = /swb|sea\s*waybill|海运单/i.test(rt) ? "swb_loi" : "tr";
  }
  const url = `http://127.0.0.1:${APP_PORT}/api/db/documents?type=${encodeURIComponent(docType)}&id=${encodeURIComponent(planId)}&token=${encodeURIComponent(jwt)}`;
  const up = await fetch(url);
  if (!up.ok) throw new Error(`doc ${type} http ${up.status}`);
  const cd = up.headers.get("content-disposition") || "";
  const mm = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
  const filename = mm ? decodeURIComponent(mm[1].replace(/"$/, "")) : `${type}.bin`;
  const content = Buffer.from(await up.arrayBuffer());
  return { filename, content, contentType: up.headers.get("content-type") || "application/octet-stream" };
}

async function buildTransport() {
  if (!process.env.SMTP_HOST) return null;
  const nodemailer = (await import("nodemailer")).default;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== "false",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function loadTemplate(pool, key) {
  try {
    const r = await pool.query(`SELECT subject, html FROM email_templates WHERE tpl_key=$1 AND coalesce(is_active,true) ORDER BY id DESC LIMIT 1`, [key]);
    if (r.rows[0]) return r.rows[0];
  } catch (_e) { /* 表可能不存在 → 用内置兜底 */ }
  return {
    subject: "Shipping Documents - {{orders.contract_no}}",
    html: `<p>Dear {{orders.company_name_en}},</p>
<p>Please find attached the shipping documents for B/L {{orders.bl_no}} (Vessel {{shipping_plans.vessel}}).</p>
<p>Please confirm receipt.</p>
<p>Best regards,<br>OCEANBABY / Sanlyn Logistics</p>`,
  };
}

async function planContext(pool, planId) {
  const r = await pool.query(
    `SELECT sp.id, sp.customer, sp.customer_en, sp.vessel, sp.bl_no, sp.eta,
            (SELECT o.contract_no FROM orders o WHERE o.shipping_plan_id=sp.id LIMIT 1) AS contract_no
       FROM shipping_plans sp WHERE sp.id=$1`, [planId]);
  const sp = r.rows[0];
  if (!sp) return null;
  let co = {};
  try {
    const c = await pool.query(`SELECT name_en, biz_contact_email, contact_email FROM companies WHERE name_cn=$1 LIMIT 1`, [sp.customer]);
    co = c.rows[0] || {};
  } catch (_e) { co = {}; }
  return {
    ctx: {
      orders: {
        company_name_en: sp.customer_en || co.name_en || sp.customer || "",
        contract_no: sp.contract_no || "",
        bl_no: sp.bl_no || "",
        eta: sp.eta ? new Date(sp.eta).toISOString().slice(0, 10) : "",
      },
      shipping_plans: { vessel: sp.vessel || "" },
    },
    // 收件人：对方业务邮箱 + 公司主联系邮箱（去重、去空）。财务只存了电话，无邮箱。
    recipients: Array.from(new Set([co.biz_contact_email, co.contact_email].filter(Boolean))),
  };
}

/**
 * 发某票的海运单据。
 * @param opts {docTypes?:string[], to?:string|string[], live?:boolean, force?:boolean, trigger?:string}
 * 返回 dry-run 预览 或 真发结果；真发后写 raw.doc_sends 去重。
 */
export async function sendPlanDocs(pool, planId, opts = {}) {
  const docTypes = Array.isArray(opts.docTypes) && opts.docTypes.length ? opts.docTypes : DEFAULT_DOCS;
  const live = opts.live === true || (opts.live !== false && process.env.DOC_MAIL_LIVE === "1");

  const info = await planContext(pool, planId);
  if (!info) return { ok: false, error: "plan not found", planId };

  const to = (opts.to ? (Array.isArray(opts.to) ? opts.to : [opts.to]) : info.recipients).filter(Boolean);
  if (!to.length) return { ok: false, skipped: true, reason: "no recipient email on file (待对方填公司卡片)", planId };

  // 渲染附件（缺哪份跳哪份，不报废整封）
  const attachments = [];
  for (const t of docTypes) {
    try { const a = await fetchDocByPlan(pool, planId, t); a.doc_type = t; attachments.push(a); }
    catch (e) { /* 该单据暂未就绪 */ }
  }
  if (!attachments.length) return { ok: false, error: "no documents rendered", planId };

  const tpl = await loadTemplate(pool, "documents");
  const subject = fillVars(tpl.subject, info.ctx);
  const html = fillVars(tpl.html, info.ctx);

  // 去重：已发过的 (doc_type,email) 不再发
  let prev = [];
  try { const p = await pool.query(`SELECT raw->'doc_sends' AS ds FROM shipping_plans WHERE id=$1`, [planId]); prev = Array.isArray(p.rows[0] && p.rows[0].ds) ? p.rows[0].ds : []; } catch (_e) { prev = []; }
  const sentKey = new Set(prev.map((x) => `${x.doc_type}|${x.email}`));

  const result = {
    planId, live, to, subject,
    attachments: attachments.map((a) => ({ filename: a.filename, doc_type: a.doc_type, size: a.content.length })),
    sends: [],
  };

  if (!live) { result.dryrun = true; return result; }

  const transport = await buildTransport();
  if (!transport) return { ok: false, error: "SMTP not configured", planId };

  const nowIso = new Date().toISOString();
  const newEntries = [];
  for (const email of to) {
    const atts = attachments.filter((a) => opts.force || !sentKey.has(`${a.doc_type}|${email}`));
    if (!atts.length) { result.sends.push({ email, skipped: "already sent" }); continue; }
    try {
      await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject,
        html,
        attachments: atts.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
      for (const a of atts) newEntries.push({ doc_type: a.doc_type, email, sent_at: nowIso, subject, trigger: opts.trigger || null });
      result.sends.push({ email, ok: true, docs: atts.map((a) => a.doc_type) });
    } catch (e) {
      result.sends.push({ email, ok: false, error: e.message });
    }
  }

  if (newEntries.length) {
    await pool.query(
      `UPDATE shipping_plans
          SET raw = jsonb_set(coalesce(raw,'{}'::jsonb), '{doc_sends}',
                    coalesce(raw->'doc_sends','[]'::jsonb) || $2::jsonb)
        WHERE id=$1`, [planId, JSON.stringify(newEntries)]);
  }
  result.ok = true;
  result.recorded = newEntries.length;
  return result;
}

export default { sendPlanDocs };
