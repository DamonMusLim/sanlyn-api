// api/db/customs-collab.js
import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { cleanArray, cleanString } from "./factory-portal-utils.js";
import { readUploadPayload, validateFile, uploadToOss, insertFinanceInvoice } from "./factory-invoice-upload.js";
import { ocrInvoice } from "./factory-invoice-ocr.js";
import {
  actorId,
  ensureCustomsStatus,
  money,
  reconcileStatus,
  uploadedForCustoms,
  writeInvoiceEvent,
} from "./customs-collab-status.js";

export const config = { api: { bodyParser: false } };

const FINANCE_ROLES = new Set(["admin", "finance"]);
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 30;
const rateBuckets = new Map();

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function failClosed(res) {
  return json(res, 401, { error: "链接无效或已过期" });
}

function requireFinance(req, res) {
  if (!requireAuth(req, res)) return false;
  if (!FINANCE_ROLES.has(req.user?.role)) {
    res.status(403).json({ error: "Forbidden", message: "仅财务/管理员可操作" });
    return false;
  }
  return true;
}

function parseMonth(v) {
  const s = cleanString(v);
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12 ? s : null;
}

function addMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

function rangeFromQuery(q) {
  const now = new Date();
  const cur = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = parseMonth(q.from) || cur;
  const to = parseMonth(q.to) || from;
  if (from > to) return null;
  return { from, to, start: `${from}-01`, end: addMonth(to) };
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  return xf ? String(xf).split(",")[0].trim() : (req.socket?.remoteAddress || req.ip || "unknown");
}

function rateLimit(req, key) {
  const k = `${key || "-"}:${clientIp(req)}`;
  const now = Date.now();
  const hit = rateBuckets.get(k);
  if (!hit || now - hit.start > RATE_WINDOW_MS) {
    rateBuckets.set(k, { start: now, count: 1 });
    return true;
  }
  hit.count += 1;
  return hit.count <= RATE_MAX;
}

