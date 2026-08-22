// api/db/freight-invoice-confirm.js
// Manual confirmation gate for freight invoice critical payment fields.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const CORRECTION_FIELDS = ["payee_bank_name", "payee_bank_account", "payee_account_currency_hint", "payment_currency_limit", "receivable_fx_currency", "receivable_fx_amount", "bl_nos", "amount_incl_tax"];
const REMATCH_FIELDS = new Set(["payment_currency_limit", "receivable_fx_currency", "receivable_fx_amount", "bl_nos", "amount_incl_tax"]);

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

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[,\s￥¥]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function normalizeCurrency(v) {
  const value = text(v).toUpperCase();
  if (!value) return null;
  if (/^(USD|US\$|美元|美金)$/.test(value)) return "USD";
  if (/^(CNY|RMB|人民币)$/.test(value)) return "CNY";
  return value.slice(0, 8);
}

function orderedUnique(values) {
  const seen = new Set();
  const out = [];
  for (const v of values || []) {
    const one = text(v);
    if (!one || seen.has(one)) continue;
    seen.add(one);
    out.push(one);
  }
  return out;
}

function normalizeBlNos(values) {
  const parts = Array.isArray(values)
    ? values.flatMap(v => text(v).split(/[|,，、/\s]+/))
    : text(values).split(/[|,，、/\s]+/);
  return orderedUnique(parts);
}

function assertInvoiceId(id) {
  if (!id || !/^\d+$/.test(String(id))) {
    const err = new Error("invoice_id_required");
    err.status = 400;
    throw err;
  }
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
  const roles = rolesOf(user);
  return roles.some(r => r === "admin" || r === "finance" || r === "finance_admin" || r === "accounting");
}

function actorName(user) {
  return s(user?.username) || s(user?.name) || s(user?.email) || s(user?.id) || "system";
}

