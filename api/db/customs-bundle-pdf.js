// api/db/customs-bundle-pdf.js — 一次性报关: 报关单 + PL·SC·IV报关版 + 报检单(真商检单原件) 合成一份多页 PDF (按柜)
// 🚨报检那一页=工厂/报检行已报的**真商检单原件(图/PDF)直接拼进来**,不是系统重画的(Damon 2026-07-05铁律)。
// 顺序: ①报关单(横向,renderCustomsDeclaration) ②PL·SC·IV报关版(export-docs模版goto) ③真商检单原件(document_uploads)。
// parts 可选(decl,pack,inspect[,inbound]),默认前三。复用现成渲染器,不重造。
import { renderCustomsDeclaration, resolveOrdersForContainer } from "./customs-declaration-form.js";
import { renderInboundNotice } from "./inbound-notice.js";
import { checkContainerCoverage, checkAmountReconciliation, renderGateBanner } from "./customs-doc-quality-gate.js";
import OSS from "ali-oss";

function clean(v) { return String(v ?? "").trim(); }
function parseRaw(v) { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v); } catch (_) { return {}; } }
function ossClient() {
  return new OSS({
    region: process.env.OSS_REGION || "oss-cn-hongkong",
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || "sanlyn-files",
  });
}

async function loadPlan(pool, id) {
  const r = await pool.query(`SELECT * FROM shipping_plans WHERE _id::text=$1 OR id::text=$1 OR shipment_no=$1 OR bl_no=$1 LIMIT 1`, [String(id)]);
  return r.rows[0] || null;
}
function orderKeys(plan) {
  const raw = parseRaw(plan.raw);
  const xs = [].concat(Array.isArray(plan.order_nos) ? plan.order_nos : [])
    .concat(Array.isArray(plan.contract_nos) ? plan.contract_nos : [])
    .concat(Array.isArray(raw.orderNos) ? raw.orderNos : [])
    .concat(clean(plan.contract_no) ? [plan.contract_no] : []);
  const seen = new Set();
  return xs.map(clean).filter(x => { if (!x || seen.has(x)) return false; seen.add(x); return true; });
}
async function loadOrders(pool, plan) {
  const keys = orderKeys(plan);
  if (!keys.length) return [];
  const r = await pool.query(`SELECT id, order_no, contract_no FROM orders WHERE order_no=ANY($1::text[]) OR contract_no=ANY($1::text[]) OR _id::text=ANY($1::text[]) OR id::text=ANY($1::text[]) ORDER BY id`, [keys]);
  return r.rows;
}
async function loadOrdersByIds(pool, ids) {
  if (!ids.length) return [];
  const r = await pool.query(`SELECT id, order_no, contract_no FROM orders WHERE id=ANY($1::int[]) ORDER BY id`, [ids]);
  return r.rows;
}

