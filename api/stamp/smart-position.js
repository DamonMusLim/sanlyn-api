// /api/stamp/smart-position.js
// v2 (PDF text keyword search) + v3 (Qwen-VL vision) stamp position detection
// Handles both generator URLs (/api/db/documents) and uploaded PDFs (OSS / external)
//
// POST { docId, pdfUrl, mode: "auto" | "v2" | "v3" }
// Response { x, y, page, source, confidence, visionRemaining }

import { getPool } from "../db.js";
const pool = getPool();

const VISION_QUOTA_PER_DOC = 2;

// ── Signature-block keywords (priority-ordered) ───────────────────────────────
const KEYWORDS_CN = [
  "授权签字", "授权代表", "签章", "盖章", "签字盖章", "加盖公章",
  "签名", "签字", "客户签字", "买方签字", "卖方签字",
];
const KEYWORDS_EN = [
  "Authorized Signatory", "Authorised Signatory", "Authorized Signature",
  "Signed by", "Signature", "Sign here", "For and on behalf of",
  "Company Stamp", "Company Seal", "Seal", "Stamp",
];

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ── Fetch PDF bytes for any URL source ────────────────────────────────────────
// For our own generator URLs, append &format=pdf and forward caller's Authorization.
async function fetchPdfBytes(pdfUrl, authHeader) {
  let url = pdfUrl;
  const isOurApi = /\/api\/db\/documents/.test(url);
  if (isOurApi && url.indexOf("format=") < 0) {
    url += (url.indexOf("?") >= 0 ? "&" : "?") + "format=pdf";
  }
  const headers = {};
  if (isOurApi && authHeader) headers["Authorization"] = authHeader;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Fetch PDF failed: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ── Vision quota helpers ──────────────────────────────────────────────────────
async function ensureQuotaTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stamp_vision_usage (
      doc_id       TEXT PRIMARY KEY,
      count        INT  NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ DEFAULT now(),
      last_user    TEXT
    )
  `);
}
async function getVisionUsed(docId) {
  await ensureQuotaTable();
  const r = await pool.query("SELECT count FROM stamp_vision_usage WHERE doc_id=$1", [docId]);
  return r.rows.length ? Number(r.rows[0].count) : 0;
}
async function incrVisionUsage(docId, user) {
  await pool.query(
    `INSERT INTO stamp_vision_usage(doc_id, count, last_user)
     VALUES ($1, 1, $2)
     ON CONFLICT (doc_id) DO UPDATE SET
       count = stamp_vision_usage.count + 1,
       last_used_at = now(),
       last_user = EXCLUDED.last_user`,
    [docId, user || null]
  );
}

// ── v2: keyword search via pdf-parse ──────────────────────────────────────────
// Returns { page: 1-based | -1 for last, x: 0-1, y: 0-1, source, confidence } or null.
async function detectByText(pdfBuffer) {
  let pdfParse;
  try {
    pdfParse = (await import("pdf-parse")).default;
  } catch (e) {
    throw new Error("pdf-parse not installed: " + e.message);
  }

  const data = await pdfParse(pdfBuffer);
  const totalPages = data.numpages || 1;
  const fullText = data.text || "";
  if (!fullText) return null;

  // Split by form feed / page-break marker pdf-parse inserts between pages.
  const pageTexts = fullText.split(/\f|\u000c/);
  // Search from last page backwards (signature usually sits on final page).
  const allKeywords = [...KEYWORDS_CN, ...KEYWORDS_EN];
  for (let pi = pageTexts.length - 1; pi >= 0; pi--) {
    const pt = pageTexts[pi] || "";
    for (const kw of allKeywords) {
      const idx = pt.toLowerCase().indexOf(kw.toLowerCase());
      if (idx < 0) continue;
      // We don't have glyph coordinates from pdf-parse, so approximate vertically by
      // the keyword's position in the page text (line index / total lines).
      const lines = pt.split(/\r?\n/);
      let lineIdx = 0, running = 0;
      for (let li = 0; li < lines.length; li++) {
        running += lines[li].length + 1;
        if (running >= idx) { lineIdx = li; break; }
      }
      const yFrac = Math.min(0.95, Math.max(0.15, (lineIdx + 0.5) / Math.max(1, lines.length)));
      // X: keep right-aligned — signature blocks are almost always bottom-right.
      const xFrac = 0.78;
      const pageNum = pi + 1; // 1-based
      return {
        page: pageNum === pageTexts.length ? -1 : pageNum, // -1 = last
        x: xFrac,
        y: yFrac,
        source: "pdf-text",
        confidence: 0.85,
        matchedKeyword: kw,
        totalPages,
      };
    }
  }
  return null;
}

// ── v3: vision via Qwen-VL (same model used for OCR templates) ────────────────
async function detectByVision(pdfBuffer) {
  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) throw new Error("QWEN_API_KEY not configured");

  // Render last page to PNG via puppeteer + data URI (no OSS round-trip)
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch (e) {
    throw new Error("puppeteer not installed: " + e.message);
  }

  const chromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";
  const launchOpts = {
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  };
  try {
    const fs = await import("fs");
    if (fs.existsSync(chromePath)) launchOpts.executablePath = chromePath;
  } catch (_) {}

  const browser = await puppeteer.launch(launchOpts);
  let pngBase64;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 1 });
    // Serve the PDF to Chrome via data: URI (no extra HTTP hop)
    const pdfDataUri = "data:application/pdf;base64," + pdfBuffer.toString("base64");
    await page.goto(pdfDataUri, { waitUntil: "networkidle0", timeout: 30000 });
    // Chrome's built-in PDF viewer may take a beat to render
    await new Promise((r) => setTimeout(r, 1500));
    const png = await page.screenshot({ type: "png", fullPage: false });
    pngBase64 = Buffer.from(png).toString("base64");
  } finally {
    await browser.close();
  }

  // Call Qwen-VL
  const prompt =
    "You are analyzing the last page of a business contract / invoice. " +
    "Identify the most appropriate location to place a red company seal (usually near a signature line, stamp box, or the bottom-right corner of the signature block). " +
    "Return ONLY a JSON object with this exact shape, no markdown, no commentary: " +
    '{"x": <0..1 from left>, "y": <0..1 from top>, "confidence": <0..1>}';

  const r = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-vl-max",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64," + pngBase64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  const data = await r.json();
  const raw = data.choices?.[0]?.message?.content || "";
  const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Vision response not parsable: " + raw.slice(0, 200));
  }
  const x = Math.max(0, Math.min(1, Number(parsed.x)));
  const y = Math.max(0, Math.min(1, Number(parsed.y)));
  const conf = Math.max(0, Math.min(1, Number(parsed.confidence) || 0.7));
  if (isNaN(x) || isNaN(y)) throw new Error("Vision returned invalid coordinates");

  return { page: -1, x, y, source: "vision", confidence: conf };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { docId, pdfUrl, mode = "auto", operator } = req.body || {};
    if (!docId) return res.status(400).json({ error: "docId required" });
    if (!pdfUrl) return res.status(400).json({ error: "pdfUrl required" });

    const authHeader = req.headers.authorization || "";
    const pdfBuffer = await fetchPdfBytes(pdfUrl, authHeader);

    const used = await getVisionUsed(docId);
    const remaining = Math.max(0, VISION_QUOTA_PER_DOC - used);

    // v2 path
    if (mode === "v2" || mode === "auto") {
      try {
        const v2 = await detectByText(pdfBuffer);
        if (v2) {
          return res.status(200).json({
            ...v2,
            visionUsed: used,
            visionRemaining: remaining,
            visionLimit: VISION_QUOTA_PER_DOC,
          });
        }
        if (mode === "v2") {
          return res.status(200).json({
            source: "none",
            x: null,
            y: null,
            confidence: 0,
            message: "No signature-block keywords found in PDF text",
            visionUsed: used,
            visionRemaining: remaining,
            visionLimit: VISION_QUOTA_PER_DOC,
          });
        }
      } catch (e) {
        if (mode === "v2") {
          return res.status(500).json({ error: "v2_failed", detail: e.message });
        }
        // auto mode: fall through to v3
      }
    }

    // v3 path — explicit or auto-fallback
    if (mode === "v3" || mode === "auto") {
      if (remaining <= 0) {
        return res.status(429).json({
          error: "vision_quota_exceeded",
          visionUsed: used,
          visionRemaining: 0,
          visionLimit: VISION_QUOTA_PER_DOC,
          message: `AI locate used up (${used}/${VISION_QUOTA_PER_DOC}) for this document`,
        });
      }
      try {
        const v3 = await detectByVision(pdfBuffer);
        await incrVisionUsage(docId, operator);
        const newUsed = used + 1;
        return res.status(200).json({
          ...v3,
          visionUsed: newUsed,
          visionRemaining: Math.max(0, VISION_QUOTA_PER_DOC - newUsed),
          visionLimit: VISION_QUOTA_PER_DOC,
        });
      } catch (e) {
        return res.status(503).json({
          error: "vision_unavailable",
          detail: e.message,
          visionUsed: used,
          visionRemaining: remaining,
          visionLimit: VISION_QUOTA_PER_DOC,
        });
      }
    }

    return res.status(400).json({ error: "unknown_mode", mode });
  } catch (err) {
    console.error("[smart-position] error:", err);
    return res.status(500).json({ error: "internal", detail: err.message });
  }
}
