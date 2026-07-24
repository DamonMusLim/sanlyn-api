// /api/db/companies.js — Sanlyn group entities CRUD (distinct from company.js which is JDY)
//
// FAIL-CLOSED-2026-05-19: previously had ZERO auth — anyone could POST/PATCH
// to insert or modify companies, including the bank_accounts JSONB column.
// Now: GET requires JWT; POST/PATCH restricted to admin role only.
import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

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

// Migration: add columns that may not exist in older production schemas
const MIGRATE_SQL = [
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS country         VARCHAR(8)  DEFAULT 'CN'`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS registration_no VARCHAR(128)`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS bank_accounts   JSONB DEFAULT '[]'::jsonb`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS stamps          JSONB DEFAULT '[]'::jsonb`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_seller  BOOLEAN DEFAULT false`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes           TEXT`,
];

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
  for (const sql of MIGRATE_SQL) {
    await pool.query(sql);
  }
  for (const c of SANLYN_GROUP) {
    try {
      await pool.query(
        `INSERT INTO companies(code,name_en,type,country) VALUES($1,$2,$3,$4) ON CONFLICT(code) DO NOTHING`,
        [c.code, c.name_en, c.type, c.country]
      );
    } catch (e) { /* skip seed violating type/check constraint (legacy type like tech/partner) */ }
  }
  inited = true;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT

  const _isAdmin = req.user?.role === "admin";

  const pool = getPool();
  await ensureTable(pool);

  if (req.method === "GET") {
    try {
      const { type, country, limit = 100, q, id, ids } = req.query;
      let query = "SELECT * FROM companies", params = [], conds = [];
      const idList = []
        .concat(id != null ? [id] : [])
        .concat(ids ? String(ids).split(",") : [])
        .map(function(v) { return parseInt(v, 10); })
        .filter(function(v, i, a) { return Number.isFinite(v) && v > 0 && a.indexOf(v) === i; });
      const idMode = id != null || ids != null;
      if (idMode) {
        params.push(idList);
        conds.push(`id = ANY($${params.length}::int[])`);
      } else {
        if (type)    { params.push(type);    conds.push(`type = $${params.length}`); }
        if (country) { params.push(country); conds.push(`country = $${params.length}`); }
        if (q && q.trim()) { const kw = q.trim(); params.push("%" + kw + "%"); const p = params.length; conds.push("(name_cn ILIKE $" + p + " OR name_en ILIKE $" + p + " OR code ILIKE $" + p + ")"); }
      }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit, 10) || 100);
      query += ` ORDER BY code ASC LIMIT $${params.length}`;
      const result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    if (!_isAdmin) return res.status(403).json({ error: "Forbidden: admin only" });
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
    if (!_isAdmin) return res.status(403).json({ error: "Forbidden: admin only" });
    try {
      const { id, ...patch } = req.body || {};
      if (!id) return res.status(400).json({ error: "id required" });
      const allowed = ["name_en","name_cn","type","country","registration_no","tax_id","bank_accounts","address","stamps","default_seller","notes","msic_code","einvoice_email","compliance_info","contact_phone","contact_name"];
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
