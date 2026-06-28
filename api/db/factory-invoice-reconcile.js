// api/db/factory-invoice-reconcile.js
import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { cleanString } from "./factory-portal-utils.js";

const OK_ROLES = new Set(["admin", "finance"]);

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function requireFinance(req, res) {
  if (!requireAuth(req, res)) return false;
  if (!OK_ROLES.has(req.user?.role)) {
    res.status(403).json({ error: "Forbidden", message: "仅财务/管理员可见" });
    return false;
  }
  return true;
}

function parseMonth(v) {
  const s = cleanString(v);
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const [y, m] = s.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  return s;
}

function addMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}

function rangeFromQuery(q) {
  let from = parseMonth(q.from);
  let to = parseMonth(q.to);
  const months = cleanString(q.months);
  if (months && (!from || !to)) {
    const arr = months.split(/[,\s，;；]+/).map(parseMonth).filter(Boolean).sort();
    if (arr.length) {
      from = arr[0];
      to = arr[arr.length - 1];
    } else if (/^\d+$/.test(months)) {
      const n = Math.max(1, Math.min(24, Number(months)));
      const d = new Date();
      const end = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      d.setUTCMonth(d.getUTCMonth() - n + 1);
      from = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      to = end;
    }
  }
  if (!from && !to) {
    const d = new Date();
    from = to = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (!from || !to || from > to) return null;
  return { from, to, start: `${from}-01`, end: addMonth(to) };
}

function money(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function statusOf(expected, uploaded, invoiceCount, hasPending) {
  if (expected === null) return "need_amount";
  if (!invoiceCount || !uploaded) return "missing";
  const diff = expected - uploaded;
  if (Math.abs(diff) <= 1) return "matched";
  if (hasPending) return "pending";
  return "amount_mismatch";
}

async function resolveFactoryScope(pool, code) {
  if (!code) return null;
  const r = await pool.query(
    `SELECT code, scope_type, scope_value, expires_at
       FROM invoice_links
      WHERE code = $1
        AND purpose = 'portal'
        AND scope_type = 'factory'
        AND expires_at > NOW()
      LIMIT 1`,
    [code]
  );
  const link = r.rows[0];
  if (!link?.scope_value) return null;
  const c = await pool.query(
    `SELECT id, code, name_cn, factory_name
       FROM companies
      WHERE code = $1
      LIMIT 1`,
    [link.scope_value]
  );
  const row = c.rows[0];
  if (!row?.code) return null;
  return { factory: { code: row.code, name: row.name_cn || row.factory_name || row.code } };
}

async function resolveFactoryByMt(pool, mt) {
  if (!mt) return null;
  const hash = crypto.createHash("sha256").update(String(mt)).digest("hex");
  const r = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1 AND recipient_role = 'factory_booking'
        AND expires_at > NOW() AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!r.rows.length) return null;
  let meta = r.rows[0].meta;
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = {}; } }
  const label = String(meta?.factory_scope?.label || "").trim();
  if (!label) return null;
  const c = await pool.query(
    `SELECT code, name_cn, factory_name FROM companies
      WHERE code = $1 OR name_cn ILIKE '%'||$1||'%' OR factory_name ILIKE '%'||$1||'%'
      ORDER BY CASE WHEN code=$1 THEN 0 WHEN name_cn=$1 THEN 1 WHEN factory_name=$1 THEN 2 ELSE 9 END, id ASC
      LIMIT 1`,
    [label]
  );
  const row = c.rows[0];
  if (!row?.code) return null;
  return { factory: { code: row.code, name: row.name_cn || row.factory_name || label } };
}

async function resolveFactory(req, pool) {
  const mt = cleanString(req.query?.mt);
  if (mt) return resolveFactoryByMt(pool, mt);
  return resolveFactoryScope(pool, cleanString(req.query?.c));
}

function compactInvoice(inv) {
  return {
    id: inv.id,
    invoice_no: inv.invoice_no,
    amount_incl_tax: money(inv.amount_incl_tax),
    review_status: inv.review_status,
    file_url: inv.file_url || null,
  };
}