function cleanValue(field, value) {
  if (field === "bl_nos") return normalizeBlNos(value);
  if (field === "amount_incl_tax" || field === "receivable_fx_amount") return num(value);
  if (field.endsWith("_currency") || field.endsWith("_currency_hint") || field === "payment_currency_limit") {
    return normalizeCurrency(value);
  }
  return s(value);
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function rawObject(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

async function getInvoice(pool, invoiceId, forUpdate = false) {
  assertInvoiceId(invoiceId);
  const q = await pool.query(
    `SELECT id, invoice_no, seller_name, payee_bank_name, payee_bank_account,
            payee_account_currency_hint, payment_currency_limit,
            receivable_fx_currency, receivable_fx_amount, bl_nos, amount_incl_tax,
            review_status, critical_fields_confirmed, payment_ready_block_reason, raw,
            updated_at
      FROM finance_invoices_in
      WHERE id=$1
      LIMIT 1
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [invoiceId]
  );
  if (!q.rows[0]) {
    const err = new Error("invoice_not_found");
    err.status = 404;
    throw err;
  }
  return q.rows[0];
}

async function latestAudit(pool, invoiceId) {
  const q = await pool.query(
    `SELECT *
       FROM finance_invoice_match_audits
      WHERE invoice_id=$1
      ORDER BY checked_at DESC, id DESC
      LIMIT 1`,
    [invoiceId]
  );
  return q.rows[0] || null;
}

function validateConfirm(row) {
  const missing = [];
  if (!s(row.payee_bank_account)) missing.push("payee_bank_account");
  if (num(row.amount_incl_tax) == null) missing.push("amount_incl_tax");
  const payCurrency = normalizeCurrency(row.payment_currency_limit) || normalizeCurrency(row.receivable_fx_currency);
  if (payCurrency && payCurrency !== "CNY" && num(row.receivable_fx_amount) == null) {
    missing.push("receivable_fx_amount");
  }
  return missing;
}

function buildCorrections(invoice, corrections, actor) {
  const now = new Date().toISOString();
  const updates = {};
  const audit = [];
  for (const field of CORRECTION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(corrections || {}, field)) continue;
    const next = cleanValue(field, corrections[field]);
    const old = cleanValue(field, invoice[field]);
    if (sameValue(old, next)) continue;
    updates[field] = next;
    audit.push({ field, old: old ?? null, new: next ?? null, by: actor, at: now });
  }
  return { updates, audit };
}

async function fetchRunMatch() {
  try {
    const mod = await import("./invoice-bill-match.js");
    return typeof mod.runMatch === "function" ? mod.runMatch : null;
  } catch (_) {
    return null;
  }
}

async function maybeRematch(pool, invoiceId, correctionsApplied) {
  if (!correctionsApplied.some(c => REMATCH_FIELDS.has(c.field))) return null;
  const runMatch = await fetchRunMatch();
  if (!runMatch) return { attempted: false, reason: "runMatch_not_exported" };
  try {
    const result = await runMatch(pool, invoiceId);
    return {
      attempted: true,
      status: result?.status || result?.audit?.status || null,
      diff_amount: result?.audit?.diff_amount ?? null,
      result,
    };
  } catch (e) {
    return { attempted: true, error: e.message || "rematch_failed" };
  }
}

async function getDetails(pool, invoiceId) {
  const invoice = await getInvoice(pool, invoiceId);
  const audit = await latestAudit(pool, invoiceId);
  return { success: true, invoice, audit };
}

async function postConfirm(pool, body, user) {
  const invoiceId = body.invoice_id;
  assertInvoiceId(invoiceId);
  const action = text(body.action);
  if (action !== "confirm" && action !== "unconfirm") {
    return { success: false, error: "action_must_be_confirm_or_unconfirm" };
  }

  const actor = actorName(user);
  const client = await pool.connect();
  let row = null;
  let correctionsApplied = [];
  try {
    await client.query("BEGIN");
    const current = await getInvoice(client, invoiceId, true);
    const built = buildCorrections(current, body.corrections || {}, actor);
    correctionsApplied = built.audit;
    const merged = { ...current, ...built.updates };
    const missing = action === "confirm" ? validateConfirm(merged) : [];
    if (missing.length) {
      await client.query("ROLLBACK");
      return { success: false, error: "critical_fields_missing", missing };
    }

    const now = new Date().toISOString();
    const raw = rawObject(current.raw);
    const fieldCorrections = Array.isArray(raw.field_corrections) ? raw.field_corrections : [];
    const nextRaw = {
      ...raw,
      field_corrections: [...fieldCorrections, ...correctionsApplied],
      [action === "confirm" ? "critical_confirmed" : "critical_unconfirmed"]: { by: actor, at: now },
    };
    const fields = Object.keys(built.updates);
    const sets = fields.map((field, i) => `${field}=$${i + 2}`);
    const params = [invoiceId, ...fields.map(field => built.updates[field])];
    params.push(action === "confirm", JSON.stringify(nextRaw));
    const confirmedParam = params.length - 1;
    const rawParam = params.length;
    const q = await client.query(
      `UPDATE finance_invoices_in
          SET ${sets.length ? `${sets.join(", ")},` : ""}
              critical_fields_confirmed=$${confirmedParam},
              raw=$${rawParam}::jsonb,
              updated_at=NOW()
        WHERE id=$1
        RETURNING id, review_status, critical_fields_confirmed, payee_bank_name,
                  payee_bank_account, payee_account_currency_hint,
                  payment_currency_limit, receivable_fx_currency,
                  receivable_fx_amount, bl_nos, amount_incl_tax,
                  payment_ready_block_reason, raw`,
      params
    );
    row = q.rows[0];
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const rematch = action === "confirm" ? await maybeRematch(pool, invoiceId, correctionsApplied) : null;
  return {
    success: true,
    invoice_id: row.id,
    critical_fields_confirmed: row.critical_fields_confirmed,
    corrections_applied: correctionsApplied.map(c => c.field),
    rematch,
    invoice: row,
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
    if (req.method === "GET") return send(res, 200, await getDetails(pool, req.query?.invoice_id));
    if (req.method === "POST") return send(res, 200, await postConfirm(pool, req.body || {}, user));
    return send(res, 405, { success: false, error: "method_not_allowed" });
  } catch (e) {
    return send(res, e.status || 500, { success: false, error: e.message || "server_error" });
  }
}