function normalizeSellerName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）【】\[\]{}《》<>]/g, "")
    .replace(/[·.,，。;；:：'"“”‘’_-]/g, "")
    .replace(/有限责任公司|股份有限公司|有限公司|公司|工厂|厂/g, "");
}

function sellerNameMatches(expected, actual) {
  const a = normalizeSellerName(expected);
  const b = normalizeSellerName(actual);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

async function getFactoryInfo(pool, code) {
  const r = await pool.query(
    `SELECT code, name_cn, name_en, factory_name FROM companies WHERE code=$1 LIMIT 1`,
    [code]
  );
  const row = r.rows[0];
  if (!row?.code) return { code, name: code };
  return { code: row.code, name: row.name_cn || row.factory_name || row.name_en || row.code };
}

async function resolveFactoryScope(pool, code) {
  if (!code) return null;
  const r = await pool.query(
    `SELECT code, scope_value
       FROM invoice_links
      WHERE code=$1
        AND purpose='portal'
        AND scope_type='factory'
        AND expires_at > NOW()
      LIMIT 1`,
    [code]
  );
  const link = r.rows[0];
  if (!link?.scope_value) return null;
  return { link, factory: await getFactoryInfo(pool, link.scope_value) };
}

async function resolveFactoryByMt(pool, mt) {
  if (!mt) return null;
  const hash = crypto.createHash("sha256").update(String(mt)).digest("hex");
  const r = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash=$1
        AND recipient_role='factory_booking'
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!r.rows.length) return null;
  let meta = r.rows[0].meta;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  const label = cleanString(meta?.factory_scope?.label);
  if (!label) return null;
  const c = await pool.query(
    `SELECT code, name_cn, factory_name, name_en
       FROM companies
      WHERE code=$1 OR name_cn ILIKE '%'||$1||'%' OR factory_name ILIKE '%'||$1||'%'
      ORDER BY CASE WHEN code=$1 THEN 0 WHEN name_cn=$1 THEN 1 WHEN factory_name=$1 THEN 2 ELSE 9 END, id ASC
      LIMIT 1`,
    [label]
  );
  const row = c.rows[0];
  if (!row?.code) return null;
  return { factory: { code: row.code, name: row.name_cn || row.factory_name || row.name_en || label } };
}

async function resolveFactory(req, pool) {
  const mt = cleanString(req.query?.mt || req.body?.mt);
  if (mt) return resolveFactoryByMt(pool, mt);
  return resolveFactoryScope(pool, cleanString(req.query?.c || req.body?.c));
}

async function assertFactoryCustoms(client, factoryCode, customsNo) {
  const st = await ensureCustomsStatus(client, customsNo, factoryCode);
  if (st.factory_code !== factoryCode) {
    const e = new Error("customs_no not in factory scope");
    e.status = 403;
    throw e;
  }
  return st;
}

function fileUrl(row) {
  const a = row.attachments;
  if (Array.isArray(a) && a[0]) return a[0].oss_url || a[0].url || null;
  if (a && typeof a === "object") return a.oss_url || a.url || null;
  return null;
}

export async function fetchRows(pool, opts) {
  const params = [opts.start, opts.end];
  const where = [`b.export_date >= $1::date`, `b.export_date < $2::date`];

  if (opts.factoryCode) {
    params.push(opts.factoryCode);
    where.push(`b.factory_code = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`COALESCE(s.status, CASE WHEN b.system_expected_amount IS NULL THEN 'need_amount' ELSE 'pending_confirm' END) = $${params.length}`);
  }
  if (opts.keyword) {
    params.push(`%${opts.keyword}%`);
    where.push(`(b.customs_no ILIKE $${params.length} OR b.contract_no ILIKE $${params.length})`);
  }

  const sql = `
    WITH ord AS (
      SELECT o.id AS order_id, o.order_no, o.contract_no, o.bl_no,
             COALESCE(o.factory_code, c_id.code,
               (SELECT p.factory_code FROM order_line_items x JOIN products p ON p.id=x.product_id
                 WHERE x.order_id=o.id AND p.factory_code IS NOT NULL LIMIT 1)) AS factory_code,
             COALESCE(c.name_cn, c.factory_name, c_id.name_cn, c_id.factory_name, o.factory) AS factory_name,
             o.created_at::date AS order_date,
             CASE WHEN o.order_no ILIKE '%-DG-%'
                  THEN (SELECT NULLIF(SUM(oli.declare_amount_per_box*oli.qty_ctn),0) FROM order_line_items oli WHERE oli.order_id=o.id)
                  ELSE NULL END AS declare_value,
             COALESCE((SELECT NULLIF(SUM(oli.factory_subtotal),0) FROM order_line_items oli WHERE oli.order_id=o.id),
                      NULLIF(o.total_amount_factory,0)) AS purchase_value,
             (SELECT NULLIF(SUM(oli.qty_ctn),0) FROM order_line_items oli WHERE oli.order_id=o.id) AS qty_oli
        FROM orders o
        LEFT JOIN companies c ON c.code=o.factory_code
        LEFT JOIN companies c_id ON c_id.id=o.factory_company_id
       WHERE (COALESCE(o.status,'') IN ('shipped','delivered','completed','closed','archived','done','received')
              OR COALESCE(o.bl_no,'') <> '')
         AND COALESCE(o.status,'') <> 'cancelled'
    ),
    fer_base AS (
      SELECT fer.customs_no,
             MAX(fer.contract_no) AS contract_no,
             MIN(fer.export_date) AS export_date,
             CASE WHEN COUNT(i.item)=0 THEN NULL
                  ELSE ROUND(SUM(NULLIF(i.item->>'amount','')::numeric), 2) END AS declare_amount,
             ROUND(SUM(NULLIF(i.item->>'qty2','')::numeric), 2) AS qty
        FROM finance_export_rebates fer
        LEFT JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(fer.raw->'items')='array' THEN fer.raw->'items' ELSE '[]'::jsonb END
        ) AS i(item) ON true
       GROUP BY fer.customs_no
    ),
    keyed AS (
      SELECT ord.*,
             f.customs_no AS real_customs_no,
             f.declare_amount AS fer_declare,
             f.qty AS fer_qty,
             f.export_date AS fer_export_date,
             COALESCE(f.customs_no, NULLIF(ord.bl_no,''), ord.order_no) AS decl_key
        FROM ord
        LEFT JOIN fer_base f ON f.contract_no=ord.contract_no
    ),
    b AS (
      SELECT
        decl_key AS customs_no,
        MAX(contract_no) AS contract_no,
        COALESCE(MIN(fer_export_date), MIN(order_date)) AS export_date,
        factory_code,
        MAX(factory_name) AS factory_name,
        STRING_AGG(DISTINCT order_no, ',' ORDER BY order_no) AS order_no,
        COALESCE(NULLIF(MAX(fer_qty),0), NULLIF(SUM(qty_oli),0)) AS qty,
        COALESCE(MAX(fer_declare), NULLIF(SUM(declare_value),0), NULLIF(SUM(purchase_value),0)) AS system_expected_amount,
        MAX(fer_declare) AS declare_amount
        FROM keyed
       GROUP BY factory_code, decl_key
    )
    SELECT b.customs_no, b.contract_no, b.export_date,
           to_char(b.export_date,'YYYY-MM') AS period,
           b.factory_code, b.factory_name, b.order_no, b.qty AS qty,
           CASE
             WHEN COALESCE(s.manual_expected_amount, b.system_expected_amount) IS NOT NULL
                  AND COALESCE(s.status,'need_amount')='need_amount' THEN 'pending_confirm'
             ELSE COALESCE(s.status, CASE WHEN b.system_expected_amount IS NULL THEN 'need_amount' ELSE 'pending_confirm' END)
           END AS status,
           b.system_expected_amount,
           b.declare_amount,
           s.manual_expected_amount,
           COALESCE(s.manual_expected_amount, b.system_expected_amount) AS effective_expected_amount,
           COALESCE(u.uploaded_amount,0) AS uploaded_amount,
           COALESCE(u.valid_invoice_count,0)::int AS valid_invoice_count,
           CASE WHEN COALESCE(s.manual_expected_amount, b.system_expected_amount) IS NULL
                THEN NULL
                ELSE ROUND(COALESCE(s.manual_expected_amount, b.system_expected_amount) - COALESCE(u.uploaded_amount,0), 2)
            END AS diff_amount,
           ev.created_at AS last_event_at
      FROM b
      LEFT JOIN customs_invoice_status s ON s.customs_no=b.customs_no
      LEFT JOIN LATERAL (
        SELECT SUM(fii.amount_incl_tax) AS uploaded_amount,
               COUNT(DISTINCT fii.id) AS valid_invoice_count
          FROM invoice_customs_links l
          JOIN finance_invoices_in fii ON fii.id=l.invoice_id
         WHERE l.customs_no=b.customs_no
           AND l.link_status='active'
           AND COALESCE(fii.review_status,'') NOT IN ('void','red_ink')
      ) u ON true
      LEFT JOIN invoice_events ev ON ev.id=s.last_event_id
     WHERE ${where.join(" AND ")}
     ORDER BY b.export_date DESC NULLS LAST, b.customs_no`;

  return (await pool.query(sql, params)).rows.map((r) => ({
    ...r,
    system_expected_amount: money(r.system_expected_amount),
    declare_amount: money(r.declare_amount),
    manual_expected_amount: money(r.manual_expected_amount),
    effective_expected_amount: money(r.effective_expected_amount),
    uploaded_amount: money(r.uploaded_amount) || 0,
    diff_amount: money(r.diff_amount),
    valid_invoice_count: Number(r.valid_invoice_count) || 0,
    order_no: r.order_no || null,
    qty: Number(r.qty) || null,
  }));
}

function summarize(rows) {
  const byStatus = {};
  let expected = 0, uploaded = 0, diff = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    expected += r.effective_expected_amount || 0;
    uploaded += r.uploaded_amount || 0;
    diff += r.diff_amount || 0;
  }
  return {
    customs_count: rows.length,
    ...byStatus,
    expected_amount: money(expected) || 0,
    uploaded_amount: money(uploaded) || 0,
    diff_amount: money(diff) || 0,
  };
}

async function handleList(req, res) {
  if (!requireFinance(req, res)) return;
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const rows = await fetchRows(getPool(), {
    ...range,
    factoryCode: cleanString(req.query.factory_code) || null,
    status: cleanString(req.query.status) || null,
    keyword: cleanString(req.query.keyword) || null,
  });
  return res.json({ success: true, period: { from: range.from, to: range.to }, summary: summarize(rows), rows });
}

function factoryRow(r) {
  return {
    customs_no: r.customs_no,
    contract_no: r.contract_no,
    export_date: r.export_date,
    period: r.period,
    factory_code: r.factory_code,
    factory_name: r.factory_name,
    status: r.status,
    expected_amount: r.effective_expected_amount,
    uploaded_amount: r.uploaded_amount,
    valid_invoice_count: r.valid_invoice_count,
    order_no: r.order_no,
    qty: r.qty,
    has_invoice: (r.valid_invoice_count || 0) > 0,
    diff_amount: r.diff_amount,
    last_event_at: r.last_event_at,
  };
}

async function handleFactoryList(req, res) {
  const pool = getPool();
  const scope = await resolveFactory(req, pool);
  if (!scope) return failClosed(res);
  if (!rateLimit(req, scope.factory.code)) return json(res, 429, { error: "请求过于频繁，请稍后再试" });

  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const rows = await fetchRows(pool, { ...range, factoryCode: scope.factory.code, status: cleanString(req.query.status), keyword: cleanString(req.query.keyword) });
  return res.json({
    success: true,
    factory: scope.factory,
    period: { from: range.from, to: range.to },
    summary: summarize(rows),
    rows: rows.map(factoryRow),
  });
}

async function handleConfirm(req, res) {
  const pool = getPool();
  let actorRole = "finance";
  let scope = null;

  if (cleanString(req.query?.c || req.body?.c || req.query?.mt || req.body?.mt)) {
    scope = await resolveFactory(req, pool);
    if (!scope) return failClosed(res);
    actorRole = "factory";
  } else if (!requireFinance(req, res)) {
    return;
  }

  const body = req.body || {};
  const customsNo = cleanString(body.customs_no || req.query.customs_no);
  if (!customsNo) return json(res, 400, { error: "customs_no required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const st = scope ? await assertFactoryCustoms(client, scope.factory.code, customsNo) : await ensureCustomsStatus(client, customsNo);
    const confirmedAmount = money(body.confirmed_amount);
    const event = await writeInvoiceEvent(client, {
      customs_no: customsNo,
      factory_code: st.factory_code,
      event_type: "confirm_amount",
      old_status: st.status,
      new_status: "confirmed_wait_invoice",
      reason: body.reason,
      payload: actorRole === "factory" && confirmedAmount !== null ? { factory_proposed: confirmedAmount } : {},
      created_by: actorRole === "factory" ? scope.factory.code : actorId(req),
      actor_role: actorRole,
    });
    await client.query(
      `UPDATE customs_invoice_status
          SET status='confirmed_wait_invoice',
              expected_amount_confirmed_at=NOW(),
              expected_amount_confirmed_by=$2,
              confirmed_by_role=$3,
              last_event_id=$4,
              updated_at=NOW()
        WHERE customs_no=$1`,
      [customsNo, actorRole === "factory" ? scope.factory.code : actorId(req), actorRole, event.id]
    );
    await client.query("COMMIT");
    return res.json({ success: true, customs_no: customsNo, status: "confirmed_wait_invoice", event_id: event.id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return json(res, e.status || 500, { error: e.message });
  } finally {
    client.release();
  }
}

async function handleUpload(req, res) {
  const pool = getPool();
  const scope = await resolveFactory(req, pool);
  if (!scope) return failClosed(res);
  if (!rateLimit(req, scope.factory.code)) return json(res, 429, { error: "请求过于频繁，请稍后再试" });

  const { fields, file } = await readUploadPayload(req);
  const err = validateFile(file);
  if (err) return json(res, 400, { error: err });

  const customsNo = cleanString(fields.customs_no || fields.customsNo);
  if (!customsNo) return json(res, 400, { error: "customs_no required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const st = await assertFactoryCustoms(client, scope.factory.code, customsNo);
    const upload = await uploadedForCustoms(client, customsNo);
    const expected = money(st.manual_expected_amount) ?? money(st.system_expected_amount);
    await client.query("COMMIT");

    const oss = await uploadToOss(scope.factory.code, "OCR_UPLOAD", file);
    let ocr = null, ocrError = null;
    try { ocr = await ocrInvoice(file); } catch (e) { ocrError = e; }

    const parsed = ocr?.parsed || {};
    const amountInclTax = money(parsed.amount_incl_tax);
    const sellerOcr = cleanString(parsed.seller_name);
    const sellerMismatch = !!sellerOcr && !sellerNameMatches(scope.factory.name, sellerOcr);

    let reviewStatus = "pending";
    let warning = "";
    let needsManualReview = false;
    if (!ocr || !parsed.invoice_no || amountInclTax === null) {
      reviewStatus = "ocr_failed"; needsManualReview = true; warning = "识别失败，已存档待人工录入";
    } else if (expected !== null && amountInclTax > expected + 1) {
      reviewStatus = "over_issued"; needsManualReview = true; warning = "金额超应开金额，请核实";
    } else if (expected !== null && amountInclTax + upload.uploaded_amount < expected - 1) {
      reviewStatus = "under_issued"; needsManualReview = true; warning = "金额低于应开金额，请核实";
    }
    if (sellerMismatch) {
      if (reviewStatus === "pending") reviewStatus = "seller_mismatch";
      needsManualReview = true;
      warning = warning ? `${warning}；卖方与工厂不一致，请核实` : "卖方与工厂不一致，请核实";
    }

    const attachments = [{ url: oss.url, key: oss.key, name: file.fileName, mime: file.mime, size: file.size, uploaded_at: new Date().toISOString() }];
    const invoiceNo = cleanString(parsed.invoice_no) || `OCR_PENDING_${Date.now()}`;

    await client.query("BEGIN");
    const invoiceId = await insertFinanceInvoice(client, {
      invoiceNo,
      invoiceCode: parsed.invoice_code,
      issueDate: parsed.issue_date,
      sellerName: parsed.seller_name || scope.factory.name,
      sellerTaxId: parsed.seller_tax_id || null,
      buyerName: parsed.buyer_name || null,
      buyerTaxId: parsed.buyer_tax_id || null,
      factoryCode: scope.factory.code,
      amountExTax: parsed.amount_ex_tax,
      totalTax: parsed.total_tax,
      amountInclTax,
      taxRate: Number.isFinite(parsed.tax_rate) ? parsed.tax_rate : null,
      contractNos: st.contract_no ? [st.contract_no] : [],
      customsNos: [customsNo],
      reviewStatus,
      attachments,
      lineItems: [],
      raw: {
        uploaded_from: "customs_collab",
        customs_no: customsNo,
        oss,
        file_name: file.fileName,
        ocr_model: "MiniMax-M3",
        ocr_raw: ocr?.rawText || null,
        ocr_parsed: sellerMismatch ? { ...parsed, seller_expected: scope.factory.name, seller_ocr: sellerOcr } : parsed,
        ocr_error: ocrError ? ocrError.message : null,
        target_amount_incl_tax: expected,
        needs_manual_review: needsManualReview,
        seller_mismatch: sellerMismatch,
      },
    });

    await client.query(
      `INSERT INTO invoice_customs_links
         (invoice_id, invoice_no, customs_no, factory_code, allocated_amount, link_status, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7)
       ON CONFLICT (invoice_id, customs_no) DO UPDATE SET
         invoice_no=EXCLUDED.invoice_no,
         factory_code=EXCLUDED.factory_code,
         allocated_amount=EXCLUDED.allocated_amount,
         link_status='active',
         reason=EXCLUDED.reason`,
      [invoiceId, invoiceNo, customsNo, scope.factory.code, amountInclTax, "factory_upload", scope.factory.code]
    );

    const ev = await writeInvoiceEvent(client, {
      invoice_id: invoiceId,
      invoice_no: invoiceNo,
      customs_no: customsNo,
      factory_code: scope.factory.code,
      event_type: "upload_invoice",
      new_status: reviewStatus,
      amount_incl_tax: amountInclTax,
      payload: { oss_url: oss.url, needs_manual_review: needsManualReview },
      created_by: scope.factory.code,
      actor_role: "factory",
    });
    const rec = await reconcileStatus(client, customsNo, { force: true });
    await client.query("COMMIT");

    return res.json({
      success: true,
      invoice_id: invoiceId,
      invoice_no: invoiceNo,
      review_status: reviewStatus,
      amount_incl_tax: amountInclTax,
      warning,
      needs_manual_review: needsManualReview,
      oss_url: oss.url,
      status: rec.status,
      event_id: ev.id,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return json(res, e.status || 500, { error: e.message });
  } finally {
    client.release();
  }
}

async function handleCorrection(req, res) {
  if (!requireFinance(req, res)) return;
  const body = req.body || {};
  const customsNo = cleanString(body.customs_no);
  const type = cleanString(body.correction_type);
  const reason = cleanString(body.reason);
  const invoiceId = body.invoice_id ? Number(body.invoice_id) : null;
  const valid = new Set(["void_invoice","red_ink_invoice","unbind_invoice","reopen","override_amount","review_match","review_mismatch","complete"]);
  if (!customsNo || !valid.has(type)) return json(res, 400, { error: "customs_no/correction_type invalid" });
  if (!reason && !["review_match","complete"].includes(type)) return json(res, 400, { error: "reason required" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const st = await ensureCustomsStatus(client, customsNo);
    let invoice = null;
    if (invoiceId) {
      const r = await client.query(`SELECT id, invoice_no, amount_incl_tax, review_status FROM finance_invoices_in WHERE id=$1 FOR UPDATE`, [invoiceId]);
      invoice = r.rows[0] || null;
      if (!invoice) throw new Error("invoice not found");
    }

    const payload = {};
    let newStatus = st.status;

    if (type === "override_amount") {
      const amt = money(body.manual_expected_amount);
      if (amt === null) return json(res, 400, { error: "manual_expected_amount required" });
      payload.old_manual_expected_amount = money(st.manual_expected_amount);
      payload.new_manual_expected_amount = amt;
      await client.query(
        `UPDATE customs_invoice_status
            SET manual_expected_amount=$2,
                expected_amount_source='manual',
                updated_at=NOW()
          WHERE customs_no=$1`,
        [customsNo, amt]
      );
    } else if (type === "void_invoice" || type === "red_ink_invoice") {
      if (!invoiceId) return json(res, 400, { error: "invoice_id required" });
      const status = type === "void_invoice" ? "void" : "red_ink";
      const linkStatus = type === "void_invoice" ? "inactive" : "red_ink";
      await client.query(`UPDATE finance_invoices_in SET review_status=$2, updated_at=NOW() WHERE id=$1`, [invoiceId, status]);
      await client.query(`UPDATE invoice_customs_links SET link_status=$3, reason=$4 WHERE invoice_id=$1 AND customs_no=$2`, [invoiceId, customsNo, linkStatus, reason]);
      newStatus = status;
    } else if (type === "unbind_invoice") {
      if (!invoiceId) return json(res, 400, { error: "invoice_id required" });
      await client.query(`UPDATE invoice_customs_links SET link_status='inactive', reason=$3 WHERE invoice_id=$1 AND customs_no=$2`, [invoiceId, customsNo, reason]);
      newStatus = "inactive";
    } else if (type === "review_match" || type === "review_mismatch") {
      if (!invoiceId) return json(res, 400, { error: "invoice_id required" });
      newStatus = type === "review_match" ? "matched" : "amount_mismatch";
      await client.query(`UPDATE finance_invoices_in SET review_status=$2, updated_at=NOW() WHERE id=$1`, [invoiceId, newStatus]);
    } else if (type === "reopen") {
      await client.query(`UPDATE customs_invoice_status SET status='confirmed_wait_invoice', updated_at=NOW() WHERE customs_no=$1`, [customsNo]);
      newStatus = "confirmed_wait_invoice";
    } else if (type === "complete") {
      await client.query(`UPDATE customs_invoice_status SET status='completed', updated_at=NOW() WHERE customs_no=$1`, [customsNo]);
      newStatus = "completed";
    }

    const ev = await writeInvoiceEvent(client, {
      invoice_id: invoiceId,
      invoice_no: invoice?.invoice_no,
      customs_no: customsNo,
      factory_code: st.factory_code,
      event_type: type,
      old_status: invoice?.review_status || st.status,
      new_status: newStatus,
      amount_incl_tax: invoice?.amount_incl_tax,
      reason,
      payload,
      created_by: actorId(req),
      actor_role: req.user?.role,
    });

    let rec = { status: newStatus };
    if (type !== "complete") rec = await reconcileStatus(client, customsNo, { force: true });
    await client.query("COMMIT");
    return res.json({ success: true, customs_no: customsNo, status: rec.status, event_id: ev.id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return json(res, e.message === "invoice not found" ? 404 : 500, { error: e.message });
  } finally {
    client.release();
  }
}

async function handleDetail(req, res) {
  const pool = getPool();
  const factoryMode = !!cleanString(req.query?.c || req.query?.mt);
  let scope = null;
  if (factoryMode) {
    scope = await resolveFactory(req, pool);
    if (!scope) return failClosed(res);
  } else if (!requireFinance(req, res)) {
    return;
  }

  const customsNo = cleanString(req.query.customs_no);
  if (!customsNo) return json(res, 400, { error: "customs_no required" });

  const client = await pool.connect();
  try {
    const st = factoryMode ? await assertFactoryCustoms(client, scope.factory.code, customsNo) : await ensureCustomsStatus(client, customsNo);
    const up = await uploadedForCustoms(client, customsNo);
    const effective = money(st.manual_expected_amount) ?? money(st.system_expected_amount);

    const fer = await client.query(
      `SELECT fer.customs_no, fer.contract_no, MIN(fer.export_date) AS export_date,
              jsonb_agg(item ORDER BY ord) FILTER (WHERE item IS NOT NULL) AS items
         FROM finance_export_rebates fer
         LEFT JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(fer.raw->'items')='array' THEN fer.raw->'items' ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS x(item, ord) ON true
        WHERE fer.customs_no=$1
        GROUP BY fer.customs_no, fer.contract_no`,
      [customsNo]
    );

    const inv = await client.query(
      `SELECT fii.id, fii.invoice_no, fii.issue_date, fii.amount_incl_tax,
              fii.review_status, l.link_status, fii.attachments
         FROM invoice_customs_links l
         JOIN finance_invoices_in fii ON fii.id=l.invoice_id
        WHERE l.customs_no=$1
        ORDER BY fii.issue_date DESC NULLS LAST, fii.id DESC`,
      [customsNo]
    );

    const ev = await client.query(
      `SELECT id, invoice_id, invoice_no, customs_no, factory_code, event_type,
              old_status, new_status, amount_incl_tax, reason, payload,
              created_by, actor_role, created_at
         FROM invoice_events
        WHERE customs_no=$1
        ORDER BY created_at ASC, id ASC`,
      [customsNo]
    );

    const row = fer.rows[0] || {};
    const rawItems = Array.isArray(row.items) ? row.items : [];
    const items = factoryMode
      ? rawItems.map((x) => ({ name_cn: x.name_cn || x.name || null, qty1: x.qty1 || null, qty2: x.qty2 || null }))
      : rawItems;

    let invoiceTemplate;
    if (factoryMode) {
      const contractNo = st.contract_no || row.contract_no || null;
      let orderResult = contractNo
        ? await client.query(
            `SELECT id, order_no, contract_no, issuing_company, company_code
               FROM orders
              WHERE contract_no=$1
                AND COALESCE(status,'') <> 'cancelled'
              ORDER BY id DESC
              LIMIT 1`,
            [contractNo]
          )
        : { rows: [] };
      if (!orderResult.rows[0]) {
        orderResult = await client.query(
          `SELECT id, order_no, contract_no, issuing_company, company_code
             FROM orders
            WHERE order_no=$1
              AND COALESCE(status,'') <> 'cancelled'
            ORDER BY id DESC
            LIMIT 1`,
          [customsNo]
        );
      }
      if (!orderResult.rows[0]) {
        orderResult = await client.query(
          `SELECT id, order_no, contract_no, issuing_company, company_code
             FROM orders
            WHERE bl_no=$1
              AND COALESCE(status,'') <> 'cancelled'
            ORDER BY id DESC
            LIMIT 1`,
          [customsNo]
        );
      }
      const order = orderResult.rows[0] || null;

      // 合并报关单: 该报关单/BL下同工厂的全部订单(合并开票,产品全列)
      let orderIds = order?.id ? [order.id] : [];
      let mergedOrderNos = order?.order_no || null;
      if (order) {
        const grpR = await client.query(
          `SELECT array_agg(o.id) AS ids, string_agg(o.order_no, ',' ORDER BY o.order_no) AS order_nos
             FROM orders o
            WHERE COALESCE(o.status,'') <> 'cancelled'
              AND (o.bl_no=$1 OR o.order_no=$1 OR o.contract_no=$2)
              AND ($3::text IS NULL OR COALESCE(o.factory_code,
                    (SELECT code FROM companies WHERE id=o.factory_company_id)) = $3)`,
          [customsNo, order.contract_no, factoryMode ? scope.factory.code : null]
        );
        if (grpR.rows[0]?.ids?.length) {
          orderIds = grpR.rows[0].ids;
          mergedOrderNos = grpR.rows[0].order_nos;
        }
      }

      let buyer = { name: null, tax_id: null };
      if (order) {
        const buyerKey = cleanString(order.issuing_company);
        const companyCode = cleanString(order.company_code);
        const buyerResult = await client.query(
          `SELECT name_cn, tax_id
             FROM companies
            WHERE ($1 <> '' AND (code=$1 OR name_cn=$1))
               OR ($2 <> '' AND code=$2)
            ORDER BY CASE
              WHEN $1 <> '' AND name_cn=$1 THEN 0
              WHEN $1 <> '' AND code=$1 THEN 1
              WHEN $2 <> '' AND code=$2 THEN 2
              ELSE 9
            END, id ASC
            LIMIT 1`,
          [buyerKey, companyCode]
        );
        const b = buyerResult.rows[0];
        buyer = { name: b?.name_cn || buyerKey || null, tax_id: b?.tax_id || null };
      }

      const sellerResult = await client.query(
        `SELECT name_cn, tax_id
           FROM companies
          WHERE code=$1
          LIMIT 1`,
        [st.factory_code]
      );
      const sellerRow = sellerResult.rows[0] || {};
      const seller = {
        name: sellerRow.name_cn || scope.factory.name || null,
        tax_id: sellerRow.tax_id || null,
      };

      const rawUnit = rawItems.find((x) => x?.unit2 || x?.transaction_unit || x?.unit)?.unit2
        || rawItems.find((x) => x?.unit2 || x?.transaction_unit || x?.unit)?.transaction_unit
        || rawItems.find((x) => x?.unit2 || x?.transaction_unit || x?.unit)?.unit
        || null;

      const lineResult = orderIds.length
        ? await client.query(
            `SELECT
                COALESCE(NULLIF(BTRIM(oli.declaration_name), ''),
                         NULLIF(BTRIM(oli.product_name), ''),
                         NULLIF(BTRIM(p.declaration_name), ''),
                         NULLIF(BTRIM(p.product_name), '')) AS name,
                COALESCE(NULLIF(BTRIM(p.spec), ''), NULLIF(BTRIM(oli.size), '')) AS spec,
                COALESCE(NULLIF(BTRIM(p.transaction_unit), ''), NULLIF($2, ''), NULLIF(BTRIM(oli.unit), ''), '箱') AS unit,
                ROUND(SUM(COALESCE(oli.qty_ctn, 0))::numeric, 2) AS qty,
                ROUND(SUM(COALESCE(oli.factory_subtotal, COALESCE(oli.qty_ctn, 0) * COALESCE(oli.factory_price, 0), 0))::numeric, 2) AS amount,
                CASE
                  WHEN COALESCE(NULLIF(BTRIM(oli.hs_code), ''), NULLIF(BTRIM(p.hs_code), '')) LIKE '2309%' THEN 0.09
                  ELSE 0.13
                END AS vat_rate
               FROM order_line_items oli
               LEFT JOIN products p ON p.id=oli.product_id
              WHERE oli.order_id = ANY($1::int[])
              GROUP BY
                COALESCE(NULLIF(BTRIM(oli.declaration_name), ''),
                         NULLIF(BTRIM(oli.product_name), ''),
                         NULLIF(BTRIM(p.declaration_name), ''),
                         NULLIF(BTRIM(p.product_name), '')),
                COALESCE(NULLIF(BTRIM(p.spec), ''), NULLIF(BTRIM(oli.size), '')),
                COALESCE(NULLIF(BTRIM(p.transaction_unit), ''), NULLIF($2, ''), NULLIF(BTRIM(oli.unit), ''), '箱'),
                CASE
                  WHEN COALESCE(NULLIF(BTRIM(oli.hs_code), ''), NULLIF(BTRIM(p.hs_code), '')) LIKE '2309%' THEN 0.09
                  ELSE 0.13
                END
              ORDER BY MIN(oli.sort_order) NULLS LAST, MIN(oli.id)`,
            [orderIds, rawUnit]
          )
        : { rows: [] };

      const unitMap = { CTN: "箱", PCS: "件", KG: "千克", BAG: "包", SET: "套" };
      const lines = lineResult.rows.map((l) => ({
        name: l.name || null,
        spec: l.spec || null,
        unit: unitMap[String(l.unit || "").toUpperCase()] || l.unit || "箱",
        qty: money(l.qty) || 0,
        amount: money(l.amount) || 0,
        vat_rate: Number(l.vat_rate) || 0.13,
      }));
      const linesTotal = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);

      invoiceTemplate = {
        buyer,
        seller,
        lines,
        order_no: mergedOrderNos || order?.order_no || null,
        total_incl: money(linesTotal) || effective || null,
      };
    }

    return res.json({
      success: true,
      factory: factoryMode ? scope.factory : undefined,
      customs: {
        customs_no: customsNo,
        contract_no: st.contract_no || row.contract_no || null,
        export_date: row.export_date || null,
        factory_code: st.factory_code,
        status: st.status,
        system_expected_amount: factoryMode ? undefined : money(st.system_expected_amount),
        manual_expected_amount: factoryMode ? undefined : money(st.manual_expected_amount),
        effective_expected_amount: effective,
        uploaded_amount: up.uploaded_amount,
        valid_invoice_count: up.valid_invoice_count,
        diff_amount: effective === null ? null : money(effective - up.uploaded_amount),
      },
      items,
      invoice_template: invoiceTemplate,
      invoices: inv.rows.map((r) => ({
        id: r.id,
        invoice_no: r.invoice_no,
        issue_date: r.issue_date,
        amount_incl_tax: money(r.amount_incl_tax),
        review_status: r.review_status,
        link_status: r.link_status,
        file_url: fileUrl(r),
      })),
      events: ev.rows,
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const action = cleanString(req.query?.action);
    if (req.method === "GET" && action === "list") return handleList(req, res);
    if (req.method === "GET" && action === "factory_list") return handleFactoryList(req, res);
    if (req.method === "GET" && action === "detail") return handleDetail(req, res);
    if (req.method === "POST" && action === "confirm") return handleConfirm(req, res);
    if (req.method === "POST" && action === "upload") return handleUpload(req, res);
    if (req.method === "POST" && action === "correction") return handleCorrection(req, res);
    return json(res, 404, { error: "unknown action" });
  } catch (err) {
    console.error("[customs-collab]", err);
    return json(res, 500, { error: "Internal server error", detail: err.message });
  }
}
