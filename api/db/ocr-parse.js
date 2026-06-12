// /api/db/ocr-parse.js
// POST { url, contractNo, docType }
// → calls LOCAL_OCR_URL or MiniMax VL fallback
// → returns { success, text, fields }
// Also updates the matching document_uploads row with extracted JSON in .note

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!requireAuth(req, res)) return;

  const { url, contractNo, docType = "cpo", uploadId, preExtracted } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });

  // ── Fast path: browser already ran local OCR (1080 Ti), just persist ──────
  if (preExtracted && typeof preExtracted === "object") {
    if (uploadId) {
      const pool = getPool();
      await pool.query(
        "UPDATE document_uploads SET note=$1 WHERE id=$2",
        [JSON.stringify({ ocr: true, source: "local_gpu", fields: preExtracted, extractedAt: new Date().toISOString() }), uploadId]
      );
    }
    return res.status(200).json({ success: true, fields: preExtracted, source: "local_gpu" });
  }

  try {
    let text = "", fields = {};

    // ── Try local PaddleOCR service first ──────────────────────────
    const localUrl = process.env.LOCAL_OCR_URL || "http://localhost:8899/ocr";
    let localOk = false;
    try {
      const localRes = await fetch(localUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(30000),
      });
      if (localRes.ok) {
        const j = await localRes.json();
        if (j.success) { text = j.text || ""; fields = j.fields || {}; localOk = true; }
      }
    } catch (e) {
      console.log("[ocr-parse] local OCR unavailable:", e.message, "— falling back to MiniMax");
    }

    // ── MiniMax VL fallback ─────────────────────────────────────────
    if (!localOk) {
      const mmKey = process.env.MINIMAX_API_KEY;
      if (!mmKey) return res.status(503).json({ error: "OCR service unavailable and no MINIMAX_API_KEY set" });

      // Download file → base64
      const fileRes = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!fileRes.ok) throw new Error("Cannot download file: " + fileRes.status);
      const buf = await fileRes.arrayBuffer();
      const b64 = Buffer.from(buf).toString("base64");
      const mime = fileRes.headers.get("content-type") || "application/pdf";

      const mmRes = await fetch("https://api.minimax.chat/v1/text/chatcompletion_pro", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + mmKey },
        body: JSON.stringify({
          model: "abab6.5s-chat",
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
              { type: "text", text: `Extract from this Purchase Order document and reply ONLY with a JSON object (no markdown):
{
  "po_no": "PO number",
  "buyer": "buyer company name",
  "order_date": "YYYY-MM-DD or empty",
  "delivery_date": "YYYY-MM-DD or empty",
  "total_amount": "numeric string or empty",
  "currency": "USD/CNY/etc",
  "items": [{"name":"...","qty":0,"unit_price":0,"amount":0}]
}` }
            ]
          }],
          tokens_to_generate: 1000,
        }),
      });
      const mmJ = await mmRes.json();
      const raw = mmJ?.choices?.[0]?.messages?.[0]?.text || mmJ?.reply || "";
      try {
        const cleaned = raw.replace(/```json\n?/g,"").replace(/```/g,"").trim();
        fields = JSON.parse(cleaned);
        text = raw;
      } catch { text = raw; fields = {}; }
    }

    // ── Persist to document_uploads.note ───────────────────────────
    if (uploadId) {
      const pool = getPool();
      await pool.query(
        "UPDATE document_uploads SET note=$1 WHERE id=$2",
        [JSON.stringify({ ocr: true, fields, extractedAt: new Date().toISOString() }), uploadId]
      );
    } else if (contractNo) {
      // Store as a separate "ocr result" record
      const pool = getPool();
      await pool.query(
        `INSERT INTO document_uploads(doc_id, doc_type, contract_no, url, name, note, uploader, uploaded_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT DO NOTHING`,
        [contractNo, docType + "_ocr", contractNo, url,
         "OCR result", JSON.stringify({ ocr: true, fields, extractedAt: new Date().toISOString() }),
         req.user?.email || "system"]
      );
    }

    return res.status(200).json({ success: true, text, fields });
  } catch (e) {
    console.error("[ocr-parse] error:", e);
    return res.status(500).json({ error: e.message });
  }
}
