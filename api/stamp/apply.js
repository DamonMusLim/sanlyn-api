// api/stamp/apply.js
// Sanlyn OS — PDF 电子签章 API v2
// POST { pdfUrl, documentId, documentName?, stampKey?, pages?, position?, scale?, opacity?, operator }
// 返回 JSON: { success, stampedUrl, logId }

import { getPool } from '../db/_pool.js';

// ── 印章 OSS 路径映射 ──────────────────────────────
const STAMP_MAP = {
  babi:     'stamps/babi_seal.png',
  zhongsha: 'stamps/zhongsha_seal.png',
  shanling: 'stamps/shanling_seal.png',
};

const OSS_BASE = 'https://sanlyn-files.oss-cn-hongkong.aliyuncs.com';

// ── 权限校验 ────────────────────────────────────────
async function checkPermission(pool, operator, stampKey) {
  // superAdmin 跳过权限检查
  // 其他人必须在 stamp_permissions 表中有有效授权
  const sql = `
    SELECT id, permission_type, doc_types, max_per_day
    FROM stamp_permissions
    WHERE granted_to = $1
      AND stamp_key = $2
      AND is_active = true
      AND (valid_until IS NULL OR valid_until > NOW())
    LIMIT 1
  `;
  const res = await pool.query(sql, [operator, stampKey]);
  return res.rows[0] || null;
}

// ── 今日用量检查 ─────────────────────────────────────
async function getTodayUsage(pool, operator, stampKey) {
  const sql = `
    SELECT COUNT(*) AS cnt
    FROM stamp_log
    WHERE operator = $1
      AND stamp_key = $2
      AND stamped_at >= CURRENT_DATE
  `;
  const res = await pool.query(sql, [operator, stampKey]);
  return parseInt(res.rows[0]?.cnt || '0', 10);
}

// ── 签章记录写入 RDS ────────────────────────────────
async function logStampAction(pool, params) {
  const sql = `
    INSERT INTO stamp_log
      (document_id, document_name, stamp_key, operator, pages, position, scale, source_url, stamped_url, stamped_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    RETURNING id
  `;
  const res = await pool.query(sql, [
    params.documentId,
    params.documentName || null,
    params.stampKey,
    params.operator,
    params.pages,
    params.position,
    params.scale,
    params.sourceUrl,
    params.stampedUrl,
  ]);
  return res.rows[0]?.id;
}

