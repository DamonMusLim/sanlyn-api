// api/stamp/straddle-confirm.js
// POST { pdfUrl, companyCode, operator, documentId, documentName, gaps, signature }
// Generates final PDF only after the caller confirms preview coordinates.

import { getPool, setCors } from '../db.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import {
  DEFAULT_OPACITY,
  SEAL_DIAMETER_PT,
  SIGNATURE_ASPECT,
  calcCustomPosition,
  clamp01,
  enforceStampPermission,
  fetchPdfBytes,
  fetchStampBytes,
  generateSignaturePng,
  randomSealRotationDeg,
  resolvePageIndex,
  resolveStampUrl,
  rotatedDrawParams,
  safeOriginalName,
  squareCropStamp,
  stampKeyForCompany,
  uploadToOSS,
} from './_straddle-shared.js';

const RENDER_DPI = 150;
const EXISTING_SIGNATURE_DENSITY_THRESHOLD = 0.15;

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
  for (const suffix of [`-${pageNum}.png`, `-${String(pageNum).padStart(2, '0')}.png`, `-${String(pageNum).padStart(3, '0')}.png`]) {
    const p = tmpBase + suffix;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function renderSourcePagePng(pdfBuffer, pageNum) {
  const base = path.join(os.tmpdir(), `straddle_confirm_${process.pid}_${Date.now()}_${pageNum}`);
  const pdfPath = base + '.pdf';
  fs.writeFileSync(pdfPath, pdfBuffer);
  try {
    await execFileP('pdftoppm', ['-png', '-r', String(RENDER_DPI), '-f', String(pageNum), '-l', String(pageNum), pdfPath, base]);
    const pngPath = pdftoppmOutputPath(base, pageNum);
    if (!pngPath) throw new Error('pdftoppm: output not found');
    return fs.readFileSync(pngPath);
  } finally {
    cleanup([pdfPath, pdftoppmOutputPath(base, pageNum)]);
  }
}

async function inspectExistingSignatureContent(pdfBuffer, signature, pageW, pageH, centerX, centerY, sidePt) {
  const sharp = (await import('sharp')).default;
  const pageNum = signature.page + 1;
  const pagePng = await renderSourcePagePng(pdfBuffer, pageNum);
  const meta = await sharp(pagePng).metadata();
  const scaleX = meta.width / pageW;
  const scaleY = meta.height / pageH;
  const sidePx = Math.max(1, Math.round(sidePt * Math.min(scaleX, scaleY)));
  const cxPx = Math.round(centerX * scaleX);
  const cyPx = Math.round((pageH - centerY) * scaleY);
  const left = Math.max(0, Math.min(meta.width - 1, Math.round(cxPx - sidePx / 2)));
  const top = Math.max(0, Math.min(meta.height - 1, Math.round(cyPx - sidePx / 2)));
  const width = Math.max(1, Math.min(sidePx, meta.width - left));
  const height = Math.max(1, Math.min(sidePx, meta.height - top));
  const { data, info } = await sharp(pagePng)
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let ink = 0;
  const total = info.width * info.height;
  for (let y = 0; y < info.height; y++) {
    const rowBase = y * info.width * info.channels;
    for (let x = 0; x < info.width; x++) {
      const i = rowBase + x * info.channels;
      const alpha = data[i + 3];
      if (alpha <= 20) continue;
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) ink++;
    }
  }

  return {
    page: pageNum,
    x: signature.x,
    y: signature.y,
    density: Number((ink / total).toFixed(4)),
    threshold: EXISTING_SIGNATURE_DENSITY_THRESHOLD,
  };
}

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
    JSON.stringify({
      gaps: params.gaps,
      signature: params.signature,
      rotationsUsed: params.rotationsUsed,
      signed: !!params.signature && !params.signatureSkipped,
      signatureSkipped: params.signatureSkipped || null,
      riskNotes: params.riskNotes || [],
    }),
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
    const [pdfBuffer, rawStampBuffer] = await Promise.all([
      fetchPdfBytes(pdfUrl, authHeader),
      fetchStampBytes(sealUrl),
    ]);
    // Source seal images are frequently not square (extra blank canvas below/around the circle) —
    // crop to the real ink bounding box and pad to square so the seal renders round, not oval.
    const stampBuffer = await squareCropStamp(rawStampBuffer);

    const { PDFDocument, degrees } = await import('pdf-lib');
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
    const rotationsUsed = [];
    const riskNotes = [];
    let signatureSkipped = null;

    for (const gap of gaps) {
      const leftPage = pages[gap.pageIndex];
      const rightPage = pages[gap.pageIndex + 1];
      const { width: leftW, height: leftH } = leftPage.getSize();
      const { height: rightH } = rightPage.getSize();

      // Same random angle for both halves of one gap — if the physical pages were folded back
      // together the two half-stamps still line up into a single tilted circle, like a real one.
      const angleDeg = randomSealRotationDeg();
      rotationsUsed.push({ pageIndex: gap.pageIndex, angleDeg: Number(angleDeg.toFixed(2)) });
      const leftCenter = { cx: leftW, cy: leftH * (1 - gap.y) };
      const rightCenter = { cx: 0, cy: rightH * (1 - gap.y) };
      const leftParams = rotatedDrawParams(leftCenter.cx, leftCenter.cy, sW, sH, angleDeg);
      const rightParams = rotatedDrawParams(rightCenter.cx, rightCenter.cy, sW, sH, angleDeg);

      leftPage.drawImage(stampImage, {
        x: leftParams.x, y: leftParams.y, width: sW, height: sH,
        opacity: DEFAULT_OPACITY, rotate: degrees(angleDeg),
      });
      rightPage.drawImage(stampImage, {
        x: rightParams.x, y: rightParams.y, width: sW, height: sH,
        opacity: DEFAULT_OPACITY, rotate: degrees(angleDeg),
      });
    }

    if (signature) {
      const page = pages[signature.page];
      const { width: pageW, height: pageH } = page.getSize();
      const pos = calcCustomPosition(signature.x, signature.y, pageW, pageH, sW, sH);
      const centerX = pos.x + sW / 2;
      const centerY = pos.y + sH / 2;
      try {
        const existing = await inspectExistingSignatureContent(pdfBuffer, signature, pageW, pageH, centerX, centerY, sW);
        if (existing.density >= EXISTING_SIGNATURE_DENSITY_THRESHOLD) {
          signatureSkipped = {
            reason: 'existing_stamp_detected',
            page: existing.page,
            x: existing.x,
            y: existing.y,
            density: existing.density,
            threshold: existing.threshold,
          };
          riskNotes.push(signatureSkipped);
        }
      } catch (inspectErr) {
        console.warn('signature existing-content inspection failed, stamping anyway:', inspectErr.message);
      }

      if (!signatureSkipped) {
        // Draw the auto-generated "Damon 林" signature first, overlapping partly under the seal —
        // matches how a real signed-and-stamped document looks (sign the line, then stamp over it).
        // Font rendering (sharp+SVG+system fonts) is an environment dependency that can break
        // independently of everything else here — never let a signature failure 500 the whole
        // stamping request; just skip the signature and still stamp the seal (codex review finding).
        try {
          const sigBuffer = await generateSignaturePng();
          const sigImage = await pdfDoc.embedPng(sigBuffer);
          const sigW = sW * 1.6;
          const sigH = sigW * SIGNATURE_ASPECT;
          // Only the tail end of the signature should sit under the seal (real signed-then-stamped
          // documents overlap a little, not half the name). Actual overlap width here is ~0.32*sW
          // (~20% of the signature's own width) — the seal's left edge sits at centerX-0.5*sW and
          // the signature's right edge at centerX-0.18*sW; see project_straddle_seal_blueprint memory
          // if retuning this (codex review caught the comment previously understating this as 0.18*sW).
          page.drawImage(sigImage, {
            x: centerX - sW * 1.78,
            y: centerY - sigH / 2,
            width: sigW,
            height: sigH,
            opacity: 0.92,
          });
        } catch (sigErr) {
          console.warn('signature generation failed, stamping seal without it:', sigErr.message);
        }

        const angleDeg = randomSealRotationDeg();
        rotationsUsed.push({ page: signature.page, angleDeg: Number(angleDeg.toFixed(2)) });
        const sealParams = rotatedDrawParams(centerX, centerY, sW, sH, angleDeg);
        page.drawImage(stampImage, {
          x: sealParams.x, y: sealParams.y, width: sW, height: sH,
          opacity: DEFAULT_OPACITY, rotate: degrees(angleDeg),
        });
      }
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
        signatureSkipped,
        rotationsUsed,
        riskNotes,
      });
    } catch (dbErr) {
      console.warn('stamp_log write failed (non-fatal):', dbErr.message);
    }

    return res.status(200).json({ success: true, stampedUrl, logId, ...(signatureSkipped ? { signatureSkipped } : {}) });
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