function normalizeGroups(rows, detail) {
  const groups = rows.map((r) => {
    const invoices = Array.isArray(r.invoices) ? r.invoices.map(compactInvoice) : [];
    const expected = money(r.expected_amount);
    const uploaded = money(r.uploaded_amount) || 0;
    const diff = expected === null ? null : money(expected - uploaded);
    const hasPending = invoices.some((x) => ["pending", "ocr_failed", "seller_mismatch", "over_issued", "under_issued"].includes(x.review_status));
    const g = {
      factory_code: r.factory_code,
      factory_name: r.factory_name,
      period: r.period,
      expected_amount: expected,
      uploaded_amount: uploaded,
      diff_amount: diff,
      qty_ctn: money(r.qty_ctn) || 0,
      contract_count: Number(r.contract_count) || 0,
      invoice_count: Number(r.invoice_count) || 0,
      status: statusOf(expected, uploaded, Number(r.invoice_count) || 0, hasPending),
    };
    if (detail) {
      g.lines = (Array.isArray(r.lines) ? r.lines : []).map((l) => ({
        contract_no: l.contract_no,
        customs_no: l.customs_no,
        item_code: l.item_code,
        declaration_name: l.declaration_name,
        qty_ctn: money(l.qty_ctn) || 0,
        amount_incl_tax: money(l.amount_incl_tax),
        tax_rate: Number(l.tax_rate) || 0.13,
        invoices: Array.isArray(l.invoices) ? l.invoices.map(compactInvoice) : [],
        diff_amount: money(l.diff_amount),
        status: statusOf(money(l.amount_incl_tax), money(l.uploaded_amount) || 0, l.invoices?.length || 0, false),
      }));
    }
    return g;
  });
  const summary = groups.reduce((s, g) => {
    s.expected_amount += g.expected_amount || 0;
    s.uploaded_amount += g.uploaded_amount || 0;
    s.factories.add(g.factory_code);
    s.contracts += g.contract_count;
    s.invoice_count += g.invoice_count;
    if (!["matched"].includes(g.status)) s.abnormal += 1;
    return s;
  }, { expected_amount: 0, uploaded_amount: 0, factories: new Set(), contracts: 0, invoice_count: 0, abnormal: 0 });
  summary.expected_amount = money(summary.expected_amount);
  summary.uploaded_amount = money(summary.uploaded_amount);
  summary.diff_amount = money(summary.expected_amount - summary.uploaded_amount);
  summary.factories = summary.factories.size;
  return { summary, groups };
}