// ── OSS 上传（复用已有的 oss-upload 逻辑）──────────
async function uploadToOSS(ossPath, buffer, contentType = 'application/pdf') {
  // 方案: 调用自身的 oss-upload API（内部调用）
  // 如果在同一 Vercel 项目中，可直接 import OSS SDK
  // 这里用 fetch 调自己的 oss-upload endpoint
  const FormData = (await import('formdata-node')).FormData;
  const { Blob } = await import('buffer');

  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: contentType }), ossPath.split('/').pop());
  fd.append('path', ossPath);

  const resp = await fetch('https://sanlyn-api.vercel.app/api/oss-upload', {
    method: 'POST',
    body: fd,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OSS upload failed: ${resp.status} ${err}`);
  }
  const result = await resp.json();
  return result.url || `${OSS_BASE}/${ossPath}`;
}

// ── 主处理函数 ──────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const {
      pdfUrl,
      documentId,
      documentName,
      stampKey = 'babi',
      pages = 'last',
      position = 'br',
      scale = 0.19,
      opacity = 0.85,
      operator,
      isSuperAdmin = false,
    } = req.body;

    if (!pdfUrl) {
      return res.status(400).json({ error: 'pdfUrl required' });
    }
    if (!operator) {
      return res.status(400).json({ error: 'operator required' });
    }

    const stampPath = STAMP_MAP[stampKey];
    if (!stampPath) {
      return res.status(400).json({
        error: `Unknown stamp: ${stampKey}. Valid: ${Object.keys(STAMP_MAP).join(', ')}`,
      });
    }

    // ── 0. 权限校验 ──
    const pool = getPool();

    if (!isSuperAdmin) {
      const perm = await checkPermission(pool, operator, stampKey);
      if (!perm) {
        return res.status(403).json({
          error: '无签章权限',
          detail: `用户 ${operator} 未被授权使用 ${stampKey} 印章`,
        });
      }

      // 每日用量检查
      const todayUsage = await getTodayUsage(pool, operator, stampKey);
      if (todayUsage >= perm.max_per_day) {
        return res.status(429).json({
          error: '今日签章次数已达上限',
          detail: `已使用 ${todayUsage}/${perm.max_per_day} 次`,
        });
      }
    }

    // ── 1. 获取源 PDF 和印章图片 ──
    const [pdfResp, stampResp] = await Promise.all([
      fetch(pdfUrl),
      fetch(`${OSS_BASE}/${stampPath}`),
    ]);

    if (!pdfResp.ok) throw new Error(`Failed to fetch PDF: ${pdfResp.status}`);
    if (!stampResp.ok) throw new Error(`Failed to fetch stamp: ${stampResp.status}`);

    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    const stampBuffer = Buffer.from(await stampResp.arrayBuffer());

    // ── 2. pdf-lib 签章 ──
    const { PDFDocument } = await import('pdf-lib');

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const stampImage = await pdfDoc.embedPng(stampBuffer);

    const totalPages = pdfDoc.getPageCount();
    const targetPages = parsePages(pages, totalPages);

    for (const pageIdx of targetPages) {
      const page = pdfDoc.getPage(pageIdx);
      const { width: pageW, height: pageH } = page.getSize();

      const stampAspect = stampImage.height / stampImage.width;
      let sW = pageW * scale;
      let sH = sW * stampAspect;
      if (sH > pageH * 0.4) {
        sH = pageH * 0.4;
        sW = sH / stampAspect;
      }

      const offsetX = 60, offsetY = 60;
      const pos = calcPosition(position, pageW, pageH, sW, sH, offsetX, offsetY);

      page.drawImage(stampImage, {
        x: pos.x,
        y: pos.y,
        width: sW,
        height: sH,
        opacity,
      });
    }

    const stampedBytes = await pdfDoc.save();

    // ── 3. 上传盖章后的 PDF 到 OSS ──
    const timestamp = Date.now();
    const originalName = pdfUrl.split('/').pop()?.replace('.pdf', '') || documentId || 'doc';
    const stampedOssPath = `documents/stamped/${originalName}_stamped_${timestamp}.pdf`;

    let stampedUrl;
    try {
      stampedUrl = await uploadToOSS(stampedOssPath, Buffer.from(stampedBytes));
    } catch (ossErr) {
      console.error('OSS upload failed, returning inline PDF:', ossErr.message);
      // 降级：OSS 上传失败时直接返回 PDF bytes
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="stamped_${originalName}.pdf"`);
      return res.status(200).send(Buffer.from(stampedBytes));
    }

    // ── 4. 记录签章日志 ──
    let logId = null;
    try {
      logId = await logStampAction(pool, {
        documentId,
        documentName,
        stampKey,
        operator,
        pages,
        position,
        scale,
        sourceUrl: pdfUrl,
        stampedUrl,
      });
    } catch (dbErr) {
      console.warn('stamp_log write failed (non-fatal):', dbErr.message);
    }

    // ── 5. 返回 JSON ──
    return res.status(200).json({
      success: true,
      stampedUrl,
      logId,
      pages: targetPages.map(i => i + 1),
      stampKey,
      position,
    });

  } catch (err) {
    console.error('Stamp API error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── 辅助函数 ──────────────────────────────────────

function parsePages(pagesStr, total) {
  if (pagesStr === 'all') return Array.from({ length: total }, (_, i) => i);
  if (pagesStr === 'last') return [total - 1];
  if (pagesStr === 'first') return [0];
  if (pagesStr === 'first_last') return total === 1 ? [0] : [0, total - 1];
  return pagesStr
    .split(',')
    .map(p => parseInt(p.trim()) - 1)
    .filter(i => i >= 0 && i < total);
}

function calcPosition(pos, pageW, pageH, sW, sH, ox, oy) {
  const map = {
    br: { x: pageW - sW - ox, y: oy },
    bl: { x: ox, y: oy },
    bc: { x: (pageW - sW) / 2, y: oy },
    tr: { x: pageW - sW - ox, y: pageH - sH - oy },
    tl: { x: ox, y: pageH - sH - oy },
    cr: { x: pageW - sW - ox, y: (pageH - sH) / 2 },
    cc: { x: (pageW - sW) / 2, y: (pageH - sH) / 2 },
  };
  return map[pos] || map.br;
}
