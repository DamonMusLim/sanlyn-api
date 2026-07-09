import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);
const VOID_STATUSES = ["void", "voided", "cancelled", "canceled", "red_ink", "red", "作废"];

export const SCAN_SQL = `
WITH fer_valid AS (
  SELECT BTRIM(contract_no) AS contract_no,
         NULLIF(BTRIM(customs_no), '') AS customs_no,
         NULLIF(BTRIM(currency), '') AS currency,
         fob_foreign,
         export_date
    FROM finance_export_rebates
   WHERE NULLIF(BTRIM(COALESCE(customs_no, '')), '') IS NOT NULL
     AND NULLIF(BTRIM(COALESCE(contract_no, '')), '') IS NOT NULL
     AND BTRIM(contract_no) <> '详见备注'
),
fer_group AS (
  SELECT contract_no,
         ARRAY_AGG(DISTINCT customs_no ORDER BY customs_no) AS customs_nos,
         ARRAY_AGG(DISTINCT currency) FILTER (WHERE currency IS NOT NULL) AS currencies,
         COUNT(DISTINCT currency) FILTER (WHERE currency IS NOT NULL) AS currency_count,
         COUNT(fob_foreign) AS fob_count,
         SUM(fob_foreign) AS fob_foreign_sum,
         MIN(export_date) AS first_export_date,
         COUNT(*)::int AS customs_row_count
    FROM fer_valid
   GROUP BY contract_no
),
order_active AS (
  SELECT BTRIM(contract_no) AS contract_no,
         STRING_AGG(DISTINCT order_no, ',' ORDER BY order_no) FILTER (WHERE order_no IS NOT NULL) AS order_nos,
         MIN(customer) AS customer,
         MIN(issuing_company) AS issuing_company,
         MIN(currency) AS order_currency,
         SUM(declare_amount) FILTER (WHERE declare_amount IS NOT NULL) AS declare_amount_sum,
         SUM(COALESCE(customer_total_amount, customer_amount, total_amount)) FILTER (
           WHERE COALESCE(customer_total_amount, customer_amount, total_amount) IS NOT NULL
         ) AS amount_order,
         MAX(email) FILTER (WHERE NULLIF(BTRIM(COALESCE(email, '')), '') IS NOT NULL) AS order_email
    FROM orders
   WHERE deleted_at IS NULL
     AND COALESCE(status, '') <> 'cancelled'
     AND NULLIF(BTRIM(COALESCE(contract_no, '')), '') IS NOT NULL
   GROUP BY BTRIM(contract_no)
),
company_match AS (
  SELECT oa.contract_no,
         MAX(c.tax_id) FILTER (WHERE NULLIF(BTRIM(COALESCE(c.tax_id, '')), '') IS NOT NULL) AS buyer_tax_id,
         MAX(c.einvoice_email) FILTER (WHERE NULLIF(BTRIM(COALESCE(c.einvoice_email, '')), '') IS NOT NULL) AS buyer_email
    FROM order_active oa
    LEFT JOIN companies c ON c.name_cn = oa.customer OR c.name_en = oa.customer
   GROUP BY oa.contract_no
),
candidate AS (
  SELECT fg.contract_no, oa.order_nos, fg.customs_nos,
         oa.customer AS buyer_name, cm.buyer_tax_id,
         COALESCE(cm.buyer_email, oa.order_email) AS buyer_email,
         oa.issuing_company AS seller_name, NULL::text AS seller_company_code,
         CASE WHEN fg.currency_count = 1 THEN fg.currencies[1] ELSE oa.order_currency END AS currency,
         oa.order_currency,
         CASE WHEN fg.fob_count > 0 AND fg.fob_count = fg.customs_row_count THEN fg.fob_foreign_sum ELSE oa.declare_amount_sum END AS amount_declared,
         oa.amount_order,
         fg.currency_count,
         fg.first_export_date,
         fg.customs_row_count,
         CASE
           WHEN EXISTS (
             SELECT 1 FROM finance_invoices_out fio
              WHERE COALESCE(fio.void_status, 'normal') <> ALL($1::text[])
                AND EXISTS (
                  SELECT 1 FROM unnest(COALESCE(fio.contract_nos, '{}'::text[])) inv_contract
                   WHERE BTRIM(inv_contract) = fg.contract_no
                )
           ) THEN 'already_invoiced'
           WHEN EXISTS (
             SELECT 1 FROM finance_invoice_drafts d
              WHERE d.contract_no = fg.contract_no AND d.status IN ('confirmed','issued')
           ) THEN 'locked_draft'
           ELSE NULL
         END AS skip_reason
    FROM fer_group fg
    JOIN order_active oa ON oa.contract_no = fg.contract_no
    LEFT JOIN company_match cm ON cm.contract_no = fg.contract_no
),
no_order AS (
  SELECT fg.contract_no, fg.customs_nos, 'no_order'::text AS reason
    FROM fer_group fg
    LEFT JOIN order_active oa ON oa.contract_no = fg.contract_no
   WHERE oa.contract_no IS NULL
),
invalid_contract AS (
  SELECT COALESCE(NULLIF(BTRIM(contract_no), ''), '<blank>') AS contract_no,
         ARRAY_AGG(NULLIF(BTRIM(customs_no), '')) FILTER (WHERE NULLIF(BTRIM(COALESCE(customs_no, '')), '') IS NOT NULL) AS customs_nos,
         CASE WHEN BTRIM(COALESCE(contract_no, '')) = '详见备注' THEN 'invalid_contract' ELSE 'blank_contract' END AS reason
    FROM finance_export_rebates
   WHERE NULLIF(BTRIM(COALESCE(customs_no, '')), '') IS NOT NULL
     AND (NULLIF(BTRIM(COALESCE(contract_no, '')), '') IS NULL OR BTRIM(contract_no) = '详见备注')
   GROUP BY COALESCE(NULLIF(BTRIM(contract_no), ''), '<blank>'),
            CASE WHEN BTRIM(COALESCE(contract_no, '')) = '详见备注' THEN 'invalid_contract' ELSE 'blank_contract' END
)
SELECT 'candidate' AS row_type, c.contract_no, c.order_nos, c.customs_nos,
       c.buyer_name, c.buyer_tax_id, c.buyer_email,
       c.seller_name, c.seller_company_code, c.currency,
       c.amount_declared, c.amount_order, c.currency_count,
       c.first_export_date, c.customs_row_count, c.skip_reason,
       ARRAY_REMOVE(ARRAY[
         CASE WHEN c.currency_count > 1 THEN 'currency_conflict' END,
         CASE WHEN c.amount_declared IS NULL THEN 'amount_declared' END,
         CASE WHEN NULLIF(BTRIM(COALESCE(c.buyer_email, '')), '') IS NULL THEN 'buyer_email' END,
         CASE WHEN c.currency_count <= 1 AND c.currency IS NOT NULL AND c.order_currency IS NOT NULL AND c.currency = c.order_currency
                   AND c.amount_declared IS NOT NULL AND c.amount_order IS NOT NULL
                   AND ABS(c.amount_declared - c.amount_order) > 1 THEN 'amount_mismatch_order' END
       ], NULL) AS missing,
       NULL::text AS reason
  FROM candidate c
UNION ALL
SELECT 'skipped' AS row_type, n.contract_no, NULL::text AS order_nos, n.customs_nos,
       NULL::text AS buyer_name, NULL::text AS buyer_tax_id, NULL::text AS buyer_email,
       NULL::text AS seller_name, NULL::text AS seller_company_code, NULL::text AS currency,
       NULL::numeric AS amount_declared, NULL::numeric AS amount_order,
       NULL::bigint AS currency_count, NULL::date AS first_export_date, NULL::int AS customs_row_count,
       n.reason AS skip_reason, ARRAY[]::text[] AS missing, n.reason AS reason
  FROM no_order n
UNION ALL
SELECT 'skipped' AS row_type, i.contract_no, NULL::text AS order_nos, i.customs_nos,
       NULL::text AS buyer_name, NULL::text AS buyer_tax_id, NULL::text AS buyer_email,
       NULL::text AS seller_name, NULL::text AS seller_company_code, NULL::text AS currency,
       NULL::numeric AS amount_declared, NULL::numeric AS amount_order,
       NULL::bigint AS currency_count, NULL::date AS first_export_date, NULL::int AS customs_row_count,
       i.reason AS skip_reason, ARRAY[]::text[] AS missing, i.reason AS reason
  FROM invalid_contract i
ORDER BY row_type, contract_no`;

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function actor(req) {
  return String(req.user?.username || req.user?.email || req.user?.uid || req.user?.id || "unknown");
}

