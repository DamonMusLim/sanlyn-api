// /api/db/company-tab-config.js
// Per-company compliance tab override configuration.
//
// GET    ?companyCode=X
//        -> { ok:true, company_code, enabled_tabs, is_default }
//        Missing row means no override: enabled_tabs is null and is_default is true.
// PUT    { companyCode, enabledTabs:[...] }
//        -> upsert override row in company_tab_config.
// DELETE ?companyCode=X
//        -> delete override row, resetting the company to frontend defaults.
//
// Table: company_tab_config(company_code, enabled_tabs, updated_by, updated_at, created_at)

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const TAB_CODE_RE = /^[a-z_]{2,40}$/;
const MAX_TABS = 40;

function getCurrentUser(req) {
  const user = req.user || {};
  return (
    user.email ||
    user.username ||
    user.name ||
    user.id ||
    user.sub ||
    user.user_id ||
    "authenticated"
  ).toString();
}

function normalizeCompanyCode(value) {
  return (value || "").toString().trim();
}

function validateEnabledTabs(value) {
  if (!Array.isArray(value)) {
    return { error: "enabledTabs must be an array of strings" };
  }

  if (value.length > MAX_TABS) {
    return { error: `enabledTabs must contain at most ${MAX_TABS} items` };
  }

  const enabledTabs = [];
  const seen = new Set();

  for (const tab of value) {
    if (typeof tab !== "string") {
      return { error: "enabledTabs items must be strings" };
    }

    const trimmed = tab.trim();
    if (!TAB_CODE_RE.test(trimmed)) {
      return { error: "enabledTabs items must match /^[a-z_]{2,40}$/" };
    }

    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      enabledTabs.push(trimmed);
    }
  }

  return { enabledTabs };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  // -- GET: fetch override ---------------------------------------------------
  if (req.method === "GET") {
    const companyCode = normalizeCompanyCode(req.query.companyCode);
    if (!companyCode) return res.status(400).json({ error: "companyCode required" });

    const r = await pool.query(
      `SELECT company_code, enabled_tabs
         FROM company_tab_config
        WHERE company_code = $1`,
      [companyCode]
    );

    if (r.rows.length === 0) {
      return res.status(200).json({
        ok: true,
        company_code: companyCode,
        enabled_tabs: null,
        is_default: true
      });
    }

    return res.status(200).json({
      ok: true,
      company_code: r.rows[0].company_code,
      enabled_tabs: r.rows[0].enabled_tabs,
      is_default: false
    });
  }

  // -- PUT: upsert override --------------------------------------------------
  if (req.method === "PUT") {
    const body = req.body || {};
    const companyCode = normalizeCompanyCode(body.companyCode);
    if (!companyCode) return res.status(400).json({ error: "companyCode required" });

    const validation = validateEnabledTabs(body.enabledTabs);
    if (validation.error) return res.status(400).json({ error: validation.error });

    const updatedBy = getCurrentUser(req);
    const r = await pool.query(
      `INSERT INTO company_tab_config (company_code, enabled_tabs, updated_by, updated_at)
       VALUES ($1, $2::text[], $3, NOW())
       ON CONFLICT (company_code) DO UPDATE
          SET enabled_tabs = EXCLUDED.enabled_tabs,
              updated_by = EXCLUDED.updated_by,
              updated_at = NOW()
       RETURNING company_code, enabled_tabs, updated_by, updated_at, created_at`,
      [companyCode, validation.enabledTabs, updatedBy]
    );

    return res.status(200).json({ ok: true, data: r.rows[0] });
  }

  // -- DELETE: reset to defaults --------------------------------------------
  if (req.method === "DELETE") {
    const companyCode = normalizeCompanyCode(req.query.companyCode);
    if (!companyCode) return res.status(400).json({ error: "companyCode required" });

    await pool.query("DELETE FROM company_tab_config WHERE company_code = $1", [companyCode]);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
