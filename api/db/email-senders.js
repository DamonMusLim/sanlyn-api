// api/db/email-senders.js — 邮件发件公司（主体）CRUD
// 发件公司做成数据表，加一个公司=加一行（对应阿里云 DirectMail 的发信地址）。
// email_templates.sender 引用 sender_key。
// GET /api/db/email-senders            → { data:[...] }
// POST   { sender_key,company_name,company_name_en,email,brand_color,is_active,sort }
// PATCH  { id, ...fields }
// DELETE ?id=
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const SEED = [
  { sender_key: "oceanbaby", company_name: "洋宝宝", company_name_en: "Ocean Baby | Sanlyn OS", email: "OB@sanlynos.com", brand_color: "#0ea5e9", sort: 1 },
  { sender_key: "petbaby",   company_name: "宠宝",   company_name_en: "Pet Baby | Sanlyn OS",   email: "PB@sanlynos.com", brand_color: "#f59e0b", sort: 2 },
];

async function ensure(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_senders (
      id              SERIAL PRIMARY KEY,
      sender_key      TEXT UNIQUE,
      company_name    TEXT,
      company_name_en TEXT,
      email           TEXT,
      brand_color     TEXT DEFAULT '#0ea5e9',
      is_active       BOOLEAN DEFAULT true,
      sort            INTEGER DEFAULT 100,
      created_at      TIMESTAMPTZ DEFAULT now()
    );
  `).catch(() => {});
  const c = await pool.query(`SELECT count(*)::int AS n FROM email_senders`);
  if (c.rows[0].n === 0) {
    for (const s of SEED) {
      await pool.query(
        `INSERT INTO email_senders (sender_key,company_name,company_name_en,email,brand_color,sort)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (sender_key) DO NOTHING`,
        [s.sender_key, s.company_name, s.company_name_en, s.email, s.brand_color, s.sort]);
    }
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    await ensure(pool);

    if (req.method === "GET") {
      const r = await pool.query(`SELECT * FROM email_senders ORDER BY sort ASC, id ASC`);
      return res.json({ data: r.rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      let key = (b.sender_key || "").trim();
      if (!key) key = "sender_" + Date.now();
      if (!/^[a-z0-9_]+$/i.test(key)) return res.status(400).json({ error: "sender_key 只能用字母数字下划线" });
      const r = await pool.query(
        `INSERT INTO email_senders (sender_key,company_name,company_name_en,email,brand_color,is_active,sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (sender_key) DO NOTHING RETURNING *`,
        [key, b.company_name || key, b.company_name_en || b.company_name || key,
         b.email || "", b.brand_color || "#0ea5e9", b.is_active !== false, b.sort || 100]);
      if (!r.rows[0]) return res.status(409).json({ error: "sender_key 已存在" });
      return res.json({ success: true, data: r.rows[0] });
    }

    if (req.method === "PATCH") {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: "id 必填" });
      const fields = ["company_name","company_name_en","email","brand_color","is_active","sort"];
      const sets = [], vals = [];
      fields.forEach(f => { if (b[f] !== undefined) { vals.push(b[f]); sets.push(`${f}=$${vals.length}`); } });
      if (!sets.length) return res.json({ success: true });
      vals.push(b.id);
      const r = await pool.query(`UPDATE email_senders SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`, vals);
      return res.json({ success: true, data: r.rows[0] });
    }

    if (req.method === "DELETE") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id 必填" });
      const used = await pool.query(
        `SELECT count(*)::int AS n FROM email_templates t JOIN email_senders s ON s.id=$1 WHERE t.sender=s.sender_key`, [id]);
      if (used.rows[0].n > 0) return res.status(409).json({ error: `该公司下还有 ${used.rows[0].n} 个模版，先改掉再删` });
      await pool.query(`DELETE FROM email_senders WHERE id=$1`, [id]);
      return res.json({ success: true });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("[email-senders]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