function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function summarizeSkipped(rows) {
  const out = {};
  for (const row of rows) out[row.skip_reason || row.reason || "unknown"] = (out[row.skip_reason || row.reason || "unknown"] || 0) + 1;
  return out;
}

function draftFromScan(row, user) {
  const missing = row.missing || [];
  const blocking = missing.includes("amount_declared") || missing.includes("currency_conflict");
  return {
    contract_no: row.contract_no,
    order_nos: row.order_nos || null,
    customs_nos: row.customs_nos || [],
    buyer_name: row.buyer_name || null,
    buyer_tax_id: row.buyer_tax_id || null,
    buyer_email: row.buyer_email || null,
    seller_name: row.seller_name || null,
    seller_company_code: row.seller_company_code || null,
    currency: row.currency || null,
    amount_declared: money(row.amount_declared),
    amount_order: money(row.amount_order),
    amount_invoice: money(row.amount_declared),
    line_items: [{
      source: "finance_export_rebates",
      customs_nos: row.customs_nos || [],
      first_export_date: row.first_export_date || null,
      customs_row_count: Number(row.customs_row_count || 0),
    }],
    status: blocking ? "blocked" : "pending",
    missing,
    source: "p2-scan",
    created_by: user,
  };
}

async function loadScanRows(db) {
  const r = await db.query(SCAN_SQL, [VOID_STATUSES]);
  const candidateRows = r.rows.filter(row => row.row_type === "candidate");
  const skippedRows = r.rows.filter(row => row.row_type === "skipped" || row.skip_reason);
  return {
    candidates: candidateRows.filter(row => !row.skip_reason),
    skipped: skippedRows.map(row => ({
      contract_no: row.contract_no,
      customs_nos: row.customs_nos || [],
      reason: row.skip_reason || row.reason || "unknown",
    })),
  };
}