// 找该柜订单已上传的**真商检单原件**(不重画)。每 doc_id 取最新一份。
// 🚨只按订单号(doc_id)匹配,不按 contract_no——CP-6/CP-7 共用合同号 CP26052851,
// 按合同匹配会把别柜的商检也拉进来(同分票柜号碰撞坑)。doc_id=order_no,存的就是订单号。
async function loadInspectionUploads(pool, orders) {
  const nos = [...new Set(orders.flatMap(o => [o.order_no, String(o.order_no || "").replace(/^\d+-/, "")]).filter(Boolean))];
  if (!nos.length) return [];
  const r = await pool.query(
    `SELECT DISTINCT ON (doc_id) doc_id, url, name FROM document_uploads
      WHERE doc_type IN ('ciq_inspection','inspection','inspection_application','phyto_inspection_app','quarantine_report','商检','报检单')
        AND doc_id = ANY($1::text[])
      ORDER BY doc_id, uploaded_at DESC`, [nos]);
  return r.rows || [];
}
async function fetchDocBytes(url) {
  if (/^https?:\/\//i.test(url)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("fetch inspection doc HTTP " + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  const obj = await ossClient().get(String(url).replace(/^\/+/, ""));
  return obj.content;
}

const PLACEHOLDER_HTML = (label) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
.box{border:2px dashed #dc2626;border-radius:12px;padding:40px 48px;text-align:center;color:#334155}
.t{font-size:20px;font-weight:800;color:#dc2626;margin-bottom:10px}
.s{font-size:13px;line-height:1.8}
</style></head><body><div class="box"><div class="t">⚠ 报检单(商检单)未上传</div>
<div class="s">本柜 ${label} 未找到工厂/报检行已报的<b>出境货物检验检疫申请原件</b>。<br>报检必须用真单原件,不能用系统重画的。<br>请在报关文件里上传该柜的真商检单(图/PDF),再重新出全套。</div></div></body></html>`;

export async function renderCustomsBundle(pool, opts) {
  opts = opts || {};
  const shipmentId = opts.shipmentId;
  const containerNo = clean(opts.container_no);
  const token = opts.token || "";
  const apiBase = opts.apiBase || "https://api.sanlyn.cn";
  const partsWanted = (opts.parts && opts.parts.length) ? opts.parts : ["decl", "pack", "inspect"];

  const plan = await loadPlan(pool, shipmentId);
  if (!plan) return null;
  let orders = await loadOrders(pool, plan);
  if (containerNo) {
    const ids = await resolveOrdersForContainer(pool, plan, containerNo);
    orders = await loadOrdersByIds(pool, ids);
  }
  const orderNos = orders.map(o => o.order_no).filter(Boolean);
  const orderIds = orders.map(o => Number(o.id)).filter(Boolean);

  // 🚦 质量门禁(P0): 柜覆盖完整性 + 报关↔商检金额比对。查不到就标缺数据,不静默放行,也不阻断生成——
  // 用横幅把结果焊在 PDF 首页,谁都能看到"这份能不能正式用"。
  const coverage = await checkContainerCoverage(pool, plan, { requestedContainerNo: containerNo, coveredOrderIds: orderIds });
  const recon = await checkAmountReconciliation(pool, orderIds);
  const gateBannerHtml = renderGateBanner(coverage, recon);

  // 组件 HTML / URL
  const inHtml = partsWanted.includes("inbound") ? await renderInboundNotice(pool, shipmentId, {}) : null;
  const cdHtml = partsWanted.includes("decl") ? await renderCustomsDeclaration(pool, shipmentId, { container_no: containerNo }) : null;
  let packUrl = null;
  if (partsWanted.includes("pack") && orderNos.length) {
    packUrl = apiBase + "/templates/export-docs-template.html?order_no=" + encodeURIComponent(orderNos[0])
      + "&ids=" + encodeURIComponent(orderNos.join(","))
      + (containerNo ? "&container_no=" + encodeURIComponent(containerNo) : "")
      + "&token=" + encodeURIComponent(token);
  }
  // 报检: 真商检单原件(不重画)
  let inspDocs = [];
  if (partsWanted.includes("inspect")) inspDocs = await loadInspectionUploads(pool, orders);

  const puppeteer = (await import("puppeteer")).default;
  const { PDFDocument } = await import("pdf-lib");
  const chromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";
  const launch = { headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"] };
  try { const fs = await import("fs"); if (fs.existsSync(chromePath)) launch.executablePath = chromePath; } catch (_) {}

  const browser = await puppeteer.launch(launch);
  const rendered = []; // {kind:'pdfbuf', buf}
  const margin = { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" };
  try {
    const page = await browser.newPage();
    if (gateBannerHtml) {
      const bannerHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;font-family:sans-serif">
        <div style="font-size:14px;font-weight:800;margin-bottom:10px">报关全套质量门禁结果</div>
        ${gateBannerHtml}
        <div style="font-size:10px;color:#64748b;margin-top:10px">此页由系统自动生成,仅供内部核对;正式对外前请人工确认差异原因。</div>
      </body></html>`;
      await page.setContent(bannerHtml, { waitUntil: "load", timeout: 20000 });
      await page.emulateMediaType("print");
      rendered.push({ slot: "gate_banner", buf: await page.pdf({ format: "A4", printBackground: true, margin }) });
    }
    if (inHtml) { await page.setContent(inHtml, { waitUntil: "load", timeout: 30000 }); await page.emulateMediaType("print"); rendered.push({ slot: "inbound", buf: await page.pdf({ format: "A4", printBackground: true, margin }) }); }
    if (cdHtml) { await page.setContent(cdHtml, { waitUntil: "load", timeout: 30000 }); await page.emulateMediaType("print"); rendered.push({ slot: "decl", buf: await page.pdf({ format: "A4", landscape: true, printBackground: true, margin }) }); }
    if (packUrl) { await page.goto(packUrl, { waitUntil: "networkidle0", timeout: 60000 }); await new Promise(r => setTimeout(r, 2000)); await page.emulateMediaType("print"); rendered.push({ slot: "pack", buf: await page.pdf({ format: "A4", printBackground: true, margin }) }); }
    // 报检没有真单 → 出占位页(提示上传真单)
    if (partsWanted.includes("inspect") && !inspDocs.length) {
      await page.setContent(PLACEHOLDER_HTML(containerNo || clean(plan.bl_no) || ""), { waitUntil: "load", timeout: 20000 });
      await page.emulateMediaType("print");
      rendered.push({ slot: "inspect_missing", buf: await page.pdf({ format: "A4", printBackground: true, margin }) });
    }
  } finally { await browser.close(); }

  const merged = await PDFDocument.create();
  const addPdfBuf = async (buf) => { const src = await PDFDocument.load(buf); const pgs = await merged.copyPages(src, src.getPageIndices()); pgs.forEach(p => merged.addPage(p)); };

  // 顺序: inbound → decl → pack → (占位) 都在 rendered 里, 保持顺序
  for (const r of rendered) await addPdfBuf(r.buf);

  // 真商检单原件拼在最后(pdf 直接并页, 图片贴成A4页)
  let inspEmbedded = 0;
  for (const d of inspDocs) {
    try {
      const bytes = await fetchDocBytes(d.url);
      const isPdf = /\.pdf(\?|$)/i.test(d.url) || /\.pdf$/i.test(d.name || "");
      if (isPdf) { await addPdfBuf(bytes); inspEmbedded++; }
      else {
        const isPng = /\.png(\?|$)/i.test(d.url) || /\.png$/i.test(d.name || "");
        const img = isPng ? await merged.embedPng(bytes) : await merged.embedJpg(bytes);
        const A4 = [595.28, 841.89];
        const pg = merged.addPage(A4);
        const sc = Math.min((A4[0] - 24) / img.width, (A4[1] - 24) / img.height);
        const w = img.width * sc, h = img.height * sc;
        pg.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
        inspEmbedded++;
      }
    } catch (_) { /* 单份取不到就跳过,不整份挂 */ }
  }

  if (!merged.getPageCount()) return null;
  const out = Buffer.from(await merged.save());
  const nameKey = containerNo || clean(plan.bl_no) || clean(plan.shipment_no) || "bundle";
  const gateStatus = (!coverage.ok || recon.status === "blocked") ? "blocked" : (recon.status === "warning" ? "warning" : "pass");
  return {
    buffer: out, filename: "报关全套_" + nameKey + ".pdf", pages: merged.getPageCount(), inspection_docs: inspEmbedded,
    gate: { status: gateStatus, coverage, reconciliation: recon },
  };
}
