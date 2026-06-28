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
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const pool = getPool();
    await ensureTable(pool);

    if (req.method === "GET") {
      const { docId, contractNo, limit = 100 } = req.query || {};
      const conds = [], vals = [];
      if (docId)      { vals.push(docId);      conds.push("doc_id = $" + vals.length); }
      if (contractNo) { vals.push(contractNo); conds.push("contract_no = $" + vals.length); }
      if (!conds.length) return res.status(400).json({ error: "docId or contractNo required" });
      vals.push(parseInt(limit));
      const r = await pool.query(
        `SELECT * FROM document_uploads
         WHERE ${conds.join(" AND ")}
         ORDER BY uploaded_at DESC
         LIMIT $${vals.length}`,
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

    if (req.method === "PATCH") {
      // 盖章版做成原件行上的字段(stamped_url/stamped_meta)——删原件天然带走盖章版,不留孤儿(2026-06-05 Damon)
      const b = req.body || {};
      // 部分更新:只动 body 里出现的列(stamped_url/stamped_meta/review_meta),不互相覆盖。
      const sets = [], vals = [];
      const add = (col, val, isJson) => { vals.push(isJson ? (val ? JSON.stringify(val) : null) : (val == null ? null : val)); sets.push(col + "=$" + vals.length); };
      if ("stamped_url" in b) add("stamped_url", b.stamped_url, false);
      if ("stamped_meta" in b) add("stamped_meta", b.stamped_meta, true);
      if ("review_meta" in b) add("review_meta", b.review_meta, true);
      if (!sets.length) return res.status(400).json({ error: "no fields to update" });
      let where, wvals;
      if (b.id) { where = "id=$" + (vals.length + 1); wvals = [parseInt(b.id, 10)]; }
      else if (b.docId && b.docType && b.origUrl) { where = "doc_id=$" + (vals.length + 1) + " AND doc_type=$" + (vals.length + 2) + " AND url=$" + (vals.length + 3); wvals = [b.docId, b.docType, b.origUrl]; }
      else return res.status(400).json({ error: "need id or (docId,docType,origUrl)" });
      const r = await pool.query("UPDATE document_uploads SET " + sets.join(", ") + " WHERE " + where + " RETURNING id, name, stamped_url, review_meta", vals.concat(wvals));
      if (!r.rows.length) return res.status(404).json({ error: "not_found" });
      return res.status(200).json({ success: true, updated: r.rows[0] });
    }

    if (req.method === "DELETE") {
      // Remove an upload record by id (e.g. wrongly-attached file). OSS object is
      // left intact (no hard purge) — this only unlinks it from the doc list.
      const id = (req.query || {}).id;
      if (!id) return res.status(400).json({ error: "id required" });
      const r = await pool.query(
        "DELETE FROM document_uploads WHERE id = $1 RETURNING id, doc_id, doc_type, name",
        [parseInt(id, 10)]
      );
      if (!r.rows.length) return res.status(404).json({ error: "not_found" });
      const row = r.rows[0];
      // 删原件 → 连带删它的盖章版(同 doc_id + type+_stamped + 名插入"(盖章)"),
      // 避免删原件后盖章版变孤儿一直挂着(2026-06-05 Damon)。按精确名匹配,绝不误删其它盖章件。
      let cascaded = [];
      if (row.doc_type && !/_stamped$/.test(row.doc_type)) {
        const stampedType = row.doc_type + "_stamped";
        const stampedName = String(row.name || "").replace(/(\.[^.]+)?$/, "(盖章)$1");
        const c = await pool.query(
          "DELETE FROM document_uploads WHERE doc_id = $1 AND doc_type = $2 AND name = $3 RETURNING id, name",
          [row.doc_id, stampedType, stampedName]
        );
        cascaded = c.rows;
      }
      return res.status(200).json({ success: true, deleted: row, cascaded });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("[doc-uploads] error:", err);
    return res.status(500).json({ error: "internal", detail: err.message });
  }
}