async function upsertDraft(db, draft) {
  const r = await db.query(
    `INSERT INTO finance_invoice_drafts
     (contract_no, order_nos, customs_nos, buyer_name, buyer_tax_id, buyer_email,
      seller_name, seller_company_code, currency, amount_declared, amount_order, amount_invoice,
      line_items, status, missing, source, created_by, updated_at)
     VALUES ($1,$2,$3::text[],$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16,$17,now())
     ON CONFLICT (contract_no) DO UPDATE SET
      order_nos=EXCLUDED.order_nos, customs_nos=EXCLUDED.customs_nos,
      buyer_name=EXCLUDED.buyer_name, buyer_tax_id=EXCLUDED.buyer_tax_id, buyer_email=EXCLUDED.buyer_email,
      seller_name=EXCLUDED.seller_name, seller_company_code=EXCLUDED.seller_company_code,
      currency=EXCLUDED.currency, amount_declared=EXCLUDED.amount_declared, amount_order=EXCLUDED.amount_order,
      amount_invoice=EXCLUDED.amount_invoice, line_items=EXCLUDED.line_items,
      status=EXCLUDED.status, missing=EXCLUDED.missing, source=EXCLUDED.source, updated_at=now()
     WHERE finance_invoice_drafts.status IN ('pending','blocked')
     RETURNING *`,
    [draft.contract_no, draft.order_nos, draft.customs_nos, draft.buyer_name, draft.buyer_tax_id, draft.buyer_email,
      draft.seller_name, draft.seller_company_code, draft.currency, draft.amount_declared, draft.amount_order,
      draft.amount_invoice, JSON.stringify(draft.line_items), draft.status, JSON.stringify(draft.missing),
      draft.source, draft.created_by]
  );
  return r.rows[0] || null;
}

