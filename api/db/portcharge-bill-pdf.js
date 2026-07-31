// api/db/portcharge-bill-pdf.js
// 港杂费账单(正版 fob_portcharge 模板)+ 自动盖卖方章 → 客户「盖章账单明细扫描件」。
// GET /api/db/portcharge-bill-pdf?token=<magic>&stamp=1&company=OCEANBABY
// 正版模板 = shipping-plan-pdf.js 的 type=fob_portcharge(PC-{BL}-{出单日}编号+集装箱明细+Terms+银行信息)。
// 本端点:magic-link token→shipment_id→直接调正版 handler(绕中间件,拿format=pdf buffer)→(stamp=1)DAS盖章→OSS→返URL。
// ⚠️不再自画账单(0731 Damon纠正:先锁真源别自画)。章图铁律同 apply.js/straddle:只取该公司 default+active 唯一章+域名白名单。
import crypto from "crypto";
import { getPool } from "./db.js";
import { squareCropStamp } from "../stamp/_straddle-shared.js";
import { clean } from "./statement-portal-helpers.js";
import shippingPlanPdf from "./shipping-plan-pdf.js";

const OSS_BASE = "https://files.sanlynos.com";
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

async function uploadToOSS(ossPath, buffer) {
  const OSS = (await import("ali-oss")).default;
  const client = new OSS({
    region: process.env.OSS_REGION, accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET,
  });
  await client.put(ossPath, Buffer.from(buffer), { mime: "application/pdf" });
  return `${OSS_BASE}/${ossPath}`;
}

async function resolveSealUrl(pool, companyCode) {
  const r = await pool.query(
    "SELECT url FROM customer_stamps WHERE upper(company_code)=upper($1) AND is_active=true ORDER BY is_default DESC, uploaded_at DESC LIMIT 1",
    [companyCode]
  );
  const u = r.rows[0] && r.rows[0].url;
  if (u && /^https:\/\/(files\.sanlynos\.com|sanlyn-files\.[a-z0-9.-]*aliyuncs\.com)\//i.test(u)) return u;
  return null;
}

// 直接调正版 fob_portcharge handler(绕过auth中间件),拿 format=pdf 的 PDF buffer
async function fobPortchargePdf(sid) {
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = (b) => { if (!done) { done = true; resolve(b); } };
    const fail = (m) => { if (!done) { done = true; reject(new Error(m)); } };
    const req = { method: "GET", query: { id: String(sid), type: "fob_portcharge", format: "pdf" }, headers: {}, user: { role: "admin" } };
    const res = {
      _s: 200, setHeader() {}, writeHead() {}, status(c) { this._s = c; return this; },
      send(b) { finish(Buffer.isBuffer(b) ? b : Buffer.from(b || "")); return this; },
      end(b) { if (b != null) finish(Buffer.isBuffer(b) ? b : Buffer.from(b)); else fail("正版账单空返回"); return this; },
      json(o) { fail("正版账单生成失败:" + JSON.stringify(o).slice(0, 200)); return this; },
      redirect() { fail("正版账单意外重定向"); return this; },
    };
    Promise.resolve(shippingPlanPdf(req, res)).catch((e) => fail(e && e.message));
  });
}

export default async function portchargeBillPdf(req, res) {
  const pool = getPool();
  const token = clean(req.query?.token);
  const doStamp = String(req.query?.stamp || "") === "1";
  const companyCode = (clean(req.query?.company) || "OCEANBABY").toUpperCase();
  if (!token) return res.status(400).json({ error: "token required" });

  try {
    const ml = await pool.query(
      "SELECT meta FROM magic_links WHERE token_hash=$1 AND expires_at>NOW() AND revoked_at IS NULL LIMIT 1",
      [sha256(token)]
    );
    const sid = ml.rows[0]?.meta?.shipment_id;
    if (!sid) return res.status(404).json({ error: "invalid_or_expired_token" });

    let sealUrl = null;
    if (doStamp) {
      sealUrl = await resolveSealUrl(pool, companyCode);
      if (!sealUrl) return res.status(400).json({ error: "公章未录入DAS", detail: `${companyCode} 无 default+active 章` });
    }

    const basePdf = await fobPortchargePdf(sid);
    if (!basePdf || basePdf.length < 500) return res.status(500).json({ error: "正版账单生成失败" });

    const ts = Date.now();
    const base = `documents/portcharge-bill/${String(sid)}_${ts}`;

    if (!doStamp) {
      const billUrl = await uploadToOSS(`${base}.pdf`, Buffer.from(basePdf));
      return res.status(200).json({ ok: true, stamped: false, template: "fob_portcharge", billUrl });
    }

    const stampResp = await fetch(sealUrl);
    if (!stampResp.ok) throw new Error(`fetch seal ${stampResp.status}`);
    const stampBuf = await squareCropStamp(Buffer.from(await stampResp.arrayBuffer()));
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(basePdf);
    const img = await doc.embedPng(stampBuf);
    const p = doc.getPage(doc.getPageCount() - 1);
    const { width: pw, height: ph } = p.getSize();
    const sW = Math.min(pw, ph) * 0.19;             // ≈40mm 标准公章
    const sH = sW * (img.height / img.width);
    // 右侧,压在 TOTAL PAYABLE 区右方留白(避开左侧金额框+底部银行账号)。可按实测微调。
    const sx = pw - sW - 70;
    const sy = ph * 0.30;
    p.drawImage(img, { x: sx, y: sy, width: sW, height: sH, opacity: 0.85 });
    const outBuf = Buffer.from(await doc.save());
    const stampedUrl = await uploadToOSS(`${base}_stamped.pdf`, outBuf);
    try {
      await pool.query(
        "INSERT INTO stamp_log (document_id,document_name,stamp_key,operator,pages,position,scale,source_url,stamped_url,stamped_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())",
        [`portcharge:${sid}`, "港杂费账单(fob_portcharge)", "portcharge:" + companyCode, "ai:port-charge", "last", "custom", 0.19, `shipping-plan-pdf?id=${sid}&type=fob_portcharge`, stampedUrl]
      );
    } catch (_) {}
    return res.status(200).json({ ok: true, stamped: true, template: "fob_portcharge", companyCode, stampedUrl });
  } catch (e) {
    console.error("[portcharge-bill-pdf]", e && e.message);
    return res.status(500).json({ error: "bill_pdf_failed", detail: e && e.message });
  }
}