async function fetchReconcile(pool, opts) {
  const params = [opts.start, opts.end];
  let factoryWhere = "";
  if (opts.factoryCode) {
    params.push(opts.factoryCode);
    factoryWhere = `AND COALESCE(o.factory_code, c_id.code, p.factory_code) = $${params.length}`;
  }

  const sql = `
    WITH fer_orders AS (
      SELECT DISTINCT
             to_char(fer.export_date, 'YYYY-MM') AS period,
             fer.customs_no, fer.contract_no, o.id AS order_id,
             COALESCE(o.factory_code, c_id.code, p.factory_code) AS factory_code,
             COALESCE(c.name_cn, c_id.name_cn, o.factory, COALESCE(o.factory_code, c_id.code, p.factory_code)) AS factory_name,
             o.total_amount_factory
        FROM finance_export_rebates fer
        JOIN orders o ON o.contract_no = fer.contract_no
        LEFT JOIN order_line_items oli0 ON oli0.order_id = o.id
        LEFT JOIN products p ON p.id = oli0.product_id
        LEFT JOIN companies c ON c.code = o.factory_code
        LEFT JOIN companies c_id ON c_id.id = o.factory_company_id
       WHERE fer.export_date >= $1::date
         AND fer.export_date < $2::date
         AND COALESCE(o.status, '') <> 'cancelled'
         ${factoryWhere}
    ),
    order_amounts AS (
      SELECT fo.period, fo.factory_code, MAX(fo.factory_name) AS factory_name,
             fo.contract_no, fo.order_id,
             array_agg(DISTINCT fo.customs_no) FILTER (WHERE fo.customs_no IS NOT NULL) AS customs_arr,
             COALESCE(NULLIF(SUM(oli.factory_subtotal), 0), MAX(fo.total_amount_factory)) AS expected_amount,
             SUM(COALESCE(oli.qty_ctn, 0)) AS qty_ctn
        FROM fer_orders fo
        LEFT JOIN order_line_items oli ON oli.order_id = fo.order_id
       GROUP BY fo.period, fo.factory_code, fo.contract_no, fo.order_id
    ),
    line_rows AS (
      SELECT oa.period, oa.factory_code, MAX(oa.factory_name) AS factory_name,
             oa.contract_no, oa.customs_arr,
             array_to_string(oa.customs_arr, ',') AS customs_no,
             COALESCE(oli.sku, oli.product_id::text) AS item_code,
             oli.declaration_name,
             CASE WHEN COALESCE(oli.hs_code, '') LIKE '2309%' THEN 0.09 ELSE 0.13 END AS tax_rate,
             SUM(COALESCE(oli.qty_ctn, 0)) AS qty_ctn,
             NULLIF(SUM(oli.factory_subtotal), 0) AS amount_incl_tax
        FROM order_amounts oa
        JOIN order_line_items oli ON oli.order_id = oa.order_id
       GROUP BY oa.period, oa.factory_code, oa.contract_no, oa.customs_arr,
                COALESCE(oli.sku, oli.product_id::text), oli.declaration_name,
                CASE WHEN COALESCE(oli.hs_code, '') LIKE '2309%' THEN 0.09 ELSE 0.13 END
    ),
    group_keys AS (
      SELECT period, factory_code, MAX(factory_name) AS factory_name,
             SUM(expected_amount) AS expected_amount,
             SUM(qty_ctn) AS qty_ctn,
             COUNT(DISTINCT contract_no) AS contract_count,
             array_agg(DISTINCT contract_no) AS contracts,
             array_agg(DISTINCT x.customs_no) FILTER (WHERE x.customs_no IS NOT NULL) AS customs
        FROM order_amounts oa
        LEFT JOIN LATERAL unnest(oa.customs_arr) AS x(customs_no) ON true
       GROUP BY period, factory_code
    )
    SELECT g.period, g.factory_code, g.factory_name, g.expected_amount, g.qty_ctn, g.contract_count,
           COALESCE(inv.uploaded_amount, 0) AS uploaded_amount,
           COALESCE(inv.invoice_count, 0) AS invoice_count,
           COALESCE(inv.invoices, '[]'::jsonb) AS invoices,
           COALESCE(lines.lines, '[]'::jsonb) AS lines
      FROM group_keys g
      LEFT JOIN LATERAL (
        SELECT SUM(fii.amount_incl_tax) AS uploaded_amount,
               COUNT(DISTINCT fii.id) AS invoice_count,
               jsonb_agg(DISTINCT jsonb_build_object(
                 'id', fii.id, 'invoice_no', fii.invoice_no,
                 'amount_incl_tax', fii.amount_incl_tax,
                 'review_status', fii.review_status,
                 'file_url', CASE
                   WHEN jsonb_typeof(fii.attachments)='array' THEN COALESCE(fii.attachments->0->>'oss_url', fii.attachments->0->>'url')
                   WHEN jsonb_typeof(fii.attachments)='object' THEN COALESCE(fii.attachments->>'oss_url', fii.attachments->>'url')
                   ELSE NULL END
               )) AS invoices
          FROM finance_invoices_in fii
         WHERE fii.seller_company_code = g.factory_code
           AND COALESCE(fii.review_status, '') NOT IN ('void', 'red_ink')
           AND (COALESCE(fii.contract_nos, '{}'::text[]) && g.contracts
             OR COALESCE(fii.customs_nos, '{}'::text[]) && COALESCE(g.customs, '{}'::text[]))
      ) inv ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'contract_no', l.contract_no,
          'customs_no', l.customs_no,
          'item_code', l.item_code,
          'declaration_name', l.declaration_name,
          'qty_ctn', l.qty_ctn,
          'amount_incl_tax', l.amount_incl_tax,
          'tax_rate', l.tax_rate,
          'uploaded_amount', COALESCE(li.uploaded_amount, 0),
          'diff_amount', CASE WHEN l.amount_incl_tax IS NULL THEN NULL ELSE l.amount_incl_tax - COALESCE(li.uploaded_amount, 0) END,
          'invoices', COALESCE(li.invoices, '[]'::jsonb)
        ) ORDER BY l.contract_no, l.item_code) AS lines
        FROM line_rows l
        LEFT JOIN LATERAL (
          SELECT SUM(fii.amount_incl_tax) AS uploaded_amount,
                 jsonb_agg(DISTINCT jsonb_build_object(
                   'id', fii.id, 'invoice_no', fii.invoice_no,
                   'amount_incl_tax', fii.amount_incl_tax,
                   'review_status', fii.review_status,
                   'file_url', CASE
                     WHEN jsonb_typeof(fii.attachments)='array' THEN COALESCE(fii.attachments->0->>'oss_url', fii.attachments->0->>'url')
                     WHEN jsonb_typeof(fii.attachments)='object' THEN COALESCE(fii.attachments->>'oss_url', fii.attachments->>'url')
                     ELSE NULL END
                 )) AS invoices
            FROM finance_invoices_in fii
           WHERE fii.seller_company_code = l.factory_code
             AND COALESCE(fii.review_status, '') NOT IN ('void', 'red_ink')
             AND (COALESCE(fii.contract_nos, '{}'::text[]) @> ARRAY[l.contract_no]::text[]
               OR COALESCE(fii.customs_nos, '{}'::text[]) && COALESCE(l.customs_arr, '{}'::text[]))
        ) li ON true
        WHERE l.period = g.period AND l.factory_code = g.factory_code
      ) lines ON true
     ORDER BY g.period DESC, g.factory_name, g.factory_code`;
  return (await pool.query(sql, params)).rows;
}

