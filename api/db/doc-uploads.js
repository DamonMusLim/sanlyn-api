// /api/db/doc-uploads.js
// Document feedback uploads — attach user-uploaded files (signed/annotated versions)
// to any generated document. Stores OSS URL + optional note (≤500 chars).
//
//   POST /api/db/doc-uploads
//     body: { docId, docType, contractNo, url, name, size, note }
//     -> { id, doc_id, ... }
//     Also fires a WeCom webhook notification (if WECOM_WEBHOOK_URL set).
//
//   GET  /api/db/doc-uploads?docId=...
//     -> { data: [...] }
//
//   GET  /api/db/doc-uploads?contractNo=FS...
//     -> { data: [...] }  (all uploads across any doc for that order)

import { getPool, setCors } from "../db.js";

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS document_uploads (
      id           SERIAL PRIMARY KEY,
      doc_id       TEXT NOT NULL,
      doc_type     TEXT,
      contract_no  TEXT,
      url          TEXT NOT NULL,
      name         TEXT,
      size         BIGINT,
      note         TEXT,
      uploader     TEXT,
      uploaded_at  TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_document_uploads_doc_id      ON document_uploads(doc_id);
    CREATE INDEX IF NOT EXISTS idx_document_uploads_contract_no ON document_uploads(contract_no);
  `);
}

// Fire-and-forget WeCom notification (doesn't block response)
async function notifyWecom(row) {
  const url = process.env.WECOM_WEBHOOK_URL;
  if (!url) return;
  try {
    const title = `📎 New document feedback — ${row.doc_type || "doc"} · ${row.contract_no || row.doc_id}`;
    const lines = [
      `**${title}**`,
      `Uploader: ${row.uploader || "unknown"}`,
      `File: ${row.name || "(unnamed)"}`,
      row.note ? `> ${row.note}` : "_(no note)_",
      `[View file](${row.url})`,
    ];
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content: lines.join("\n") },
      }),
    });
  } catch (e) {
    console.error("[doc-uploads] wecom notify failed:", e.message);
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const pool = getPool();
    await ensureTable(pool);

    if (req.method === "GET") {
      const { docId, contractNo, doc_type, limit = 500 } = req.query || {};
      // Watchtower fix (codex P1-2 2026-05-08): require docId or contractNo
      // for non-admin callers. Without a scope filter, this endpoint would
      // dump up to 500 rows of OSS URLs + uploader notes to any authenticated
      // user. Admins/internal may still batch-fetch unfiltered for ops dashboards.
      const _role = String((req.user && req.user.role) || "").toLowerCase();
      const _isAdmin = ["admin","internal","boss","finance","platform_admin","system"].includes(_role);
      if (!_isAdmin && !docId && !contractNo) {
        return res.status(400).json({ error: "docId or contractNo required" });
      }
      const conds = [], vals = [];
      if (docId)      { vals.push(docId);      conds.push("doc_id = $" + vals.length); }
      if (contractNo) { vals.push(contractNo); conds.push("contract_no = $" + vals.length); }
      if (doc_type)   { vals.push(doc_type);   conds.push("doc_type = $" + vals.length); }
      vals.push(Math.min(parseInt(limit) || 500, 1000));
      const whereClause = conds.length ? "WHERE " + conds.join(" AND ") : "";
      const r = await pool.query(
        `SELECT * FROM document_uploads ${whereClause} ORDER BY uploaded_at DESC LIMIT $${vals.length}`,
        vals
      );
      return res.status(200).json({ data: r.rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.docId) return res.status(400).json({ error: "docId required" });
      if (!b.url)   return res.status(400).json({ error: "url required" });
      const note = b.note ? String(b.note).slice(0, 500) : null;
      const uploader = b.uploader || req.user?.name || req.user?.email || null;
      const r = await pool.query(
        `INSERT INTO document_uploads
           (doc_id, doc_type, contract_no, url, name, size, note, uploader)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [b.docId, b.docType || null, b.contractNo || null, b.url,
         b.name || null, b.size || null, note, uploader]
      );
      const row = r.rows[0];
      // fire-and-forget
      notifyWecom(row).catch(() => {});
      return res.status(200).json(row);
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("[doc-uploads] error:", err);
    return res.status(500).json({ error: "internal", detail: err.message });
  }
}
