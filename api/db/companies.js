// /api/db/companies.js — Sanlyn group entities CRUD (distinct from company.js which is JDY)
import { getPool, setCors } from "./db.js";

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS companies (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(16) UNIQUE NOT NULL,
  name_en         VARCHAR(256) DEFAULT '',
  name_cn         VARCHAR(256) DEFAULT '',
  type            VARCHAR(32) DEFAULT 'operating',
  country         VARCHAR(8) DEFAULT 'CN',
  registration_no VARCHAR(128),
  tax_id          VARCHAR(128),
  bank_accounts   JSONB DEFAULT '[]'::jsonb,
  address         JSONB DEFAULT '{}'::jsonb,
  stamps          JSONB DEFAULT '[]'::jsonb,
  default_seller  BOOLEAN DEFAULT false,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
`;

const SANLYN_GROUP = [
  { code:"XPB",  name_en:"Xiamen Pet Baby",   type:"operating", country:"CN" },
  { code:"SHK",  name_en:"Sanlyn HK",         type:"holding",   country:"HK" },
  { code:"SSG",  name_en:"Sanlyn Singapore",  type:"operating", country:"SG" },
  { code:"SBV",  name_en:"Sanlyn BVI",        type:"holding",   country:"BVI"},
  { code:"BABI", name_en:"Babi Pet Foods",    type:"factory",   country:"CN" },
  { code:"OB",   name_en:"Ocean Baby",        type:"factory",   country:"CN" },
  { code:"STECH",name_en:"Sanlyn Technology", type:"tech",      country:"CN" },
];

let inited = false;
async function ensureTable(pool) {
  if (inited) return;
  await pool.query(INIT_SQL);
  for (const c of SANLYN_GROUP) {
    await pool.query(
      `INSERT INTO companies(code,name_en,type,country) VALUES($1,$2,$3,$4) ON CONFLICT(code) DO NOTHING`,
      [c.code, c.name_en, c.type, c.country]
    );
  }
  inited = true;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  await ensureTable(pool);

  if (req.method === "GET") {
    try {
      const { type, country, limit = 100 } = req.query;
      let query = "SELECT * FROM companies", params = [], conds = [];
      if (type)    { params.push(type);    conds.push(`type = $${params.length}`); }
      if (country) { params.push(country); conds.push(`country = $${params.length}`); }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += ` ORDER BY code ASC LIMIT $${params.length}`;
      const result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    try {
      const { code, name_en, name_cn, type, country, registration_no, tax_id, bank_accounts, address, stamps, default_seller, notes } = req.body || {};
      if (!code || !name_en) return res.status(400).json({ error: "code and name_en required" });
      const r = await pool.query(
        `INSERT INTO companies(code,name_en,name_cn,type,country,registration_no,tax_id,bank_accounts,address,stamps,default_seller,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [code, name_en, name_cn||"", type||"operating", country||"CN", registration_no||null, tax_id||null,
         JSON.stringify(bank_accounts||[]), JSON.stringify(address||{}), JSON.stringify(stamps||[]), default_seller||false, notes||null]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Company code already exists" });
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const { id, ...patch } = req.body || {};
      if (!id) return res.status(400).json({ error: "id required" });
      const allowed = ["name_en","name_cn","type","country","registration_no","tax_id","bank_accounts","address","stamps","default_seller","notes"];
      const sets = [], vals = [];
      for (const k of allowed) {
        if (patch[k] !== undefined) {
          vals.push(typeof patch[k] === "object" ? JSON.stringify(patch[k]) : patch[k]);
          sets.push(`${k} = $${vals.length}`);
        }
      }
      if (!sets.length) return res.status(400).json({ error: "no fields to update" });
      // If setting default_seller=true, clear other defaults first
      if (patch.default_seller === true) {
        await pool.query("UPDATE companies SET default_seller = false WHERE default_seller = true");
      }
      vals.push(id);
      sets.push("updated_at = NOW()");
      const r = await pool.query(
        `UPDATE companies SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals
      );
      if (!r.rowCount) return res.status(404).json({ error: "company not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
