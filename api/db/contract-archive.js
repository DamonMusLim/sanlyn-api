// /api/db/contract-archive.js
// 通用合同/单据归档：把浏览器端拼好的合同 HTML（含已选公章图）渲染成 PDF、
// 存 OSS、写 stamp_log 留痕。给纯前端画章的模板（如 purchase-contract-template.html）用，
// 这类模板本来"打印/导出PDF"只是 window.print()，导出的文件只在用户本机，服务器完全没记录——
// 这个端点补上"导出即留痕"这一步，别的字段/排版都不碰。
import { getPool, setCors } from "../db.js";
import { htmlToPdf } from "./_html-to-pdf.js";
import { uploadToOSS } from "../stamp/_straddle-shared.js";

function safeSeg(s) {
  return String(s || "").replace(/[^\w一-龥.-]+/g, "_").slice(0, 40) || "doc";
}

// GET ?docType=purchase-contract&limit=50 — 历史列表，按导出时间倒序。
async function listHistory(req, res) {
  try {
    const pool = getPool();
    const docType = req.query.docType || "";
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const key = docType ? `contract:${safeSeg(docType)}` : null;
    const r = key
      ? await pool.query(
          `SELECT id, document_id, document_name, stamp_key, operator, stamped_url, stamped_at, risk_notes
             FROM stamp_log WHERE stamp_key = $1 ORDER BY stamped_at DESC LIMIT $2`,
          [key, limit]
        )
      : await pool.query(
          `SELECT id, document_id, document_name, stamp_key, operator, stamped_url, stamped_at, risk_notes
             FROM stamp_log WHERE stamp_key LIKE 'contract:%' ORDER BY stamped_at DESC LIMIT $1`,
          [limit]
        );
    const rows = r.rows.map((row) => {
      let meta = {};
      try { meta = JSON.parse(row.risk_notes || "{}"); } catch (e) {}
      return {
        id: row.id,
        docId: row.document_id,
        title: row.document_name,
        operator: row.operator,
        url: row.stamped_url,
        archivedAt: row.stamped_at,
        buyer: meta.buyer || "",
        seller: meta.seller || "",
        amount: meta.amount || "",
        contractDate: meta.contractDate || "",
      };
    });
    return res.status(200).json({ success: true, rows });
  } catch (e) {
    console.error("[contract-archive] list failed:", e);
    return res.status(500).json({ error: e.message });
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return listHistory(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  try {
    const { html, docTitle, docType, buyer, seller, amount, contractDate, operator } = req.body || {};
    if (!html) return res.status(400).json({ error: "html required" });

    const pdfBuffer = await htmlToPdf(html);
    const ts = Date.now();
    const ossPath = `documents/contract-archive/${safeSeg(docType || "contract")}/${ts}_${safeSeg(buyer)}-${safeSeg(seller)}.pdf`;
    const stampedUrl = await uploadToOSS(ossPath, pdfBuffer, "application/pdf");

    const pool = getPool();
    const docId = `CA-${ts}`;
    const r = await pool.query(
      `INSERT INTO stamp_log
         (document_id, document_name, stamp_key, operator, pages, position, scale, source_url, stamped_url, stamped_at, risk_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10)
       RETURNING id`,
      [
        docId,
        docTitle || "合同",
        `contract:${safeSeg(docType || "generic")}`,
        operator || "web",
        "1",
        "dual",
        1,
        "",
        stampedUrl,
        JSON.stringify({ buyer, seller, amount, contractDate, archivedFrom: "purchase-contract-template" }),
      ]
    );

    return res.status(200).json({ success: true, url: stampedUrl, logId: r.rows[0]?.id, docId });
  } catch (e) {
    console.error("[contract-archive] failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