async function handleInternal(req, res) {
  if (!requireFinance(req, res)) return;
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const rows = await fetchReconcile(getPool(), {
    ...range,
    factoryCode: cleanString(req.query.factory_code) || null,
  });
  const data = normalizeGroups(rows, req.query.detail === "1");
  return res.json({ success: true, period: { from: range.from, to: range.to }, ...data });
}

function factoryVisible(groups) {
  return groups.map((g) => ({
    period: g.period,
    factory_code: g.factory_code,
    factory_name: g.factory_name,
    uploaded_amount: g.uploaded_amount,
    status: g.status,
    lines: (g.lines || []).map((l) => {
      const row = {
        period: g.period,
        contract_no: l.contract_no,
        item_code: l.item_code,
        declaration_name: l.declaration_name,
        qty_ctn: l.qty_ctn,
        tax_rate: l.tax_rate,
        uploaded: l.invoices.map((x) => ({
          id: x.id,
          invoice_no: x.invoice_no,
          amount_incl_tax: x.amount_incl_tax,
          review_status: x.review_status,
          file_url: x.file_url,
        })),
      };
      if (l.amount_incl_tax !== null) row.amount_incl_tax = l.amount_incl_tax;
      return row;
    }),
  }));
}

async function handleFactory(req, res) {
  const pool = getPool();
  const scope = await resolveFactory(req, pool);
  if (!scope) return json(res, 401, { error: "链接无效或已过期" });
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "months/from/to 月份格式应为 YYYY-MM" });
  const rows = await fetchReconcile(pool, { ...range, factoryCode: scope.factory.code });
  const data = normalizeGroups(rows, true);
  return res.json({
    success: true,
    factory: scope.factory,
    period: { from: range.from, to: range.to },
    groups: factoryVisible(data.groups),
  });
}