async function handleScan(req, res) {
  const pool = getPool();
  const user = actor(req);
  const dryRun = Boolean(req.body?.dry_run);
  const scan = await loadScanRows(pool);
  const drafts = scan.candidates.map(row => draftFromScan(row, user));
  if (dryRun) return res.json({ success: true, dry_run: true, rows: drafts, skipped: scan.skipped, skipped_summary: summarizeSkipped(scan.skipped) });

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const written = [];
    for (const draft of drafts) {
      const row = await upsertDraft(db, draft);
      if (row) written.push(row);
    }
    await db.query("COMMIT");
    return res.json({ success: true, rows: written, scanned: drafts.length, written: written.length, skipped: scan.skipped, skipped_summary: summarizeSkipped(scan.skipped) });
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

async function handleList(req, res) {
  const args = [];
  let where = "";
  if (req.query?.status) {
    args.push(String(req.query.status));
    where = `WHERE status=$1`;
  }
  const r = await getPool().query(
    `SELECT *, COALESCE(jsonb_array_length(missing),0)::int AS missing_count
       FROM finance_invoice_drafts
       ${where}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 300`,
    args
  );
  return res.json({ success: true, rows: r.rows });
}

async function handleDetail(req, res) {
  const id = req.query?.id || req.body?.id;
  if (!id) return json(res, 400, { error: "id required" });
  const r = await getPool().query(`SELECT * FROM finance_invoice_drafts WHERE id=$1`, [id]);
  if (!r.rows[0]) return json(res, 404, { error: "draft not found" });
  return res.json({ success: true, draft: r.rows[0] });
}

async function handleConfirm(req, res) {
  const { id, buyer_name: buyerName, buyer_email: buyerEmail, amount_invoice: amountInvoice, remark } = req.body || {};
  if (!id) return json(res, 400, { error: "id required" });
  const explicitAmount = amountInvoice !== undefined && amountInvoice !== null && amountInvoice !== "";
  const invoiceAmount = explicitAmount ? money(amountInvoice) : null;
  if (explicitAmount && invoiceAmount === null) return json(res, 400, { error: "amount_invoice invalid" });
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const old = await db.query(`SELECT * FROM finance_invoice_drafts WHERE id=$1 FOR UPDATE`, [id]);
    const row = old.rows[0];
    if (!row) {
      await db.query("ROLLBACK");
      return json(res, 404, { error: "draft not found" });
    }
    if (!["pending", "blocked"].includes(row.status)) {
      await db.query("ROLLBACK");
      return json(res, 400, { error: "only pending/blocked drafts can be confirmed" });
    }
    if (row.amount_declared === null && !explicitAmount) {
      await db.query("ROLLBACK");
      return json(res, 400, { error: "报关金额缺失，先补料" });
    }
    const r = await db.query(
      `UPDATE finance_invoice_drafts SET
         buyer_name=COALESCE($2,buyer_name),
         buyer_email=COALESCE($3,buyer_email),
         amount_invoice=COALESCE($4,amount_invoice,amount_declared),
         remark=COALESCE($5,remark),
         status='confirmed', confirmed_by=$6, confirmed_at=now(), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, buyerName ?? null, buyerEmail ?? null, invoiceAmount, remark ?? null, actor(req)]
    );
    await db.query("COMMIT");
    return res.json({ success: true, draft: r.rows[0] });
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

async function handleCancel(req, res) {
  const { id, reason } = req.body || {};
  if (!id) return json(res, 400, { error: "id required" });
  if (!String(reason || "").trim()) return json(res, 400, { error: "reason required" });
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const r = await db.query(
      `UPDATE finance_invoice_drafts SET status='cancelled', cancelled_by=$2, cancelled_at=now(),
         cancel_reason=$3, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, actor(req), String(reason).trim()]
    );
    if (!r.rows[0]) {
      await db.query("ROLLBACK");
      return json(res, 404, { error: "draft not found" });
    }
    await db.query("COMMIT");
    return res.json({ success: true, draft: r.rows[0] });
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    if (!requireAuth(req, res)) return;
    if (!FINANCE_ROLES.has(req.user?.role)) return json(res, 403, { error: "Forbidden", message: "仅财务/管理员可操作" });
    const action = String(req.query?.action || "").trim();
    if (req.method === "POST" && action === "scan") return handleScan(req, res);
    if (req.method === "GET" && action === "list") return handleList(req, res);
    if (req.method === "GET" && action === "detail") return handleDetail(req, res);
    if (req.method === "POST" && action === "confirm") return handleConfirm(req, res);
    if (req.method === "POST" && action === "cancel") return handleCancel(req, res);
    return json(res, 404, { error: "unknown action" });
  } catch (err) {
    console.error("[invoice-drafts]", err);
    return json(res, 500, { error: "Internal server error", detail: err.message });
  }
}
