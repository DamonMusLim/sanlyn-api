// api/db/mailings.js — 单据正本邮寄/快递追踪 (按BL)
// GET /api/db/mailings?bl_no=<BL>  → 该BL邮寄记录(含关联单据docs)
// POST { bl_no, courier_company, tracking_no, recipient_type, recipient_name,
//        direction, status, sent_at, note, docs:[{doc_upload_id,doc_type,doc_label}] }
// PATCH { id, ...fields }   DELETE ?id=
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

async function ensure(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mailings (
      id SERIAL PRIMARY KEY,
      bl_no TEXT, courier_company TEXT, tracking_no TEXT,
      recipient_type TEXT, recipient_name TEXT,
      direction TEXT DEFAULT 'send', status TEXT DEFAULT 'sent',
      sent_at TEXT, note TEXT, docs JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mailings_bl ON mailings(bl_no);
  `).catch(() => {});
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    await ensure(pool);

    if (req.method === "GET") {
      const bl = req.query.bl_no;
      const r = await pool.query(
        `SELECT * FROM mailings ${bl ? "WHERE bl_no=$1" : ""} ORDER BY id DESC LIMIT 500`,
        bl ? [bl] : []);
      return res.json({ data: r.rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const r = await pool.query(
        `INSERT INTO mailings (bl_no,courier_company,tracking_no,recipient_type,
           recipient_name,direction,status,sent_at,note,docs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [b.bl_no || null, b.courier_company || null, b.tracking_no || null,
         b.recipient_type || null, b.recipient_name || null, b.direction || "send",
         b.status || "sent", b.sent_at || null, b.note || null,
         JSON.stringify(b.docs || [])]);
      return res.json({ success: true, data: r.rows[0] });
    }

    if (req.method === "PATCH") {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: "id 必填" });
      const fields = ["courier_company","tracking_no","recipient_type","recipient_name","direction","status","sent_at","note"];
      const sets = [], vals = [];
      fields.forEach(f => { if (b[f] !== undefined) { vals.push(b[f]); sets.push(`${f}=$${vals.length}`); } });
      if (b.docs !== undefined) { vals.push(JSON.stringify(b.docs)); sets.push(`docs=$${vals.length}`); }
      if (!sets.length) return res.json({ success: true });
      vals.push(b.id);
      await pool.query(`UPDATE mailings SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
      return res.json({ success: true });
    }

    if (req.method === "DELETE") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id 必填" });
      await pool.query(`DELETE FROM mailings WHERE id=$1`, [id]);
      return res.json({ success: true });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("[mailings]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
