// api/db/bank-payment-template.js
// Bank payment template configuration CRUD. Actual bank-specific export is wired later.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function send(res, status, body) {
  return res.status(status).json(body);
}

function text(v) {
  return String(v == null ? "" : v).trim();
}

function s(v) {
  const out = text(v);
  return out || null;
}

function authUser(req, auth) {
  return auth && typeof auth === "object" ? auth : (req.user || req.auth || req.session?.user || {});
}

function rolesOf(user) {
  const roles = [];
  for (const key of ["role", "user_role", "account_role"]) {
    if (user && user[key]) roles.push(user[key]);
  }
  if (Array.isArray(user?.roles)) roles.push(...user.roles);
  if (Array.isArray(user?.permissions)) roles.push(...user.permissions);
  return roles.map(v => text(v).toLowerCase()).filter(Boolean);
}

function canReview(user) {
  if (user?.is_admin === true || user?.admin === true) return true;
  return rolesOf(user).some(r => r === "admin" || r === "finance" || r === "finance_admin" || r === "accounting");
}

function normalizeCurrency(v) {
  const value = text(v).toUpperCase();
  if (!value) return null;
  if (/^(USD|US\$|美元|美金)$/.test(value)) return "USD";
  if (/^(CNY|RMB|人民币)$/.test(value)) return "CNY";
  return value.slice(0, 8);
}

function normalizeFormat(v) {
  const value = text(v).toLowerCase();
  return value || "xlsx";
}

function mappingOf(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  const err = new Error("field_mapping_object_required");
  err.status = 400;
  throw err;
}

function requireId(v) {
  if (!v || !/^\d+$/.test(String(v))) {
    const err = new Error("id_required");
    err.status = 400;
    throw err;
  }
  return v;
}

async function listTemplates(pool, payerCompanyCode) {
  const payer = s(payerCompanyCode);
  if (!payer) {
    const err = new Error("payer_company_code_required");
    err.status = 400;
    throw err;
  }
  const q = await pool.query(
    `SELECT *
       FROM bank_payment_templates
      WHERE payer_company_code=$1
      ORDER BY active DESC, created_at DESC, id DESC`,
    [payer]
  );
  return { success: true, templates: q.rows };
}

async function upsertTemplate(pool, body) {
  const id = s(body.id);
  const payer = s(body.payer_company_code);
  const templateName = s(body.template_name);
  const fieldMapping = mappingOf(body.field_mapping);
  if (!payer) return { success: false, error: "payer_company_code_required" };
  if (!templateName) return { success: false, error: "template_name_required" };

  const values = [
    payer,
    s(body.payer_bank_name),
    s(body.payer_account_no),
    templateName,
    normalizeCurrency(body.currency),
    normalizeFormat(body.file_format),
    JSON.stringify(fieldMapping),
    body.active === false ? false : true,
  ];

  if (id) {
    const q = await pool.query(
      `UPDATE bank_payment_templates
          SET payer_company_code=$2,
              payer_bank_name=$3,
              payer_account_no=$4,
              template_name=$5,
              currency=$6,
              file_format=$7,
              field_mapping=$8::jsonb,
              active=$9
        WHERE id=$1
        RETURNING *`,
      [id, ...values]
    );
    if (!q.rows[0]) return { success: false, error: "template_not_found" };
    return { success: true, template: q.rows[0] };
  }

  const q = await pool.query(
    `INSERT INTO bank_payment_templates
      (payer_company_code,payer_bank_name,payer_account_no,template_name,currency,file_format,field_mapping,active)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     RETURNING *`,
    values
  );
  return { success: true, template: q.rows[0] };
}

async function deleteTemplate(pool, id) {
  const q = await pool.query(
    `UPDATE bank_payment_templates
        SET active=false
      WHERE id=$1
      RETURNING *`,
    [requireId(id)]
  );
  if (!q.rows[0]) return { success: false, error: "template_not_found" };
  return { success: true, template: q.rows[0] };
}

async function exportPlaceholder(pool, id) {
  const q = await pool.query("SELECT * FROM bank_payment_templates WHERE id=$1 LIMIT 1", [requireId(id)]);
  if (!q.rows[0]) return { success: false, error: "template_not_found" };

  // Placeholder for bank-specific batch export:
  // once Damon provides an official bank upload XLSX template, payment-batch.js confirmBatch
  // should load template_id, use field_mapping to reorder finance_payment_batch_items fields,
  // and replace generated headers with the exact bank template column names.
  return {
    success: false,
    error: "template_export_not_implemented",
    template: q.rows[0],
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  let auth = null;
  try {
    auth = requireAuth(req, res);
    if (auth === false || res.headersSent) return;
  } catch (e) {
    return send(res, e.status || 401, { success: false, error: e.message || "unauthorized" });
  }
  const user = authUser(req, auth);
  if (!canReview(user)) return send(res, 403, { success: false, error: "finance_or_admin_required" });

  const pool = getPool();
  try {
    if (req.method === "GET") {
      return send(res, 200, await listTemplates(pool, req.query?.payer_company_code));
    }
    if (req.method !== "POST") return send(res, 405, { success: false, error: "method_not_allowed" });

    const body = req.body || {};
    if (body.action === "upsert") return send(res, 200, await upsertTemplate(pool, body));
    if (body.action === "delete") return send(res, 200, await deleteTemplate(pool, body.id));
    if (body.action === "export") return send(res, 501, await exportPlaceholder(pool, body.id));
    return send(res, 400, { success: false, error: "unknown_action" });
  } catch (e) {
    return send(res, e.status || 500, { success: false, error: e.message || "server_error" });
  }
}
