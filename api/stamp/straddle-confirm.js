// api/stamp/straddle-confirm.js
// POST { pdfUrl, companyCode, operator, documentId, documentName, gaps, signature }
// Generates final PDF only after the caller confirms preview coordinates.

import { getPool, setCors } from '../db.js';
import {
  DEFAULT_OPACITY,
  SEAL_DIAMETER_PT,
  calcCustomPosition,
  clamp01,
  enforceStampPermission,
  fetchPdfBytes,
  fetchStampBytes,
  resolvePageIndex,
  resolveStampUrl,
  safeOriginalName,
  stampKeyForCompany,
  uploadToOSS,
} from './_straddle-shared.js';

async function logStampAction(pool, params) {
  const sql = `
    INSERT INTO stamp_log
      (document_id, document_name, stamp_key, operator, pages, position, scale,
       source_url, stamped_url, stamped_at, risk_notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
    RETURNING id
  `;
  const res = await pool.query(sql, [
    params.documentId,
    params.documentName || null,
    params.stampKey,
    params.operator,
    params.pages,
    'straddle',
    1,
    params.sourceUrl,
    params.stampedUrl,
    JSON.stringify({ gaps: params.gaps, signature: params.signature }),
  ]);
  return res.rows[0]?.id;
}

function normalizeGaps(gaps, totalPages) {
  if (!Array.isArray(gaps)) return [];
  return gaps
    .map(g => ({ pageIndex: Number(g.pageIndex), y: Number(g.y) }))
    .filter(g => Number.isInteger(g.pageIndex) && g.pageIndex >= 0 && g.pageIndex < totalPages - 1 && Number.isFinite(g.y))
    .map(g => ({ pageIndex: g.pageIndex, y: clamp01(g.y) }));
}

function normalizeSignature(signature, totalPages) {
  if (!signature || typeof signature !== 'object') return null;
  const x = Number(signature.x);
  const y = Number(signature.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { page: resolvePageIndex(signature.page, totalPages), x: clamp01(x), y: clamp01(y) };
}

function embedStamp(pdfDoc, stampBuffer) {
  return pdfDoc.embedPng(stampBuffer).catch(async () => pdfDoc.embedJpg(stampBuffer));
}

export default async function handler(req, res) {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { pdfUrl, companyCode, operator, documentId, documentName } = req.body || {};
    if (!pdfUrl) return res.status(400).json({ error: 'pdfUrl required' });
    if (!companyCode) return res.status(400).json({ error: 'companyCode required' });
    if (!operator) return res.status(400).json({ error: 'operator required' });

    const pool = getPool();
    const stampKey = stampKeyForCompany(companyCode);
    await enforceStampPermission(req, pool, operator, stampKey);

    const sealUrl = await resolveStampUrl(pool, null, companyCode);
    if (!sealUrl) {
      return res.status(400).json({ error: '公章未录入 DAS', detail: `${companyCode} 的默认有效公章不存在或 URL 域名不可信。` });
    }

    const authHeader = req.headers.authorization || '';
    const [pdfBuffer, stampBuffer] = await Promise.all([
      fetchPdfBytes(pdfUrl, authHeader),
      fetchStampBytes(sealUrl),
    ]);

    const { PDFDocument } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages();
    const gaps = normalizeGaps(req.body?.gaps, totalPages);
    const signature = normalizeSignature(req.body?.signature, totalPages);

    if (!gaps.length && !signature) {
      return res.status(400).json({ error: 'No confirmed stamp positions', detail: 'gaps 或 signature 至少提供一项。' });
    }

    const stampImage = await embedStamp(pdfDoc, stampBuffer);
    const sW = SEAL_DIAMETER_PT;
    const sH = SEAL_DIAMETER_PT;

    for (const gap of gaps) {
      const leftPage = pages[gap.pageIndex];
      const rightPage = pages[gap.pageIndex + 1];
      const { width: leftW, height: leftH } = leftPage.getSize();
      const { height: rightH } = rightPage.getSize();

      const leftY = leftH * (1 - gap.y) - sH / 2;
      const rightY = rightH * (1 - gap.y) - sH / 2;

      leftPage.drawImage(stampImage, {
        x: leftW - sW / 2,
        y: leftY,
        width: sW,
        height: sH,
        opacity: DEFAULT_OPACITY,
      });
      rightPage.drawImage(stampImage, {
        x: -sW / 2,
        y: rightY,
        width: sW,
        height: sH,
        opacity: DEFAULT_OPACITY,
      });
    }

    if (signature) {
      const page = pages[signature.page];
      const { width: pageW, height: pageH } = page.getSize();
      const pos = calcCustomPosition(signature.x, signature.y, pageW, pageH, sW, sH);
      page.drawImage(stampImage, {
        x: pos.x,
        y: pos.y,
        width: sW,
        height: sH,
        opacity: DEFAULT_OPACITY,
      });
    }

    const stampedBytes = await pdfDoc.save();
    const timestamp = Date.now();
    const originalName = safeOriginalName(pdfUrl, documentId);
    const stampedOssPath = `documents/straddle-stamped/${originalName}_straddle_${timestamp}.pdf`;
    const stampedUrl = await uploadToOSS(stampedOssPath, Buffer.from(stampedBytes));

    let logId = null;
    try {
      logId = await logStampAction(pool, {
        documentId,
        documentName,
        stampKey,
        operator,
        pages: gaps.map(g => g.pageIndex + 1).join(',') || (signature ? String(signature.page + 1) : ''),
        sourceUrl: pdfUrl,
        stampedUrl,
        gaps,
        signature,
      });
    } catch (dbErr) {
      console.warn('stamp_log write failed (non-fatal):', dbErr.message);
    }

    return res.status(200).json({ success: true, stampedUrl, logId });
  } catch (err) {
    console.error('Straddle confirm API error:', err);
    const status = err.status || 500;
    if (err.code === 'NO_STAMP_PERMISSION') {
      return res.status(status).json({ error: '无签章权限', detail: err.message });
    }
    if (err.code === 'STAMP_DAILY_LIMIT') {
      return res.status(status).json({ error: '今日签章次数已达上限', detail: err.message });
    }
    return res.status(status).json({ error: err.message });
  }
}
