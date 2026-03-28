// api/stamp/apply.js
// Sanlyn OS — PDF 电子签章 API
// POST { pdfUrl, stampKey?, pages?, position?, scale?, opacity? }
// 或 multipart: pdf file + stamp config
//
// 依赖: 调用 Python stamp engine (通过 child_process 或 纯JS方案)
// 生产方案: 印章PNG存OSS, PDF从OSS读取, 盖章后写回OSS

import { getPool } from '../db/_pool.js';

// ── 印章 OSS 路径映射 ──────────────────────────────
const STAMP_MAP = {
  'babi':     'stamps/babi_seal.png',      // 厦门巴匕进出口有限公司
  'zhongsha': 'stamps/zhongsha_seal.png',  // 中砂
  'shanling': 'stamps/shanling_seal.png',  // 山凌
};

// ── 签章记录写入 RDS ────────────────────────────────
async function logStampAction(pool, { documentId, stampKey, operator, pages, position }) {
  const sql = `
    INSERT INTO stamp_log (document_id, stamp_key, operator, pages, position, stamped_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    RETURNING id
  `;
  const res = await pool.query(sql, [documentId, stampKey, operator, pages, position]);
  return res.rows[0]?.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const {
      pdfUrl,           // OSS URL of source PDF
      documentId,       // RDS document ID (for audit trail)
      stampKey = 'babi', // which company seal
      pages = 'last',   // all|last|first|first_last|1,3,5
      position = 'br',  // br|bl|bc|tr|cr|cc
      scale = 0.19,
      opacity = 0.85,
      operator,         // who is stamping (username)
    } = req.body;

    if (!pdfUrl) {
      return res.status(400).json({ error: 'pdfUrl required' });
    }

    const stampPath = STAMP_MAP[stampKey];
    if (!stampPath) {
      return res.status(400).json({ error: `Unknown stamp: ${stampKey}. Valid: ${Object.keys(STAMP_MAP).join(', ')}` });
    }

    // ── 1. 获取源PDF和印章图片 ──
    // 生产环境从OSS读取
    const OSS_BASE = `https://sanlyn-files.oss-cn-hongkong.aliyuncs.com`;
    const [pdfResp, stampResp] = await Promise.all([
      fetch(pdfUrl),
      fetch(`${OSS_BASE}/${stampPath}`)
    ]);

    if (!pdfResp.ok) throw new Error(`Failed to fetch PDF: ${pdfResp.status}`);
    if (!stampResp.ok) throw new Error(`Failed to fetch stamp: ${stampResp.status}`);

    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    const stampBuffer = Buffer.from(await stampResp.arrayBuffer());

    // ── 2. 调用签章引擎 ──
    // 方案A: 在 Vercel Serverless 中用 pdf-lib (纯JS, 无需Python)
    // 这里用 pdf-lib 实现，避免 Vercel 环境Python限制
    const { PDFDocument } = await import('pdf-lib');
    
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const stampImage = await pdfDoc.embedPng(stampBuffer);
    
    const totalPages = pdfDoc.getPageCount();
    const targetPages = parsePages(pages, totalPages);
    
    for (const pageIdx of targetPages) {
      const page = pdfDoc.getPage(pageIdx);
      const { width: pageW, height: pageH } = page.getSize();
      
      // 计算印章尺寸
      const stampAspect = stampImage.height / stampImage.width;
      let sW = pageW * scale;
      let sH = sW * stampAspect;
      if (sH > pageH * 0.4) {
        sH = pageH * 0.4;
        sW = sH / stampAspect;
      }
      
      // 计算位置
      const offsetX = 60, offsetY = 60;
      const pos = calcPosition(position, pageW, pageH, sW, sH, offsetX, offsetY);
      
      page.drawImage(stampImage, {
        x: pos.x,
        y: pos.y,
        width: sW,
        height: sH,
        opacity: opacity,
      });
    }
    
    const stampedBytes = await pdfDoc.save();

    // ── 3. 上传盖章后的PDF到OSS ──
    const stampedKey = pdfUrl.replace('.pdf', '_stamped.pdf').replace(OSS_BASE + '/', '');
    // TODO: 实际OSS上传逻辑 (通过 oss-upload API 或直接SDK)
    // const uploadResult = await uploadToOSS(stampedKey, Buffer.from(stampedBytes));

    // ── 4. 记录签章日志 ──
    try {
      const pool = getPool();
      await logStampAction(pool, { documentId, stampKey, operator, pages, position });
    } catch (dbErr) {
      console.warn('stamp_log write failed (non-fatal):', dbErr.message);
    }

    // ── 5. 返回结果 ──
    // 开发阶段直接返回PDF bytes; 生产返回OSS URL
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="stamped_${documentId || 'doc'}.pdf"`);
    return res.status(200).send(Buffer.from(stampedBytes));

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
  return pagesStr.split(',').map(p => parseInt(p.trim()) - 1).filter(i => i >= 0 && i < total);
}

function calcPosition(pos, pageW, pageH, sW, sH, ox, oy) {
  const map = {
    br: { x: pageW - sW - ox, y: oy },
    bl: { x: ox,               y: oy },
    bc: { x: (pageW - sW) / 2, y: oy },
    tr: { x: pageW - sW - ox,  y: pageH - sH - oy },
    tl: { x: ox,                y: pageH - sH - oy },
    cr: { x: pageW - sW - ox,  y: (pageH - sH) / 2 },
    cc: { x: (pageW - sW) / 2, y: (pageH - sH) / 2 },
  };
  return map[pos] || map.br;
}