async function handleMark(req, res) {
  if (!requireFinance(req, res)) return;
  const body = req.body || {};
  const invoiceId = Number(body.invoice_id);
  const action = cleanString(body.action);
  const valid = new Set(["match", "amount_mismatch", "void", "red_ink", "manual_adjust"]);
  if (!invoiceId || !valid.has(action)) return json(res, 400, { error: "invoice_id/action invalid" });
  const newStatus = action === "match" ? "matched" : action;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const oldR = await client.query(
      `SELECT id, invoice_no, seller_company_code, review_status, amount_incl_tax
         FROM finance_invoices_in WHERE id=$1 FOR UPDATE`,
      [invoiceId]
    );
    const old = oldR.rows[0];
    if (!old) throw new Error("invoice not found");
    const hasAmount = Object.prototype.hasOwnProperty.call(body, "amount_incl_tax");
    const upd = await client.query(
      `UPDATE finance_invoices_in
          SET review_status=$2,
              amount_incl_tax=CASE WHEN $3::boolean THEN $4::numeric ELSE amount_incl_tax END,
              updated_at=NOW()
        WHERE id=$1
        RETURNING review_status, amount_incl_tax`,
      [invoiceId, newStatus, hasAmount, hasAmount ? body.amount_incl_tax : null]
    );
    const ev = await client.query(
      `INSERT INTO invoice_events
         (invoice_id, invoice_no, factory_code, event_type, old_status, new_status,
          amount_incl_tax, reason, payload, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING id`,
      [
        invoiceId, old.invoice_no, old.seller_company_code, action,
        old.review_status, newStatus, upd.rows[0].amount_incl_tax,
        cleanString(body.reason) || null,
        JSON.stringify(body.payload || {}),
        req.user?.uid || req.user?.id || req.user?.account || null,
      ]
    );
    await client.query("COMMIT");
    return res.json({ success: true, invoice_id: invoiceId, old_status: old.review_status, new_status: newStatus, event_id: ev.rows[0].id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return json(res, e.message === "invoice not found" ? 404 : 500, { error: e.message });
  } finally {
    client.release();
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, filename, rows) {
  const csv = "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
}

async function handleDownload(req, res) {
  const scope = cleanString(req.query.scope) || "internal";
  if ((cleanString(req.query.format) || "csv") !== "csv") return json(res, 400, { error: "today only csv" });
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });

  let factoryCode = cleanString(req.query.factory_code) || null;
  if (scope === "internal") {
    if (!requireFinance(req, res)) return;
  } else {
    const fac = await resolveFactory(req, getPool());
    if (!fac) return json(res, 401, { error: "链接无效或已过期" });
    factoryCode = fac.factory.code;
  }

  const rows = await fetchReconcile(getPool(), { ...range, factoryCode });
  const groups = normalizeGroups(rows, true).groups;
  const out = [];
  if (scope === "internal") {
    out.push(["月份", "工厂代码", "工厂", "合同号", "报关单号", "SKU", "品名", "箱数", "应开含税", "已开金额", "差额", "税率", "状态", "发票号"]);
    for (const g of groups) for (const l of g.lines || []) {
      out.push([g.period, g.factory_code, g.factory_name, l.contract_no, l.customs_no, l.item_code, l.declaration_name, l.qty_ctn, l.amount_incl_tax, l.invoices.reduce((s, x) => s + (x.amount_incl_tax || 0), 0), l.diff_amount, l.tax_rate, l.status, l.invoices.map((x) => x.invoice_no).join(";")]);
    }
  } else {
    out.push(["月份", "合同号", "SKU品名", "箱数", "含税金额", "税率"]);
    for (const g of groups) for (const l of g.lines || []) {
      out.push([g.period, l.contract_no, [l.item_code, l.declaration_name].filter(Boolean).join(" "), l.qty_ctn, l.amount_incl_tax ?? "", l.tax_rate]);
    }
  }
  return sendCsv(res, `factory-invoice-reconcile-${scope}-${range.from}-${range.to}.csv`, out);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const action = cleanString(req.query?.action);
    if (req.method === "GET" && action === "factory") return handleFactory(req, res);
    if (req.method === "GET" && action === "download") return handleDownload(req, res);
    if (req.method === "POST" && action === "mark") return handleMark(req, res);
    if (req.method === "GET") return handleInternal(req, res);
    return json(res, 405, { error: "Method not allowed" });
  } catch (e) {
    console.error("[factory-invoice-reconcile]", e);
    return json(res, 500, { error: "Internal server error", detail: e.message });
  }
}
