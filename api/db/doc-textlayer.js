// api/db/doc-textlayer.js
// Ensure uploaded PDFs have searchable text without modifying originals.
import { getPool, setCors } from '../db.js';
import { requireAuth } from '../auth.js';
import OSS from 'ali-oss';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

const OSS_BASE = 'https://files.sanlynos.com';
const MAX_PAGES = 20;
const TEXT_PROMPT = '逐字输出这张图片里的所有文字，保持阅读顺序，不要解释';

function ossClient() {
  return new OSS({
    region: process.env.OSS_REGION || 'oss-cn-hongkong',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || 'sanlyn-files',
  });
}

function execFileP(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 30 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} failed: ${err.message}${stderr ? ' ' + String(stderr).slice(0, 400) : ''}`;
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

function textStats(text) {
  const s = String(text || '').trim();
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const alnum = (s.match(/[A-Za-z0-9]/g) || []).length;
  return { chars: s.length, cjk, alnum, effective: s.length >= 50 && (cjk >= 5 || alnum >= 20) };
}

function isPdf(doc) {
  return doc?.mime === 'application/pdf' || /\.pdf(\?|$)/i.test(String(doc?.url || ''));
}

function objKeyFromUrl(url) {
  try { return new URL(url).pathname.replace(/^\/+/, ''); } catch (_) {}
  return String(url || '').replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '');
}

async function uploadToOSS(ossPath, buffer, contentType = 'text/plain; charset=utf-8') {
  await ossClient().put(ossPath, Buffer.from(buffer), { mime: contentType });
  return `${OSS_BASE}/${ossPath}`;
}

async function downloadPdf(doc, tmpFiles) {
  const obj = await ossClient().get(objKeyFromUrl(doc.url));
  const tmpPdf = path.join(os.tmpdir(), `doc_textlayer_${process.pid}_${doc.id}_${Date.now()}.pdf`);
  fs.writeFileSync(tmpPdf, obj.content);
  tmpFiles.push(tmpPdf);
  return tmpPdf;
}

async function nativeText(pdfPath) {
  const { stdout } = await execFileP('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
  return String(stdout || '').trim();
}

function pageImagePath(base, pageNum) {
  for (const suffix of [`-${pageNum}.jpg`, `-${String(pageNum).padStart(2, '0')}.jpg`, `-${String(pageNum).padStart(3, '0')}.jpg`]) {
    const p = base + suffix;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function renderPage(pdfPath, pageNum, tmpFiles) {
  const base = path.join(os.tmpdir(), `doc_textlayer_${process.pid}_${Date.now()}_${pageNum}`);
  await execFileP('pdftoppm', ['-jpeg', '-r', '160', '-f', String(pageNum), '-l', String(pageNum), pdfPath, base]);
  const jpgPath = pageImagePath(base, pageNum);
  if (!jpgPath) return null;
  tmpFiles.push(jpgPath);
  return jpgPath;
}

async function renderPages(pdfPath, tmpFiles) {
  const images = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const img = await renderPage(pdfPath, page, tmpFiles);
    if (!img) break;
    images.push({ page, path: img });
  }
  let truncated = false;
  try {
    const img21 = await renderPage(pdfPath, MAX_PAGES + 1, tmpFiles);
    truncated = !!img21;
  } catch (_) {
    truncated = false;
  }
  return { images, truncated };
}

async function tesseractText(imgPath, pageNum, tmpFiles) {
  const base = path.join(os.tmpdir(), `doc_textlayer_tess_${process.pid}_${Date.now()}_${pageNum}`);
  const outPath = base + '.txt';
  tmpFiles.push(outPath);
  await execFileP('tesseract', [imgPath, base, '-l', 'chi_sim+eng', '--psm', '6']);
  return fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim() : '';
}

async function minimaxText(imgBytes) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error('MINIMAX_API_KEY not set');
  const resp = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgBytes.toString('base64') } },
        { type: 'text', text: TEXT_PROMPT },
      ] }],
    }),
  });
  if (!resp.ok) throw new Error('MiniMax HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const j = await resp.json();
  return (j.content || []).map(c => c.text || '').join('').trim();
}

async function buildOcrText(images) {
  const tmpFiles = [];
  const pageTexts = [];
  const errors = [];
  try {
    for (const img of images) {
      try {
        pageTexts.push({ page: img.page, text: await tesseractText(img.path, img.page, tmpFiles) });
      } catch (e) {
        errors.push({ page: img.page, engine: 'tesseract', error: e.message });
        pageTexts.push({ page: img.page, text: '' });
      }
    }
    const tessText = pageTexts.map(p => p.text).filter(Boolean).join('\n\n').trim();
    if (textStats(tessText).chars >= 50) return { source: 'ocr-tesseract', text: tessText, errors };

    const miniTexts = [];
    for (const img of images) {
      try {
        miniTexts.push({ page: img.page, text: await minimaxText(fs.readFileSync(img.path)) });
      } catch (e) {
        errors.push({ page: img.page, engine: 'minimax', error: e.message });
        miniTexts.push({ page: img.page, text: '' });
      }
    }
    return {
      source: 'ocr-minimax',
      text: miniTexts.map(p => p.text).filter(Boolean).join('\n\n').trim(),
      errors,
    };
  } finally {
    cleanup(tmpFiles);
  }
}

// Claude review fix (2026-07-31): do NOT write ocr_status — that column belongs to the
// customs-ocr/inspection-ocr pipelines which set 'done' and gate on it; stomping it breaks them.
// All textlayer state lives ONLY under ocr_raw.textlayer. Known pre-existing hazard: those two
// pipelines overwrite ocr_raw wholesale (no merge), which can wipe our key — acceptable because
// the batch query re-selects any doc whose ocr_raw->'textlayer' is NULL, so it self-heals.
async function saveTextlayer(pool, docId, status, layer) {
  await pool.query(
    `UPDATE document_uploads
        SET ocr_raw = COALESCE(ocr_raw, '{}'::jsonb) || jsonb_build_object('textlayer', $1::jsonb)
      WHERE id=$2`,
    [JSON.stringify(layer), docId]
  );
}

async function getDoc(pool, { doc_upload_id, doc_id }) {
  const q = doc_upload_id
    ? await pool.query('SELECT * FROM document_uploads WHERE id=$1 LIMIT 1', [doc_upload_id])
    : await pool.query('SELECT * FROM document_uploads WHERE doc_id=$1 ORDER BY uploaded_at DESC, id DESC LIMIT 1', [doc_id]);
  return q.rows[0] || null;
}

async function processDoc(pool, input = {}) {
  const doc = await getDoc(pool, input);
  if (!doc) return { success: false, error: 'document_upload not found', doc_upload_id: input.doc_upload_id || null };
  if (!input.refresh && doc.ocr_raw?.textlayer) {
    return { success: true, doc_upload_id: doc.id, skipped: 'exists', textlayer: doc.ocr_raw.textlayer };
  }

  const checkedAt = new Date().toISOString();
  if (!isPdf(doc)) {
    const layer = { status: 'not_pdf', source: null, text: '', pages: 0, chars: 0, checked_at: checkedAt };
    await saveTextlayer(pool, doc.id, 'not_pdf', layer);
    return { success: true, doc_upload_id: doc.id, skipped: 'not_pdf', textlayer: layer };
  }

  const tmpFiles = [];
  try {
    const pdfPath = await downloadPdf(doc, tmpFiles);
    const native = await nativeText(pdfPath);
    const nstats = textStats(native);
    let layer;

    if (nstats.effective) {
      layer = { status: 'native_text_ok', source: 'native', text: native, pages: null, chars: nstats.chars, checked_at: checkedAt };
    } else {
      const { images, truncated } = await renderPages(pdfPath, tmpFiles);
      if (!images.length) throw new Error('pdftoppm produced no pages');
      const ocr = await buildOcrText(images);
      const ostats = textStats(ocr.text);
      const ok = ostats.chars >= 50;
      layer = {
        status: ok ? 'ocr_ok' : 'ocr_failed',
        source: ocr.source,
        text: ok ? ocr.text : '',
        pages: images.length,
        chars: ok ? ostats.chars : 0,
        checked_at: checkedAt,
        errors: ocr.errors,
        truncated,
      };
      if (!ok) layer.error = 'OCR produced less than 50 characters';
    }

    if (layer.text) {
      layer.sidecar_url = await uploadToOSS(`documents/textlayer/${doc.id}.txt`, Buffer.from(layer.text, 'utf8'));
    }
    await saveTextlayer(pool, doc.id, layer.status, layer);
    return { success: true, doc_upload_id: doc.id, status: layer.status, source: layer.source, chars: layer.chars, textlayer: layer };
  } catch (e) {
    const layer = { status: 'ocr_failed', source: null, text: '', pages: 0, chars: 0, checked_at: checkedAt, error: e.message };
    await saveTextlayer(pool, doc.id, 'ocr_failed', layer).catch(() => {});
    return { success: false, doc_upload_id: doc.id, status: 'ocr_failed', error: e.message, textlayer: layer };
  } finally {
    cleanup(tmpFiles);
  }
}

async function runBatch(pool, n) {
  const limit = Number(n) || 1;
  if (limit < 1 || limit > 20) {
    const err = new Error('batch must be between 1 and 20');
    err.status = 400;
    throw err;
  }
  const q = await pool.query(
    `SELECT id
       FROM document_uploads
      WHERE (mime='application/pdf' OR url ILIKE '%.pdf')
        AND ocr_raw->'textlayer' IS NULL
      ORDER BY uploaded_at ASC NULLS FIRST, id ASC
      LIMIT $1`,
    [limit]
  );
  const results = [];
  for (const row of q.rows) results.push(await processDoc(pool, { doc_upload_id: row.id }));
  return { success: true, batch: q.rows.length, results };
}

async function getTextlayer(pool, docUploadId) {
  const q = await pool.query("SELECT ocr_raw->'textlayer' AS textlayer FROM document_uploads WHERE id=$1 LIMIT 1", [docUploadId]);
  if (!q.rows.length) return null;
  return q.rows[0].textlayer || null;
}

export default async function handler(req, res) {
  setCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const auth = requireAuth(req, res);
    if (auth === false || res.headersSent) return;
  } catch (e) {
    return res.status(e.status || 401).json({ success: false, error: e.message || 'unauthorized' });
  }

  const pool = getPool();
  try {
    if (req.method === 'GET') {
      const id = req.query?.doc_upload_id;
      if (!id) return res.status(400).json({ success: false, error: 'doc_upload_id required' });
      const textlayer = await getTextlayer(pool, id);
      if (!textlayer) return res.status(404).json({ success: false, error: 'textlayer not found' });
      return res.status(200).json({ success: true, doc_upload_id: id, textlayer });
    }
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'GET or POST only' });

    const body = req.body || {};
    if (body.batch != null) return res.status(200).json(await runBatch(pool, body.batch));
    if (!body.doc_upload_id && !body.doc_id) return res.status(400).json({ success: false, error: 'doc_upload_id, doc_id, or batch required' });
    return res.status(200).json(await processDoc(pool, body));
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, error: e.message });
  }
}
