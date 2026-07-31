// api/db/portcharge-bill-pdf.js
// 港杂费账单明细 PDF（可选盖卖方公章）——给恒安等客户随发票寄的「盖章账单明细扫描件」。
// GET /api/db/portcharge-bill-pdf?token=<magic>&stamp=1&company=OCEANBABY
//   stamp=1 → 盖章版；不带 → 素账单。company 默认 OCEANBABY(洋宝宝,港杂卖方)。
// 账单只读页由 invoice-collab-section 前端 doc=bill 模式渲染(复用恒安已看到的同一份账单外观)。
// 章图铁律：只取 customer_stamps 里该公司 is_default+is_active 的唯一章，域名白名单校验(同 apply.js/straddle)。
import puppeteer from "puppeteer-core";
import { getPool } from "./db.js";
import { squareCropStamp } from "../stamp/_straddle-shared.js";
import { clean } from "./statement-portal-helpers.js";

const OSS_BASE = "https://files.sanlynos.com";

async function uploadToOSS(ossPath, buffer) {
  const OSS = (await import("ali-oss")).default;
  const client = new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
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

export default async function portchargeBillPdf(req, res) {
  const pool = getPool();
  const token = clean(req.query?.token);
  const doStamp = String(req.query?.stamp || "") === "1";
  const companyCode = (clean(req.query?.company) || "OCEANBABY").toUpperCase();
  if (!token) return res.status(400).json({ error: "token required" });

  let browser;
  try {
    // 盖章前先确认有章，避免白跑一趟 puppeteer
    let sealUrl = null;
    if (doStamp) {
      sealUrl = await resolveSealUrl(pool, companyCode);
      if (!sealUrl) return res.status(400).json({ error: "公章未录入DAS", detail: `${companyCode} 无 default+active 章，请先在 DAS 上传` });
    }

    browser = await puppeteer.launch({
      executablePath: "/usr/bin/google-chrome",
      headless: "new",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    const port = process.env.PORT || 9000;
    const url = `http://127.0.0.1:${port}/public/templates/invoice-collab-section.html?token=${encodeURIComponent(token)}&doc=bill`;
    await page.goto(url, { waitUntil: "networkidle0", timeout: 25000 });
    await page.waitForFunction(
      () => document.querySelector(".billgrid.ro tbody tr") || /err|错误|不可用/i.test(document.body.innerText),
      { timeout: 12000 }
    ).catch(() => {});
    const pdf = await page.pdf({
      format: "A4", printBackground: true, displayHeaderFooter: false,
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
    });
    await browser.close(); browser = null;

    const ts = Date.now();
    const base = `documents/portcharge-bill/${token.slice(0, 10)}_${ts}`;

    if (!doStamp) {
      const billUrl = await uploadToOSS(`${base}.pdf`, Buffer.from(pdf));
      return res.status(200).json({ ok: true, stamped: false, billUrl });
    }

    // 盖章：末页右下(br)压在 billseal（销售方 盖章）区
    const stampResp = await fetch(sealUrl);
    if (!stampResp.ok) throw new Error(`fetch seal ${stampResp.status}`);
    const stampBuf = await squareCropStamp(Buffer.from(await stampResp.arrayBuffer()));
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(pdf);
    const img = await doc.embedPng(stampBuf);
    const p = doc.getPage(doc.getPageCount() - 1);
    const { width: pw, height: ph } = p.getSize();
    const sW = Math.min(pw, ph) * 0.19;          // ≈40mm 标准公章(同 apply.js)
    const sH = sW * (img.height / img.width);
    const ox = 64, oy = 72;                        // 右下留白
    p.drawImage(img, { x: pw - sW - ox, y: oy, width: sW, height: sH, opacity: 0.85 });
    const outBuf = Buffer.from(await doc.save());
    const stampedUrl = await uploadToOSS(`${base}_stamped.pdf`, outBuf);
    try {
      await pool.query(
        "INSERT INTO stamp_log (document_id,document_name,stamp_key,operator,pages,position,scale,source_url,stamped_url,stamped_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())",
        [`portcharge:${token.slice(0, 10)}`, "港杂费账单明细", "portcharge:" + companyCode, "ai:port-charge", "last", "br", 0.19, url, stampedUrl]
      );
    } catch (_) {}
    return res.status(200).json({ ok: true, stamped: true, companyCode, stampedUrl });
  } catch (e) {
    console.error("[portcharge-bill-pdf]", e && e.message);
    return res.status(500).json({ error: "bill_pdf_failed", detail: e && e.message });
  } finally {
    if (browser) await browser.close();
  }
}
