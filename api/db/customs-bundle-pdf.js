// api/db/customs-bundle-pdf.js — 一次性报关: 报关单 + PL·SC·IV报关版 + 报检单 合成一份多页 PDF (按柜)
// 复用现成渲染器,不重造: renderCustomsDeclaration / export-docs 模版 / renderInspectionRequest。
// 顺序: ①报关单(横向) ②PL·SC·IV报关版(3页,puppeteer goto 客户端模版) ③报检单。
// parts 可选(decl,pack,inspect[,inbound]),默认三样。2026-07-05。
import { renderCustomsDeclaration, resolveOrdersForContainer } from "./customs-declaration-form.js";
import { renderInspectionRequest } from "./inspection-request-form.js";
import { renderInboundNotice } from "./inbound-notice.js";

function clean(v) { return String(v ?? "").trim(); }
function parseRaw(v) { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v); } catch (_) { return {}; } }

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
  const r = await pool.query(`SELECT id, order_no FROM orders WHERE order_no=ANY($1::text[]) OR contract_no=ANY($1::text[]) OR _id::text=ANY($1::text[]) OR id::text=ANY($1::text[]) ORDER BY id`, [keys]);
  return r.rows;
}
async function loadOrdersByIds(pool, ids) {
  if (!ids.length) return [];
  const r = await pool.query(`SELECT id, order_no FROM orders WHERE id=ANY($1::int[]) ORDER BY id`, [ids]);
  return r.rows;
}

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

  // 组件 HTML / URL
  const inHtml = partsWanted.includes("inbound") ? await renderInboundNotice(pool, shipmentId, {}) : null;
  const cdHtml = partsWanted.includes("decl") ? await renderCustomsDeclaration(pool, shipmentId, { container_no: containerNo }) : null;
  const irHtml = partsWanted.includes("inspect") ? await renderInspectionRequest(pool, shipmentId, { container_no: containerNo }) : null;
  let packUrl = null;
  if (partsWanted.includes("pack") && orderNos.length) {
    packUrl = apiBase + "/templates/export-docs-template.html?order_no=" + encodeURIComponent(orderNos[0])
      + "&ids=" + encodeURIComponent(orderNos.join(","))
      + (containerNo ? "&container_no=" + encodeURIComponent(containerNo) : "")
      + "&token=" + encodeURIComponent(token);
  }

  const puppeteer = (await import("puppeteer")).default;
  const { PDFDocument } = await import("pdf-lib");
  const chromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";
  const launch = { headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"] };
  try { const fs = await import("fs"); if (fs.existsSync(chromePath)) launch.executablePath = chromePath; } catch (_) {}

  const browser = await puppeteer.launch(launch);
  const buffers = [];
  const margin = { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" };
  try {
    const page = await browser.newPage();
    // ① 入货通知(可选,portrait)。静态HTML用 load(networkidle0 会空转超时)
    if (inHtml) { await page.setContent(inHtml, { waitUntil: "load", timeout: 30000 }); await page.emulateMediaType("print"); buffers.push(await page.pdf({ format: "A4", printBackground: true, margin })); }
    // ② 报关单(landscape)
    if (cdHtml) { await page.setContent(cdHtml, { waitUntil: "load", timeout: 30000 }); await page.emulateMediaType("print"); buffers.push(await page.pdf({ format: "A4", landscape: true, printBackground: true, margin })); }
    // ③ PL·SC·IV 报关版(客户端模版会 fetch 数据,用 networkidle0)
    if (packUrl) { await page.goto(packUrl, { waitUntil: "networkidle0", timeout: 60000 }); await new Promise(r => setTimeout(r, 2000)); await page.emulateMediaType("print"); buffers.push(await page.pdf({ format: "A4", printBackground: true, margin })); }
    // ④ 报检单(portrait)
    if (irHtml) { await page.setContent(irHtml, { waitUntil: "load", timeout: 30000 }); await page.emulateMediaType("print"); buffers.push(await page.pdf({ format: "A4", printBackground: true, margin })); }
  } finally { await browser.close(); }

  if (!buffers.length) return null;
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    const pgs = await merged.copyPages(src, src.getPageIndices());
    pgs.forEach(p => merged.addPage(p));
  }
  const out = Buffer.from(await merged.save());
  const nameKey = containerNo || clean(plan.bl_no) || clean(plan.shipment_no) || "bundle";
  return { buffer: out, filename: "报关全套_" + nameKey + ".pdf", pages: merged.getPageCount() };
}
