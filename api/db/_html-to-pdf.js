import puppeteer from "puppeteer";

export async function htmlToPdf(html) {
  let browser;
  try {
    // P0：每次请求启动一个 Chrome，简单可靠；finally 保证关闭。
    browser = await puppeteer.launch({
      executablePath: "/usr/bin/google-chrome",
      headless: "new",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 20000 });
    await page.emulateMediaType("print");
    const pdf = await page.pdf({
      format: "A4", printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" },
    });
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close();
  }
}
