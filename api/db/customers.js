import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

var INIT_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  id            SERIAL PRIMARY KEY,
  company_code  VARCHAR(64) UNIQUE,
  name_en       VARCHAR(256) DEFAULT '',
  name_cn       VARCHAR(256) DEFAULT '',
  brands        JSONB DEFAULT '[]'::jsonb,
  addresses     JSONB DEFAULT '[]'::jsonb,
  contact_name  VARCHAR(128) DEFAULT '',
  contact_phone VARCHAR(64)  DEFAULT '',
  contact_email VARCHAR(128) DEFAULT '',
  country       VARCHAR(64)  DEFAULT '',
  currency      VARCHAR(8)   DEFAULT 'USD',
  payment_term  VARCHAR(128) DEFAULT '',
  portal_role   VARCHAR(32)  DEFAULT 'customer',
  group_id      VARCHAR(64)  DEFAULT '',
  invoice       JSONB DEFAULT '{}'::jsonb,
  raw           JSONB DEFAULT '{}'::jsonb,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cust_code ON customers(company_code);
CREATE INDEX IF NOT EXISTS idx_cust_group ON customers(group_id);
`;

var ALTER_COLS = [
  ["brands",        "JSONB DEFAULT '[]'::jsonb"],
  ["addresses",     "JSONB DEFAULT '[]'::jsonb"],
  ["contact_name",  "VARCHAR(128) DEFAULT ''"],
  ["contact_phone", "VARCHAR(64) DEFAULT ''"],
  ["contact_email", "VARCHAR(128) DEFAULT ''"],
  ["country",       "VARCHAR(64) DEFAULT ''"],
  ["currency",      "VARCHAR(8) DEFAULT 'USD'"],
  ["payment_term",  "VARCHAR(128) DEFAULT ''"],
  ["portal_role",   "VARCHAR(32) DEFAULT 'customer'"],
  ["group_id",      "VARCHAR(64) DEFAULT ''"],
  ["invoice",       "JSONB DEFAULT '{}'::jsonb"],
  ["is_active",     "BOOLEAN DEFAULT true"],
  ["name_en",       "VARCHAR(256) DEFAULT ''"],
  ["name_cn",       "VARCHAR(256) DEFAULT ''"],
  ["card_template", "VARCHAR(32) DEFAULT 'minimal'"],
  ["logo_url",      "TEXT DEFAULT ''"],
];

var inited = false;
async function ensureTable(pool) {
  if (inited) return;
  try { await pool.query(INIT_SQL); } catch(e) { /* table may exist */ }
  // Add missing columns to existing table
  for (var c of ALTER_COLS) {
    try { await pool.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS " + c[0] + " " + c[1]); } catch(e) { /* ignore */ }
  }
  inited = true;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  // ── Tenant scoping (fail-closed) ──
  // GET: non-admin callers see ONLY their own companyCode rows.
  // POST/PUT/DELETE: admin only — customer master data is global config.
  var isAdmin = req.user && req.user.role === "admin";
  if (!isAdmin && req.method !== "GET") {
    return res.status(403).json({ error: "Admin only — customer master data is read-only for tenants." });
  }
  var userCodes = null;
  if (!isAdmin) {
    userCodes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : null);
    if (!userCodes || userCodes.length === 0) {
      return res.status(403).json({ error: "Account scope missing — please log out and log in again." });
    }
  }

  try {
    var pool = getPool();
    await ensureTable(pool);

    // ── GET ─────────────────────────────────────────────
    if (req.method === "GET") {
      var { company_code, group_id, portal_role, search, q, include_inactive, limit = 200 } = req.query;
      var query = "SELECT * FROM customers", params = [], conds = [];
      // Default: only active customers (pass include_inactive=1 for admin views)
      if (!include_inactive) conds.push("is_active = true");
      // Non-admin: hard-restrict to own companyCodes; ignore any client-supplied company_code
      if (!isAdmin) {
        var ph = userCodes.map(function (c) { params.push(c); return "$" + params.length; }).join(",");
        conds.push("company_code IN (" + ph + ")");
      } else if (company_code) {
        params.push(company_code);
        conds.push("company_code = $" + params.length);
      }
      if (group_id)      { params.push(group_id);      conds.push("group_id = $" + params.length); }
      if (portal_role)   { params.push(portal_role);   conds.push("portal_role = $" + params.length); }
      var searchTerm = q || search; // support both ?q= and ?search=
      if (searchTerm)    { params.push("%" + searchTerm + "%"); conds.push("(name_en ILIKE $" + params.length + " OR name_cn ILIKE $" + params.length + " OR company_code ILIKE $" + params.length + ")"); }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += " ORDER BY created_at DESC LIMIT $" + params.length;
      var result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    }

    // ── POST — create or upsert ─────────────────────────
    if (req.method === "POST") {
      var body = req.body || {};
      // batch upsert
      if (Array.isArray(body.customers)) {
        var ok = 0, errors = [];
        for (var c of body.customers) {
          try {
            await upsertOne(pool, c);
            ok++;
          } catch (e) { errors.push({ code: c.company_code, error: e.message }); }
        }
        return res.status(200).json({ success: true, upserted: ok, errors });
      }
      // single upsert
      if (!body.company_code) return res.status(400).json({ success: false, error: "company_code required" });
      var row = await upsertOne(pool, body);
      return res.status(200).json({ success: true, data: row });
    }

    // ── PUT / PATCH — update by company_code ─────────────
    if (req.method === "PUT" || req.method === "PATCH") {
      var body = req.body || {};
      if (!body.company_code) return res.status(400).json({ success: false, error: "company_code required" });
      var row = await upsertOne(pool, body);
      return res.status(200).json({ success: true, data: row });
    }

    // ── DELETE ───────────────────────────────────────────
    if (req.method === "DELETE") {
      var { company_code } = req.query || {};
      if (!company_code) return res.status(400).json({ success: false, error: "company_code required" });
      await pool.query("DELETE FROM customers WHERE company_code = $1", [company_code]);
      return res.status(200).json({ success: true, deleted: company_code });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    // 表不存在时从OSS fallback (GET only)
    if (err.message.includes("does not exist") && req.method === "GET") {
      try {
        var r = await fetch("https://files.sanlynos.com/data/customers.json");
        var d = await r.json();
        var list = Array.isArray(d) ? d : [];
        // Apply tenant scope to OSS fallback too
        if (!isAdmin && userCodes) {
          list = list.filter(function (row) { return row && userCodes.includes(row.company_code); });
        }
        return res.status(200).json({ success: true, data: list, count: list.length, source: "oss" });
      } catch(ossErr) {
        return res.status(200).json({ success: true, data: [], count: 0 });
      }
    }
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function upsertOne(pool, c) {
  var sql = `
    INSERT INTO customers (company_code, name_en, name_cn, brands, addresses,
      contact_name, contact_phone, contact_email, country, currency,
      payment_term, portal_role, group_id, invoice, raw, is_active,
      card_template, logo_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    ON CONFLICT (company_code) DO UPDATE SET
      name_en       = COALESCE(NULLIF(EXCLUDED.name_en,''),       customers.name_en),
      name_cn       = COALESCE(NULLIF(EXCLUDED.name_cn,''),       customers.name_cn),
      brands        = CASE WHEN EXCLUDED.brands = '[]'::jsonb THEN customers.brands ELSE EXCLUDED.brands END,
      addresses     = CASE WHEN EXCLUDED.addresses = '[]'::jsonb THEN customers.addresses ELSE EXCLUDED.addresses END,
      contact_name  = COALESCE(NULLIF(EXCLUDED.contact_name,''),  customers.contact_name),
      contact_phone = COALESCE(NULLIF(EXCLUDED.contact_phone,''), customers.contact_phone),
      contact_email = COALESCE(NULLIF(EXCLUDED.contact_email,''), customers.contact_email),
      country       = COALESCE(NULLIF(EXCLUDED.country,''),       customers.country),
      currency      = COALESCE(NULLIF(EXCLUDED.currency,''),      customers.currency),
      payment_term  = COALESCE(NULLIF(EXCLUDED.payment_term,''),  customers.payment_term),
      portal_role   = COALESCE(NULLIF(EXCLUDED.portal_role,''),   customers.portal_role),
      group_id      = COALESCE(NULLIF(EXCLUDED.group_id,''),      customers.group_id),
      invoice       = CASE WHEN EXCLUDED.invoice = '{}'::jsonb THEN customers.invoice ELSE EXCLUDED.invoice END,
      raw           = customers.raw || EXCLUDED.raw,
      is_active     = EXCLUDED.is_active,
      card_template = COALESCE(NULLIF(EXCLUDED.card_template,''), customers.card_template),
      logo_url      = COALESCE(NULLIF(EXCLUDED.logo_url,''),      customers.logo_url),
      updated_at    = NOW()
    RETURNING *`;

  var params = [
    c.company_code || "",
    c.name_en || "",
    c.name_cn || "",
    JSON.stringify(c.brands || []),
    JSON.stringify(c.addresses || []),
    c.contact_name || "",
    c.contact_phone || "",
    c.contact_email || "",
    c.country || "",
    c.currency || "",
    c.payment_term || "",
    c.portal_role || "customer",
    c.group_id || "",
    JSON.stringify(c.invoice || {}),
    JSON.stringify(c.raw || {}),
    c.is_active !== false,
    c.card_template || "minimal",
    c.logo_url || "",
  ];
  var result = await pool.query(sql, params);
  return result.rows[0];
}
