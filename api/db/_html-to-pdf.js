import puppeteer from "puppeteer-core";

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
    // 2026-08-08 修: 原来写死 format:"A4"(竖版)+自己的 margin, 把每个单据模板自己的 @page 设置
    //   (如报关单的 A4 landscape、报检单的 A4 8mm) 全覆盖掉 → 内容超出可打印宽度被裁掉右侧列
    //   (实例: 报检草稿"生产单位注册号"整列不见)。
    //   preferCSSPageSize:true 让模板的 @page{size/margin} 说了算; 模板没写才回退 A4。
    const _hasCssPage = /@page[^{]*\{[^}]*size\s*:/i.test(String(html || ""));
    const pdf = await page.pdf(Object.assign(
      { printBackground: true, preferCSSPageSize: true },
      _hasCssPage ? {} : { format: "A4", margin: { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" } }
    ));
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close();
  }
}
