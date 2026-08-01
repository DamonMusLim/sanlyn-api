import { PDFDocument } from "pdf-lib";
import { getPool, setCors } from "../db.js";
import {
  SEAL_DIAMETER_PT,
  calcCustomPosition,
  checkStraddlePermission,
  embedStampImage,
  fetchPdfBytes,
  fetchStampBytes,
  uploadToOSS,
} from "./_shared.js";

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

async function logStampAction(pool, params) {
  const res = await pool.query(
    `INSERT INTO stamp_log
      (document_id, document_name, stamp_key, operator, pages, position, scale,
       source_url, stamped_url, stamped_at, risk_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10)
     RETURNING id`,
    [
      params.documentId,
      params.documentName || null,
      params.stampKey,
      params.operator,
      params.pages,
      "straddle",
      1,
      params.sourceUrl,
      params.stampedUrl,
      JSON.stringify({ gaps: params.gaps, signature: params.signature }),
    ]
  );
  return res.rows[0] && res.rows[0].id;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const {
      pdfUrl,
      companyCode,
      operator,
      documentId,
      documentName,
      gaps = [],
      signature = null,
    } = req.body || {};
    if (!pdfUrl) return res.status(400).json({ error: "pdfUrl required" });
    if (!companyCode) return res.status(400).json({ error: "companyCode required" });
    if (!operator) return res.status(400).json({ error: "operator required" });

    const pool = getPool();
    const stampKey = "straddle:" + companyCode;
    const allowed = await checkStraddlePermission(pool, req, operator, stampKey);
    if (!allowed) {
      return res.status(403).json({ error: "无骑缝章权限", detail: `用户 ${operator} 未被授权使用 ${stampKey}` });
    }

    const cleanGaps = Array.isArray(gaps) ? gaps.map((g) => ({
      pageIndex: Number(g.pageIndex),
      y: clamp01(g.y),
    })).filter((g) => Number.isInteger(g.pageIndex) && g.y != null) : [];
    if (!cleanGaps.length && !signature) {
      return res.status(400).json({ error: "gaps or signature required" });
    }

    const [pdfBuffer, stampData] = await Promise.all([
      fetchPdfBytes(pdfUrl, req.headers.authorization || ""),
      fetchStampBytes(pool, companyCode),
    ]);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const stampImage = await embedStampImage(pdfDoc, stampData.stampBuffer);
    const pageCount = pdfDoc.getPageCount();

    for (const gap of cleanGaps) {
      if (gap.pageIndex < 0 || gap.pageIndex >= pageCount - 1) continue;
      const leftPage = pdfDoc.getPage(gap.pageIndex);
      const rightPage = pdfDoc.getPage(gap.pageIndex + 1);
      const leftSize = leftPage.getSize();
      const rightSize = rightPage.getSize();
      const yLeft = leftSize.height * (1 - gap.y) - SEAL_DIAMETER_PT / 2;
      const yRight = rightSize.height * (1 - gap.y) - SEAL_DIAMETER_PT / 2;
      leftPage.drawImage(stampImage, {
        x: leftSize.width - SEAL_DIAMETER_PT / 2,
        y: yLeft,
        width: SEAL_DIAMETER_PT,
        height: SEAL_DIAMETER_PT,
        opacity: 0.85,
      });
      rightPage.drawImage(stampImage, {
        x: -SEAL_DIAMETER_PT / 2,
        y: yRight,
        width: SEAL_DIAMETER_PT,
        height: SEAL_DIAMETER_PT,
        opacity: 0.85,
      });
    }

    let cleanSignature = null;
    if (signature && signature.x != null && signature.y != null) {
      const pageIdx = signature.page === -1 || signature.page == null ? pageCount - 1 : Number(signature.page);
      const x = clamp01(signature.x);
      const y = clamp01(signature.y);
      if (Number.isInteger(pageIdx) && pageIdx >= 0 && pageIdx < pageCount && x != null && y != null) {
        const page = pdfDoc.getPage(pageIdx);
        const size = page.getSize();
        const pos = calcCustomPosition(x, y, size.width, size.height, SEAL_DIAMETER_PT, SEAL_DIAMETER_PT);
        page.drawImage(stampImage, {
          x: pos.x,
          y: pos.y,
          width: SEAL_DIAMETER_PT,
          height: SEAL_DIAMETER_PT,
          opacity: 0.85,
        });
        cleanSignature = { page: signature.page === -1 ? -1 : pageIdx, x, y };
      }
    }

    const stampedBytes = await pdfDoc.save();
    const timestamp = Date.now();
    const originalName = (String(pdfUrl).split("/").pop() || documentId || "doc").replace(/\.pdf(\?.*)?$/i, "");
    const stampedUrl = await uploadToOSS(`documents/straddle-stamped/${originalName}_straddle_${timestamp}.pdf`, Buffer.from(stampedBytes));

    let logId = null;
    try {
      logId = await logStampAction(pool, {
        documentId,
        documentName,
        stampKey,
        operator,
        pages: cleanGaps.map((g) => g.pageIndex + 1).join(","),
        sourceUrl: pdfUrl,
        stampedUrl,
        gaps: cleanGaps,
        signature: cleanSignature,
      });
    } catch (dbErr) {
      console.warn("stamp_log write failed (non-fatal):", dbErr.message);
    }

    return res.status(200).json({ success: true, stampedUrl, logId });
  } catch (err) {
    console.error("straddle-confirm error:", err);
    return res.status(err.status || 500).json({ error: err.message, detail: err.detail });
  }
}
