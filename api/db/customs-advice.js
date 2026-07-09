import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS customs_advice (
  id SERIAL PRIMARY KEY,
  advice_no VARCHAR UNIQUE NOT NULL,
  company_code VARCHAR NOT NULL,
  contract_no VARCHAR,
  source_file TEXT,
  options JSONB NOT NULL,
  recommended VARCHAR NOT NULL,
  chosen VARCHAR,
  status VARCHAR DEFAULT 'draft',
  confirm_token VARCHAR UNIQUE,
  token_expires TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  confirm_meta JSONB,
  risk_ack BOOLEAN DEFAULT false,
  service_fee NUMERIC DEFAULT 100,
  notes TEXT,
  created_by VARCHAR,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
)`;

const MIGRATE_SQL = [
  "ALTER TABLE customs_advice ADD COLUMN IF NOT EXISTS contract_no VARCHAR",
  "ALTER TABLE customs_advice ADD COLUMN IF NOT EXISTS source_file TEXT",
  "ALTER TABLE customs_advice ADD COLUMN IF NOT EXISTS confirm_meta JSONB",
  "ALTER TABLE customs_advice ADD COLUMN IF NOT EXISTS risk_ack BOOLEAN DEFAULT false",
  "ALTER TABLE customs_advice ADD COLUMN IF NOT EXISTS service_fee NUMERIC DEFAULT 100",
  "ALTER TABLE customs_advice ADD COLUMN IF NOT EXISTS notes TEXT",
  "CREATE INDEX IF NOT EXISTS idx_customs_advice_company ON customs_advice(company_code)",
  "CREATE INDEX IF NOT EXISTS idx_customs_advice_status ON customs_advice(status)",
  "CREATE INDEX IF NOT EXISTS idx_customs_advice_token ON customs_advice(confirm_token)",
];

let inited = false;
async function ensureTable(pool) {
  if (inited) return;
  await pool.query(INIT_SQL);
  for (const sql of MIGRATE_SQL) await pool.query(sql);
  inited = true;
}

function canManage(req) {
  return ["admin", "logistics"].includes(req.user?.role);
}

function is2309(hs) {
  return String(hs || "").trim().startsWith("2309");
}

function amountOf(item) {
  const n = Number(item?.amount);
  return Number.isFinite(n) ? n : 0;
}

function looksFood(item) {
  const text = `${item?.name || ""} ${item?.elements || ""}`;
  return /食品|宠物食品|饲料|零食|罐头|粮|冻干|咬胶|treat|food|feed/i.test(text);
}

function validateOptions(options, recommended) {
  if (!Array.isArray(options) || !options.length) return "options must be a non-empty array";
  const optionCodes = options.map(o => String(o?.option || "").trim()).filter(Boolean);
  if (!optionCodes.includes(String(recommended || "").trim())) return "recommended must match an option";

  for (const option of options) {
    if (!option?.option) return "each option requires option";
    if (!Array.isArray(option.items) || !option.items.length) return `option ${option.option} items required`;

    const foodNames = new Set();
    const nonFoodNames = new Set();
    let has2309Name = false;
    let foodAmount = 0;

    for (const item of option.items) {
      const name = String(item?.name || "").trim();
      const hs2309 = is2309(item?.hs);
      if (!name) return `option ${option.option} item name required`;
      if (item?.inspection === true && !hs2309) {
        return "食品必须独立品名申报，不可漏报瞒报：inspection=true 的行 HS 必须以 2309 开头";
      }
      if (hs2309) {
        has2309Name = true;
        foodNames.add(name);
        foodAmount += amountOf(item);
      } else {
        nonFoodNames.add(name);
        if (looksFood(item)) foodAmount += amountOf(item);
      }
    }

    for (const name of foodNames) {
      if (nonFoodNames.has(name)) {
        return "食品必须独立品名申报，不可漏报瞒报：2309 食品行品名不得与非 2309 行同名";
      }
    }
    if (foodAmount > 0 && !has2309Name) {
      return "食品必须独立品名申报，不可漏报瞒报";
    }
  }
  return null;
}

async function nextAdviceNo(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('customs_advice_advice_no'))");
  const { rows } = await client.query(`
    SELECT to_char(now(), 'YYYYMMDD') AS d,
           COALESCE(MAX((substring(advice_no from 13 for 2))::int), 0) AS max_no
    FROM customs_advice
    WHERE advice_no LIKE 'CA-' || to_char(now(), 'YYYYMMDD') || '-%'
  `);
  const seq = String(Number(rows[0]?.max_no || 0) + 1).padStart(2, "0");
  return `CA-${rows[0].d}-${seq}`;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  await ensureTable(pool);

  if (req.method === "GET") {
    try {
      const { id, company_code, status, limit = 100 } = req.query || {};
      const conds = [], vals = [];
      if (id) { vals.push(id); conds.push(`id = $${vals.length}`); }
      if (company_code) { vals.push(company_code); conds.push(`company_code = $${vals.length}`); }
      if (status) { vals.push(status); conds.push(`status = $${vals.length}`); }
      vals.push(Math.min(parseInt(limit, 10) || 100, 500));
      let sql = "SELECT * FROM customs_advice";
      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      sql += ` ORDER BY created_at DESC LIMIT $${vals.length}`;
      const r = await pool.query(sql, vals);
      if (id && !r.rowCount) return res.status(404).json({ error: "customs advice not found" });
      return res.status(200).json({ success: true, data: id ? r.rows[0] : r.rows, count: r.rowCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    if (!canManage(req)) return res.status(403).json({ error: "Forbidden: admin/logistics only" });
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const { company_code, contract_no, source_file, options, recommended, service_fee, notes } = body;
      if (!company_code) return res.status(400).json({ error: "company_code required" });
      const errMsg = validateOptions(options, recommended);
      if (errMsg) return res.status(400).json({ error: errMsg });

      await client.query("BEGIN");
      const company = await client.query("SELECT code FROM companies WHERE code = $1", [company_code]);
      if (!company.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "company_code not found" });
      }
      const adviceNo = await nextAdviceNo(client);
      const token = crypto.randomBytes(24).toString("base64url");
      const createdBy = req.user?.username || req.user?.email || req.user?.id || null;
      const r = await client.query(`
        INSERT INTO customs_advice
          (advice_no, company_code, contract_no, source_file, options, recommended,
           confirm_token, token_expires, service_fee, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '7 days',$8,$9,$10)
        RETURNING *
      `, [
        adviceNo, company_code, contract_no || null, source_file || null,
        JSON.stringify(options), recommended, token,
        service_fee === undefined ? 100 : service_fee, notes || null, createdBy,
      ]);
      await client.query("COMMIT");
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      if (err.code === "23505") return res.status(409).json({ error: "advice_no or token already exists" });
      return res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  }

  if (req.method === "PATCH") {
    if (!canManage(req)) return res.status(403).json({ error: "Forbidden: admin/logistics only" });
    try {
      const { id, ...patch } = req.body || {};
      if (!id) return res.status(400).json({ error: "id required" });
      for (const blocked of ["chosen", "confirmed_at", "risk_ack"]) {
        if (patch[blocked] !== undefined) return res.status(400).json({ error: `${blocked} cannot be changed by internal PATCH` });
      }
      const allowed = ["status", "contract_no", "notes"];
      const sets = [], vals = [];
      for (const k of allowed) {
        if (patch[k] !== undefined) {
          vals.push(patch[k]);
          sets.push(`${k} = $${vals.length}`);
        }
      }
      if (!sets.length) return res.status(400).json({ error: "no fields to update" });
      vals.push(id);
      sets.push("updated_at = now()");
      const r = await pool.query(`UPDATE customs_advice SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
      if (!r.rowCount) return res.status(404).json({ error: "customs advice not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

