// api/db/portcharge-bill-pdf.js
// 港杂费账单(正版 fob_portcharge 模板)+ 盖卖方章 → 客户「盖章账单明细扫描件」。
// GET ?token=<magic>&stamp=1&company=OCEANBABY          → 模拟章(DAS pdf-lib·日常·免费)
// GET ?token=<magic>&sign=esign&company=OCEANBABY       → 正规电子签章(简道云E签宝·法律效力·gated)
// GET ?token=<magic>                                    → 素版(不盖)
// 正版模板 = shipping-plan-pdf.js type=fob_portcharge(PC-{BL}-{出单日}+集装箱明细+Terms+银行信息)。⚠️不自画。
// 盖章走 DAS 统一件:章图 resolveStampUrl(customer_stamps default+active)、overlay stampPdfBuffer、上传 uploadToOSS —— 全在 _straddle-shared,不再各自实现。
import crypto from "crypto";
import puppeteer from "puppeteer-core";
import { getPool } from "./db.js";
import { squareCropStamp, resolveStampUrl, stampPdfBuffer, uploadToOSS } from "../stamp/_straddle-shared.js";
import { signPdfViaEsign, esignConfigured } from "../stamp/esign-jiandaoyun.js";
import { clean } from "./statement-portal-helpers.js";
import shippingPlanPdf from "./shipping-plan-pdf.js";

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const PDF_MARGIN = { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" }; // 须与 htmlToPdf 一致,否则版式/坐标对不上
const MM = { top: 10, left: 8 };

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
  const signMode = clean(req.query?.sign);                 // 'esign'=正规电子签章
  const isEsign = signMode === "esign";
  const doStamp = !isEsign && String(req.query?.stamp || "") === "1"; // 模拟章
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

    // 正规签章前置校验(未配置直接报错,不白跑puppeteer)
    if (isEsign && !esignConfigured()) {
      return res.status(400).json({ error: "E签宝未配置", detail: "正规电子签章需法人办e签宝实名+印章授权+建简道云表单流程,并在.env填 JDY_*" });
    }
    // 模拟章:先确认有章
    let sealUrl = null;
    if (doStamp) {
      sealUrl = await resolveStampUrl(pool, null, companyCode);
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

    // ── 正规:E签宝电子签章(素版正版→简道云自动落章→拉回归档) ──
    if (isEsign) {
      const out = await signPdfViaEsign({ pdfBuffer: Buffer.from(basePdf), docName: `港杂费账单-${sid}`, companyCode });
      if (!out.ok) return res.status(out.configured ? 502 : 400).json({ error: out.error, dataId: out.dataId });
      let archived = out.signedUrl;
      try { const s = Buffer.from(await (await fetch(out.signedUrl)).arrayBuffer()); archived = await uploadToOSS(`${base}_esigned.pdf`, s); } catch (_) {}
      try {
        await pool.query(
          "INSERT INTO stamp_log (document_id,document_name,stamp_key,operator,pages,position,scale,source_url,stamped_url,stamped_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())",
          [`portcharge:${sid}`, "港杂费账单(fob_portcharge·E签宝)", "esign:" + companyCode, "ai:port-charge", "esign", "esign", 0, `shipping-plan-pdf?id=${sid}&type=fob_portcharge`, archived]
        );
      } catch (_) {}
      return res.status(200).json({ ok: true, mode: "esign", template: "fob_portcharge", stampedUrl: archived, esignSourceUrl: out.signedUrl, dataId: out.dataId, note: "E签宝电子签章(法律效力)" });
    }

    // ── 素版 ──
    if (!doStamp) {
      const billUrl = await uploadToOSS(`${base}.pdf`, Buffer.from(basePdf));
      return res.status(200).json({ ok: true, stamped: false, template: "fob_portcharge", billUrl });
    }

    // ── 模拟章(DAS 统一 overlay,章压 TOTAL PAYABLE 框右侧留白) ──
    const stampResp = await fetch(sealUrl);
    if (!stampResp.ok) throw new Error(`fetch seal ${stampResp.status}`);
    const stampBuf = await squareCropStamp(Buffer.from(await stampResp.arrayBuffer()));
    let coords = null;
    if (payBox) {
      // 量到 TOTAL PAYABLE 框(css px)→PDF点(0.75)+页边距;章压框右侧(¥金额在左)。sW≈40mm=113pt
      const f = 0.75, mL = MM.left * 72 / 25.4, mT = MM.top * 72 / 25.4, sW = 595 * 0.19, sH = sW;
      const cx = payBox.right - 96, cy = payBox.top + payBox.height / 2;
      coords = { x: (mL + cx * f) - sW / 2, y: /*A4高842*/ 842 - (mT + cy * f) - sH / 2 };
    }
    const outBuf = await stampPdfBuffer(basePdf, stampBuf, { pages: "last", coords, position: "br" });
    const stampedUrl = await uploadToOSS(`${base}_stamped.pdf`, outBuf);
    try {
      await pool.query(
        "INSERT INTO stamp_log (document_id,document_name,stamp_key,operator,pages,position,scale,source_url,stamped_url,stamped_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())",
        [`portcharge:${sid}`, "港杂费账单(fob_portcharge)", "portcharge:" + companyCode, "ai:port-charge", "last", "pay-box-right", 0.19, `shipping-plan-pdf?id=${sid}&type=fob_portcharge`, stampedUrl]
      );
    } catch (_) {}
    return res.status(200).json({ ok: true, stamped: true, mode: "simulate", template: "fob_portcharge", companyCode, stampedUrl });
  } catch (e) {
    console.error("[portcharge-bill-pdf]", e && e.message);
    return res.status(500).json({ error: "bill_pdf_failed", detail: e && e.message });
  } finally {
    if (browser) await browser.close();
  }
}
