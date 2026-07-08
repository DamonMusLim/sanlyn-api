// ═══════════════════════════════════════════════════════════════
// export-pdf.js
// GET /api/db/export-pdf?type=pi&id=ORDER_ID
// GET /api/db/export-pdf?type=sc&id=ORDER_ID   (Sales Contract)
// GET /api/db/export-pdf?type=iv&id=ORDER_ID   (Invoice)
// GET /api/db/export-pdf?type=pl&id=ORDER_ID   (Packing List)
// GET /api/db/export-pdf?type=po&id=ORDER_ID   (Purchase Order)
// GET /api/db/export-pdf?type=pack&id=ORDER_ID&lang=en (SC+IV+PL pack)
// GET /api/db/export-pdf?type=shipping&id=SHIPMENT_ID
// GET /api/db/export-pdf?type=customs&contract=CONTRACT_NO (or &shipment=)
//
// Fetches the corresponding print-ready HTML from the existing
// internal document endpoints, then renders to PDF via Puppeteer.
// Returns: application/pdf
// ═══════════════════════════════════════════════════════════════
import puppeteer from "puppeteer";
import { setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ── Puppeteer browser singleton ───────────────────────────────
// Reuse one browser instance across requests for performance.
// On first error it will relaunch on the next request.
let _browser = null;
async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--single-process",
    ],
  });
  // Clean up on exit
  _browser.on("disconnected", () => { _browser = null; });
  return _browser;
}

// ── Document type metadata ─────────────────────────────────────
const DOC_TYPES = {
  pi:       { label: "PI",            internalPath: "/api/db/documents" },
  sc:       { label: "Sales-Contract",internalPath: "/api/db/documents" },
  iv:       { label: "Invoice",       internalPath: "/api/db/documents" },
  pl:       { label: "Packing-List",  internalPath: "/api/db/documents" },
  po:       { label: "PO",            internalPath: "/api/db/documents" },
  pack:     { label: "Doc-Pack",      internalPath: "/api/db/documents", directUrl: true },
  shipping: { label: "Shipping-Plan", internalPath: "/api/db/shipping-plan-pdf" },
  customs:  { label: "Customs-Doc",   internalPath: "/api/db/customs-doc-pdf" },
};

// ── Internal HTTP: fetch HTML from sibling endpoint ───────────
async function fetchHtml(internalPath, queryParams, authHeader) {
  const port = process.env.PORT || process.env.API_PORT || 9000;
  const qs   = new URLSearchParams(queryParams).toString();
  const url  = `http://127.0.0.1:${port}${internalPath}?${qs}`;
  const resp = await fetch(url, {
    headers: {
      authorization: authHeader || "",
      "x-internal":  "pdf-export",  // bypass CORS check on same-server calls
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw Object.assign(new Error(body || resp.statusText), { statusCode: resp.status });
  }
  return resp.text();
}

function buildInternalUrl(internalPath, queryParams) {
  const port = process.env.PORT || process.env.API_PORT || 9000;
  const qs   = new URLSearchParams(queryParams).toString();
  return `http://127.0.0.1:${port}${internalPath}?${qs}`;
}

function copyForwardedParams(req, docQuery) {
  for (const key of ["lang", "style", "audience", "mode", "customs", "page", "ids"]) {
    if (req.query[key] !== undefined && req.query[key] !== "") docQuery[key] = req.query[key];
  }
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).end("Method Not Allowed");
  if (!requireAuth(req, res))   return;

  const { type, id, contract, shipment } = req.query;
  const docMeta = type ? DOC_TYPES[type] : null;

  if (!docMeta) {
    return res.status(400).json({
      error: "type required: pi / sc / iv / pl / po / pack / shipping / customs",
    });
  }

  // Build query params for the internal document endpoint
  const docQuery = {};
  if (type === "customs") {
    if (!contract && !shipment) return res.status(400).json({ error: "contract or shipment required for customs PDF" });
    if (contract) docQuery.contract = contract;
    if (shipment) docQuery.shipment = shipment;
  } else {
    if (!id) return res.status(400).json({ error: "id required" });
    docQuery.type = type === "shipping" ? "confirm" : type;
    docQuery.id   = id;
    copyForwardedParams(req, docQuery);
  }

  const authHeader = req.headers.authorization || req.headers.Authorization || "";

  let html;
  if (!docMeta.directUrl) {
    try {
      html = await fetchHtml(docMeta.internalPath, docQuery, authHeader);
    } catch (err) {
      const code = err.statusCode || 500;
      return res.status(code).json({ error: "Document HTML generation failed: " + err.message });
    }
  }

  // Puppeteer → PDF
  let browser, page;
  try {
    browser = await getBrowser();
    page    = await browser.newPage();

    if (docMeta.directUrl) {
      const token = (authHeader || "").replace(/^Bearer\s+/i, "") || req.query.token || "";
      if (token && !docQuery.token) docQuery.token = token;
      await page.goto(buildInternalUrl(docMeta.internalPath, docQuery), { waitUntil: "networkidle0", timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 1800));
    } else {
      // Set content and wait for fonts / images to settle
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    }

    // Inject print-trigger styles already in the HTML; ensure @media print is respected
    await page.emulateMediaType("print");

    const pdf = await page.pdf({
      format:          "A4",
      printBackground: true,
      margin: { top: "14mm", right: "10mm", bottom: "14mm", left: "10mm" },
    });

    // Compose filename
    const ref      = id || contract || shipment || "doc";
    const dateStr  = new Date().toISOString().slice(0, 10);
    const filename = `Sanlyn-${docMeta.label}-${ref}-${dateStr}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdf.byteLength ?? pdf.length);
    res.end(pdf);

  } catch (err) {
    console.error("[export-pdf] Puppeteer error:", err.message);
    return res.status(500).json({ error: "PDF rendering failed: " + err.message });
  } finally {
    // Close the page but keep the browser alive for the next request
    if (page) page.close().catch(() => {});
  }
}
