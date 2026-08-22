import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function send(res, status, body) {
  return res.status(status).json(body);
}

function text(v) {
  return String(v == null ? "" : v).trim();
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
  return text(user?.username) || text(user?.name) || text(user?.email) || text(user?.id) || "system";
}

function idList(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const id = text(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function listRows(pool, req) {
  const blNo = text(req.query?.bl_no);
  const status = text(req.query?.status) || "pending_review";
  const params = [];
  const where = ["b.supplement_source = 'forwarder_portal'"];
  if (blNo) {
    params.push(blNo);
    where.push(`BTRIM(COALESCE(b.bl_no,'')) = $${params.length}`);
  } else if (status) {
    params.push(status);
    where.push(`b.ap_status = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT b.id, b.supplier, b.bl_no, b.cost_category, b.amount, b.currency, b.qty, b.unit_price,
            b.ap_status, b.supplement_by, b.supplement_at, b.review_confirmed_by,
            b.review_confirmed_at, b.raw,
            sp.id AS plan_id, sp.pol, sp.pod, sp.etd, sp.forwarder_company_id
       FROM freight_supplier_bills b
       LEFT JOIN LATERAL (
         SELECT id, pol, pod, etd, forwarder_company_id
           FROM shipping_plans
          WHERE BTRIM(COALESCE(bl_no,'')) = BTRIM(COALESCE(b.bl_no,''))
          ORDER BY id DESC
          LIMIT 1
       ) sp ON TRUE
      WHERE ${where.join(" AND ")}
      ORDER BY b.supplement_at DESC NULLS LAST, b.created_at DESC NULLS LAST, b.id DESC`,
    params
  );
  return { success: true, rows };
}

async function affectedInvoices(pool, blNos) {
  const clean = Array.from(new Set((blNos || []).map(text).filter(Boolean)));
  if (!clean.length) return [];
  const { rows } = await pool.query(
    `SELECT id
       FROM finance_invoices_in
      WHERE bl_nos && $1::text[]
      ORDER BY id ASC`,
    [clean]
  );
  return rows.map(row => row.id);
}

async function updateOne(client, id, action, note, actor) {
  const review = {
    action,
    note: text(note) || null,
    by: actor,
    at: new Date().toISOString(),
  };
  const status = action === "confirm" ? "unpaid" : "rejected";
  const confirmedBy = action === "confirm" ? actor : null;
  const q = await client.query(
    `UPDATE freight_supplier_bills
        SET ap_status = $2,
            review_confirmed_by = COALESCE($3, review_confirmed_by),
            review_confirmed_at = CASE WHEN $3 IS NULL THEN review_confirmed_at ELSE NOW() END,
            raw = COALESCE(raw, '{}'::jsonb) || jsonb_build_object('review', $4::jsonb),
            updated_at = NOW()
      WHERE id = $1::uuid
        AND ap_status = 'pending_review'
        AND supplement_source = 'forwarder_portal'
      RETURNING id, bl_no, cost_category, amount, currency, ap_status`,
    [id, status, confirmedBy, JSON.stringify(review)]
  );
  if (!q.rows.length) return { id, success: false, error: "not_pending_forwarder_supplement" };
  return { success: true, bill: q.rows[0] };
}

async function reviewRows(pool, body, user) {
  const ids = idList(body.bill_ids);
  const action = text(body.action);
  if (!ids.length) return { success: false, error: "bill_ids_required" };
  if (action !== "confirm" && action !== "reject") return { success: false, error: "action_must_be_confirm_or_reject" };

  const actor = actorName(user);
  const client = await pool.connect();
  const results = [];
  try {
    await client.query("BEGIN");
    for (const id of ids) {
      results.push(await updateOne(client, id, action, body.note, actor));
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  const blNos = results.filter(r => r.success).map(r => r.bill.bl_no);
  const invoiceIds = await affectedInvoices(pool, blNos);
  return { success: true, action, results, affected_invoice_ids: invoiceIds, rematch: { attempted: false, reason: "runMatch_not_imported" } };
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
    if (req.method === "GET") return send(res, 200, await listRows(pool, req));
    if (req.method === "POST") return send(res, 200, await reviewRows(pool, req.body || {}, user));
    return send(res, 405, { success: false, error: "method_not_allowed" });
  } catch (e) {
    return send(res, e.status || 500, { success: false, error: e.message || "server_error" });
  }
}
