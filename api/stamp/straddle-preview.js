import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { PDFDocument } from "pdf-lib";
import { setCors } from "../db.js";
import { fetchPdfBytes, SEAL_DIAMETER_PT } from "./_shared.js";

const execFileAsync = promisify(execFile);
const RENDER_DPI = 150;

function tmpName(prefix, ext = "") {
  return path.join(os.tmpdir(), prefix + "_" + process.pid + "_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ext);
}

async function renderPage(pdfPath, pageNum) {
  const base = tmpName("straddle_page");
  await execFileAsync("pdftoppm", ["-jpeg", "-r", String(RENDER_DPI), "-f", String(pageNum), "-l", String(pageNum), pdfPath, base]);
  for (const suffix of ["-1.jpg", "-01.jpg", "-001.jpg", `-${pageNum}.jpg`, `-${String(pageNum).padStart(2, "0")}.jpg`]) {
    const file = base + suffix;
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      fs.unlinkSync(file);
      return buf;
    }
  }
  throw new Error("pdftoppm output not found for page " + pageNum);
}

async function tesseractWords(imgBuffer) {
  const imgPath = tmpName("straddle_ocr", ".jpg");
  const outBase = tmpName("straddle_tsv");
  fs.writeFileSync(imgPath, imgBuffer);
  try {
    await execFileAsync("tesseract", [imgPath, outBase, "--psm", "6", "-l", "chi_sim+eng", "tsv"], { timeout: 60000 });
    const tsvPath = outBase + ".tsv";
    const tsv = fs.readFileSync(tsvPath, "utf8");
    fs.unlinkSync(tsvPath);
    return parseTsv(tsv);
  } finally {
    try { fs.unlinkSync(imgPath); } catch (_) {}
  }
}

function parseTsv(tsv) {
  const lines = String(tsv || "").trim().split(/\r?\n/);
  const header = (lines.shift() || "").split("\t");
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  return lines.map((line) => {
    const c = line.split("\t");
    const text = (c[idx.text] || "").trim();
    const conf = Number(c[idx.conf]);
    if (!text || conf < 15) return null;
    return {
      left: Number(c[idx.left]), top: Number(c[idx.top]),
      width: Number(c[idx.width]), height: Number(c[idx.height]),
    };
  }).filter(Boolean);
}

function wordIntervals(words, pageW, pageH) {
  const corridorXMin = pageW * 0.85;
  return words.map((w) => {
    const x1 = w.left / RENDER_DPI * 72;
    const x2 = (w.left + w.width) / RENDER_DPI * 72;
    if (x2 < corridorXMin) return null;
    const y1 = Math.max(0, Math.min(1, (w.top / RENDER_DPI * 72) / pageH));
    const y2 = Math.max(0, Math.min(1, ((w.top + w.height) / RENDER_DPI * 72) / pageH));
    return { start: Math.min(y1, y2), end: Math.max(y1, y2) };
  }).filter(Boolean).sort((a, b) => a.start - b.start);
}

function findGap(pageIndex, intervals, pageH) {
  const radius = (SEAL_DIAMETER_PT / 2) / pageH;
  const margin = radius + 0.02;
  const minWidth = margin * 2;
  let cursor = 0.05;
  let best = null;
  const candidates = intervals.concat([{ start: 0.95, end: 0.95 }]);
  for (const it of candidates) {
    const start = cursor;
    const end = Math.max(cursor, it.start);
    const width = end - start;
    if (width >= minWidth && (!best || width > best.width)) best = { start, end, width };
    cursor = Math.max(cursor, it.end);
  }
  if (!best) return { pageIndex, needsManual: true, reason: "空档不足" };
  return {
    pageIndex,
    y: +(best.start + best.width / 2).toFixed(4),
    confidence: +Math.max(0, Math.min(1, best.width / minWidth)).toFixed(2),
  };
}

async function detectSignature(imgBuffer) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return null;
  const prompt = 'Analyze this business PDF page. Find the best place for a red company seal near the signature, company name, stamp box, or bottom-right sign-off area. Return ONLY JSON: {"x":0-1,"y":0-1,"confidence":0-1}. Coordinates use top-left origin.';
  const resp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "MiniMax-M3", max_tokens: 512,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBuffer.toString("base64") } },
        { type: "text", text: prompt },
      ] }],
    }),
  });
  if (!resp.ok) throw new Error("MiniMax HTTP " + resp.status + ": " + (await resp.text()).slice(0, 200));
  const data = await resp.json();
  const text = (data.content || []).map((c) => c.text || "").join("").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in MiniMax reply");
  const j = JSON.parse(m[0]);
  return {
    page: -1,
    x: Math.max(0, Math.min(1, Number(j.x) || 0.75)),
    y: Math.max(0, Math.min(1, Number(j.y) || 0.72)),
    confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)),
    source: "minimax-vision",
  };
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const pdfPath = tmpName("straddle_src", ".pdf");
  try {
    const { pdfUrl, mode = "both" } = req.body || {};
    if (!pdfUrl) return res.status(400).json({ error: "pdfUrl required" });

    const pdfBuffer = await fetchPdfBytes(pdfUrl, req.headers.authorization || "");
    fs.writeFileSync(pdfPath, pdfBuffer);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages().map((p) => p.getSize());

    const pageThumbnails = [];
    const pageWords = [];
    for (let i = 0; i < totalPages; i++) {
      const jpg = await renderPage(pdfPath, i + 1);
      pageThumbnails.push("data:image/jpeg;base64," + jpg.toString("base64"));
      pageWords.push(mode === "signature" ? [] : await tesseractWords(jpg));
    }

    const gaps = [];
    if (mode !== "signature") {
      for (let i = 0; i < totalPages - 1; i++) {
        const intervals = wordIntervals(pageWords[i], pages[i].width, pages[i].height)
          .concat(wordIntervals(pageWords[i + 1], pages[i + 1].width, pages[i + 1].height))
          .sort((a, b) => a.start - b.start);
        gaps.push(findGap(i, intervals, pages[i].height));
      }
    }

    let signature = null;
    if (mode !== "straddle" && totalPages > 0) {
      try {
        const lastJpg = Buffer.from(pageThumbnails[totalPages - 1].replace(/^data:image\/jpeg;base64,/, ""), "base64");
        signature = await detectSignature(lastJpg);
      } catch (e) {
        signature = { page: -1, x: 0.75, y: 0.72, confidence: 0, source: "fallback", reason: e.message };
      }
    }

    return res.status(200).json({
      success: true,
      totalPages,
      pageThumbnails,
      gaps,
      signature,
      sealDiameterFrac: +(SEAL_DIAMETER_PT / (pages[0]?.height || 842)).toFixed(4),
    });
  } catch (err) {
    console.error("straddle-preview error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(pdfPath); } catch (_) {}
  }
}
