// api/db/portcharge-bill-pdf.js
// 港杂费账单(正版 fob_portcharge 模板)+ 自动盖卖方章 → 客户「盖章账单明细扫描件」。
// GET /api/db/portcharge-bill-pdf?token=<magic>&stamp=1&company=OCEANBABY
// 正版模板 = shipping-plan-pdf.js 的 type=fob_portcharge(PC-{BL}-{出单日}编号+集装箱明细+Terms+银行信息)。
// 本端点:magic-link token→shipment_id→调正版handler拿HTML→puppeteer渲染(与htmlToPdf同参数)→
//   量 .pay-box.cny(TOTAL PAYABLE框)位置→章盖其右侧留白(随内容长短自适应,不撞银行账号/费用数字)→OSS。
// ⚠️不自画账单(0731 Damon纠正:先锁真源别自画)。章图铁律同 apply.js/straddle:只取该公司 default+active 唯一章+域名白名单。
import crypto from "crypto";
import puppeteer from "puppeteer-core";
import { getPool } from "./db.js";
import { squareCropStamp } from "../stamp/_straddle-shared.js";
import { clean } from "./statement-portal-helpers.js";
import shippingPlanPdf from "./shipping-plan-pdf.js";

const OSS_BASE = "https://files.sanlynos.com";
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// htmlToPdf 同参数(务必一致,否则版式/坐标对不上)
const PDF_MARGIN = { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" };
const MM = { top: 10, left: 8 };

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

// 调正版 fob_portcharge handler(绕 auth 中间件),拿 HTML 字符串
async function fobPortchargeHtml(sid) {
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const fail = (m) => { if (!done) { done = true; reject(new Error(m)); } };
    const req = { method: "GET", query: { id: String(sid), type: "fob_portcharge" }, headers: {}, user: { role: "admin" } };
    const res = {
      _s: 200, setHeader() {}, writeHead() {}, status(c) { this._s = c; return this; },
      send(b) { finish(typeof b === "string" ? b : String(b || "")); return this; },
      end(b) { if (b != null) finish(typeof b === "string" ? b : String(b)); else fail("正版账单空返回"); return this; },
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

  let browser;
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

    const html = await fobPortchargeHtml(sid);
    if (!html || html.length < 500) return res.status(500).json({ error: "正版账单生成失败" });

    browser = await puppeteer.launch({
      executablePath: "/usr/bin/google-chrome", headless: "new",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 20000 });
    await page.emulateMediaType("print");
    let payBox = null;
    if (doStamp) {
      await page.setViewport({ width: 733, height: 1040 }); // A4内容宽(210-8-8=194mm@96dpi≈733px)
      payBox = await page.evaluate(() => {
        const el = document.querySelector(".pay-box.cny") || document.querySelector(".pay-box") || document.querySelector(".bottom");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { right: r.right, top: r.top, height: r.height };
      }).catch(() => null);
    }
    const basePdf = await page.pdf({ format: "A4", printBackground: true, displayHeaderFooter: false, margin: PDF_MARGIN });
    await browser.close(); browser = null;

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
    const sW = Math.min(pw, ph) * 0.19;
    const sH = sW * (img.height / img.width);
    let sx, sy;
    if (payBox) {
      // 量到 TOTAL PAYABLE 框(css px)→PDF点(0.75)+页边距;章压框右侧留白(¥金额在左)
      const f = 0.75, mL = MM.left * 72 / 25.4, mT = MM.top * 72 / 25.4;
      const cx = payBox.right - 96, cy = payBox.top + payBox.height / 2;
      sx = (mL + cx * f) - sW / 2;
      sy = ph - (mT + cy * f) - sH / 2;
      sx = Math.max(8, Math.min(sx, pw - sW - 8));
      sy = Math.max(8, Math.min(sy, ph - sH - 8));
    } else {
      sx = pw - sW - 78; sy = ph * 0.20; // 量不到退右下
    }
    p.drawImage(img, { x: sx, y: sy, width: sW, height: sH, opacity: 0.85 });
    const outBuf = Buffer.from(await doc.save());
    const stampedUrl = await uploadToOSS(`${base}_stamped.pdf`, outBuf);
    try {
      await pool.query(
        "INSERT INTO stamp_log (document_id,document_name,stamp_key,operator,pages,position,scale,source_url,stamped_url,stamped_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())",
        [`portcharge:${sid}`, "港杂费账单(fob_portcharge)", "portcharge:" + companyCode, "ai:port-charge", "last", "pay-box-right", 0.19, `shipping-plan-pdf?id=${sid}&type=fob_portcharge`, stampedUrl]
      );
    } catch (_) {}
    return res.status(200).json({ ok: true, stamped: true, template: "fob_portcharge", companyCode, stampedUrl });
  } catch (e) {
    console.error("[portcharge-bill-pdf]", e && e.message);
    return res.status(500).json({ error: "bill_pdf_failed", detail: e && e.message });
  } finally {
    if (browser) await browser.close();
  }
}
