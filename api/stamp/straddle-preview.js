// api/stamp/straddle-preview.js
// POST { pdfUrl, companyCode, operator, mode }
// Pure calculation endpoint: render thumbnails, locate straddle gaps, suggest signature seal position.

import { getPool, setCors } from '../db.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import {
  SEAL_DIAMETER_PT,
  clamp01,
  dataUrlJpeg,
  fetchPdfBytes,
  normalizeMode,
  resolveStampUrl,
  stampKeyForCompany,
} from './_straddle-shared.js';

const RENDER_DPI = 150;

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} failed: ${err.message}${stderr ? ' ' + String(stderr).slice(0, 300) : ''}`;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function cleanup(files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }
}

function pdftoppmOutputPath(tmpBase, pageNum) {
  for (const suffix of [`-${pageNum}.jpg`, `-${String(pageNum).padStart(2, '0')}.jpg`, `-${String(pageNum).padStart(3, '0')}.jpg`]) {
    const p = tmpBase + suffix;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function renderPage(pdfPath, pageNum) {
  const tmpBase = path.join(os.tmpdir(), `straddle_${process.pid}_${Date.now()}_${pageNum}`);
  await execFileP('pdftoppm', ['-jpeg', '-r', String(RENDER_DPI), '-f', String(pageNum), '-l', String(pageNum), pdfPath, tmpBase]);
  const jpgPath = pdftoppmOutputPath(tmpBase, pageNum);
  if (!jpgPath) throw new Error('pdftoppm: output not found');
  const bytes = fs.readFileSync(jpgPath);
  cleanup([jpgPath]);
  return bytes;
}

function parseTsv(tsvPath, pageSize) {
  const text = fs.readFileSync(tsvPath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const words = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const rawText = (cols[idx.text] || '').trim();
    const conf = Number(cols[idx.conf]);
    if (!rawText || !Number.isFinite(conf) || conf < 0) continue;
    const left = Number(cols[idx.left]);
    const top = Number(cols[idx.top]);
    const width = Number(cols[idx.width]);
    const height = Number(cols[idx.height]);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const x1 = left / RENDER_DPI * 72;
    const x2 = (left + width) / RENDER_DPI * 72;
    const y1 = clamp01((top / RENDER_DPI * 72) / pageSize.height);
    const y2 = clamp01(((top + height) / RENDER_DPI * 72) / pageSize.height);
    words.push({ text: rawText, x1, x2, y1: Math.min(y1, y2), y2: Math.max(y1, y2), conf });
  }
  return words;
}

async function tesseractWords(imgBytes, pageSize, pageNum) {
  const base = path.join(os.tmpdir(), `straddle_ocr_${process.pid}_${Date.now()}_${pageNum}`);
  const imgPath = base + '.jpg';
  const tsvPath = base + '.tsv';
  fs.writeFileSync(imgPath, imgBytes);
  try {
    await execFileP('tesseract', [imgPath, base, '--psm', '6', '-l', 'chi_sim+eng', 'tsv']);
    return parseTsv(tsvPath, pageSize);
  } finally {
    cleanup([imgPath, tsvPath]);
  }
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .map(([a, b]) => [clamp01(Math.min(a, b)), clamp01(Math.max(a, b))])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (!last || it[0] > last[1]) out.push(it);
    else last[1] = Math.max(last[1], it[1]);
  }
  return out;
}

function findGapForPair(pageIndex, pageSizes, wordsByPage) {
  const page = pageSizes[pageIndex];
  const next = pageSizes[pageIndex + 1];
  const radiusFrac = (SEAL_DIAMETER_PT / 2) / page.height;
  const safety = radiusFrac + 0.02;
  const lower = 0.05 + safety;
  const upper = 0.95 - safety;
  if (upper <= lower) {
    return { pageIndex, needsManual: true, reason: '页面高度不足' };
  }

  const intervals = [];
  for (const pi of [pageIndex, pageIndex + 1]) {
    const size = pi === pageIndex ? page : next;
    const corridorXMin = size.width * 0.85;
    for (const w of wordsByPage[pi] || []) {
      if (w.x2 < corridorXMin || w.x1 > size.width) continue;
      intervals.push([w.y1 - safety, w.y2 + safety]);
    }
  }

  const blocked = mergeIntervals(intervals);
  let cursor = lower;
  let best = null;
  for (const [a, b] of blocked) {
    const start = Math.max(cursor, lower);
    const end = Math.min(a, upper);
    if (end > start && (!best || end - start > best.width)) best = { start, end, width: end - start };
    cursor = Math.max(cursor, b);
  }
  if (upper > cursor && (!best || upper - cursor > best.width)) best = { start: cursor, end: upper, width: upper - cursor };

  const minWidth = safety * 2;
  if (!best || best.width < minWidth) {
    return { pageIndex, needsManual: true, reason: '空档不足' };
  }
  return {
    pageIndex,
    y: Number(((best.start + best.end) / 2).toFixed(4)),
    confidence: Number(Math.min(1, best.width / minWidth).toFixed(2)),
  };
}

const SIGNATURE_PROMPT =
  '你正在分析一页商务文件。请找最适合放置红色公司公章的位置，通常在签名线、公司名、盖章框、落款或页面右下方签署区域附近。' +
  '只返回 valid JSON，不要 markdown，不要解释，格式必须是 {"x":0到1从左到右,"y":0到1从上到下,"confidence":0到1}。' +
  '如果没有明确签署区，也请选择最合理的右下落款区域并降低 confidence。';

async function detectSignatureByMiniMax(imgBytes) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error('MINIMAX_API_KEY not set');
  const b64 = imgBytes.toString('base64');
  const resp = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      max_tokens: 512,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: SIGNATURE_PROMPT },
      ] }],
    }),
  });
  if (!resp.ok) throw new Error('MiniMax HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const j = await resp.json();
  const txt = (j.content || []).map(c => c.text || '').join('').trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in MiniMax reply: ' + txt.slice(0, 200));
  const parsed = JSON.parse(m[0]);
  return {
    page: -1,
    x: Number(clamp01(Number(parsed.x)).toFixed(4)),
    y: Number(clamp01(Number(parsed.y)).toFixed(4)),
    confidence: Number(clamp01(Number(parsed.confidence)).toFixed(2)),
    source: 'minimax-vision',
  };
}

export default async function handler(req, res) {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const tmpPdf = path.join(os.tmpdir(), `straddle_preview_${process.pid}_${Date.now()}.pdf`);
  try {
    const { pdfUrl, companyCode, operator } = req.body || {};
    const mode = normalizeMode(req.body?.mode);
    if (!pdfUrl) return res.status(400).json({ error: 'pdfUrl required' });
    if (!companyCode) return res.status(400).json({ error: 'companyCode required' });
    if (!operator) return res.status(400).json({ error: 'operator required' });

    const pool = getPool();
    const sealUrl = await resolveStampUrl(pool, null, companyCode);
    if (!sealUrl) {
      return res.status(400).json({ error: '公章未录入 DAS', detail: `${companyCode} 的默认有效公章不存在或 URL 域名不可信。` });
    }

    const authHeader = req.headers.authorization || '';
    const pdfBuffer = await fetchPdfBytes(pdfUrl, authHeader);
    fs.writeFileSync(tmpPdf, pdfBuffer);

    const { PDFDocument } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages();
    const pageSizes = pages.map(p => p.getSize());

    const pageImages = [];
    const wordsByPage = [];
    for (let i = 0; i < totalPages; i++) {
      const img = await renderPage(tmpPdf, i + 1);
      pageImages.push(img);
      wordsByPage.push(mode === 'signature' ? [] : await tesseractWords(img, pageSizes[i], i + 1));
    }

    const gaps = [];
    if (mode === 'straddle' || mode === 'both') {
      for (let i = 0; i < totalPages - 1; i++) {
        gaps.push(findGapForPair(i, pageSizes, wordsByPage));
      }
    }

    let signature = null;
    if (mode === 'signature' || mode === 'both') {
      try {
        signature = await detectSignatureByMiniMax(pageImages[totalPages - 1]);
      } catch (e) {
        signature = { page: -1, needsManual: true, reason: e.message, source: 'minimax-vision' };
      }
    }

    const sealDiameterFrac = Number((SEAL_DIAMETER_PT / pageSizes[0].height).toFixed(4));
    return res.status(200).json({
      success: true,
      totalPages,
      pageThumbnails: pageImages.map(dataUrlJpeg),
      gaps,
      signature,
      sealDiameterFrac,
      stampKey: stampKeyForCompany(companyCode),
    });
  } catch (err) {
    console.error('Straddle preview API error:', err);
    return res.status(err.status || 500).json({ error: err.message });
  } finally {
    cleanup([tmpPdf]);
  }
}
