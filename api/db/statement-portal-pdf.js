// Customer statement → clean server-side PDF (no browser URL/date chrome).
// 2026-07-20 Damon: 下载版红框不可有字体(浏览器print会打印带token的URL页脚)。
// 走 puppeteer displayHeaderFooter:false → 无URL/日期/页码。token绑scope鉴权同data端点。
import puppeteer from "puppeteer-core";
import { getPool } from "./db.js";
import { clean } from "./statement-portal-helpers.js";
import { resolveCustomerScope } from "./statement-portal-data.js";

export default async function statementPortalPdf(req, res) {
  const pool = getPool();
  // 同一 scope 鉴权(magic token / customer JWT);无权直接 401,不启动浏览器
  const scope = await resolveCustomerScope(req, res, pool);
  if (!scope) return;

  const token = clean(req.query?.token);
  const lang = clean(req.query?.lang) || "en";
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: "/usr/bin/google-chrome",
      headless: "new",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    // 从本机拉自己的对账单页(客户端渲染),token走公有data端点;print=1隐藏交互工具
    const qs = token ? `token=${encodeURIComponent(token)}&` : "";
    const url = `http://127.0.0.1:9000/public/statement-portal.html?${qs}lang=${encodeURIComponent(lang)}&print=1`;
    await page.goto(url, { waitUntil: "networkidle0", timeout: 25000 });
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length > 0 || /no data|error/i.test(document.body.innerText),
      { timeout: 12000 }
    ).catch(() => {});
    await page.emulateMediaType("print");
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: false,               // ← 关键:无URL/日期/页码页脚
      margin: { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" },
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="statement.pdf"');
    res.setHeader("Cache-Control", "no-store");
    return res.end(Buffer.from(pdf));
  } catch (e) {
    console.error("[statement-portal-pdf]", e && e.message);
    return res.status(500).json({ error: "pdf_failed" });
  } finally {
    if (browser) await browser.close();
  }
}
