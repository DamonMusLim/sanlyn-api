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
function statusOf(expected, uploaded, invoiceCount, hasPending, inverted) {
  if (expected === null) return "pending_price";
  if (inverted) return "inverted";
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
  return { id: inv.id, invoice_no: inv.invoice_no, amount_incl_tax: money(inv.amount_incl_tax), review_status: inv.review_status, file_url: inv.file_url || null };
}
function invoiceTemplate(row, amount, qty) {
  const rate = Number(row.tax_rate) || 0.13;
  const ex = amount === null ? null : money(amount / (1 + rate));
  const tax = amount === null ? null : money(amount - ex);
  const name = cleanString(row.declaration_name) || "*宠物用品*猫砂";
  return { order_no: row.order_no,
    buyer: { name: row.buyer_name || "厦门巴匕进出口有限公司", tax_id: row.buyer_tax_id || "91350206MA34RW3852" },
    seller: { name: row.factory_name, tax_id: row.seller_tax_id || null, bank_name: row.seller_bank_name || null, bank_account: row.seller_bank_account || null },
    lines: [{ goods_name: name, spec: "", unit: "箱", qty_ctn: qty, unit_price_incl: qty > 0 && amount !== null ? money(amount / qty) : null, amount_incl_tax: amount, subtotal_ex: ex, tax_rate: rate, tax_amount: tax }],
    total_incl: amount, amount_ex: ex, tax_amount: tax };
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
      orders_detail: Array.isArray(r.orders_detail) ? r.orders_detail.map(o => ({ order_no: o.order_no, qty_ctn: money(o.qty_ctn) || 0, amount_incl_tax: money(o.amount_incl_tax), status: o.status })) : [],
      contracts_detail: Array.isArray(r.contracts_detail) ? r.contracts_detail.map(c => ({ contract_no: c.contract_no, qty_ctn: money(c.qty_ctn) || 0, amount_incl_tax: money(c.amount_incl_tax) })) : [],
      contract_count: Number(r.contract_count) || 0,
      invoice_count: Number(r.invoice_count) || 0,
      status: statusOf(expected, uploaded, Number(r.invoice_count) || 0, hasPending, r.has_inverted),
    };
    if (detail) {
      g.lines = (Array.isArray(r.lines) ? r.lines : []).map((l) => ({
        order_no: l.order_no, contract_no: l.contract_no, customs_no: l.customs_no, item_code: l.item_code, declaration_name: l.declaration_name,
        qty_ctn: money(l.qty_ctn) || 0, amount_incl_tax: money(l.amount_incl_tax), fob_cny: money(l.fob_cny), tax_rate: Number(l.tax_rate) || 0.13,
        invoices: Array.isArray(l.invoices) ? l.invoices.map(compactInvoice) : [], diff_amount: money(l.diff_amount),
        status: l.status || statusOf(money(l.amount_incl_tax), money(l.uploaded_amount) || 0, l.invoices?.length || 0, false, l.inverted), invoice_template: l.invoice_template || null }));
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
    factoryWhere = `AND factory_code = $${params.length}`;
  }
  const sql = `
    WITH range_rebates AS (
      SELECT contract_no, to_char(export_date,'YYYY-MM') AS period,
             array_agg(DISTINCT customs_no) FILTER (WHERE customs_no IS NOT NULL) AS customs_arr,
             SUM(COALESCE(fob_cny, 0)) AS fob_cny
        FROM finance_export_rebates
       WHERE export_date >= $1::date AND export_date < $2::date
       GROUP BY contract_no, to_char(export_date,'YYYY-MM')
    ),
    oli_order AS (
      SELECT order_id,
             SUM(factory_subtotal) AS fs_sum,
             SUM(COALESCE(qty_ctn, 0)) AS qty_ctn
             ,COUNT(*) AS oli_count
        FROM order_line_items GROUP BY order_id
    ),
    oli_sku AS (
      SELECT order_id,
             MIN(COALESCE(sku, product_id::text)) AS item_code,
             COALESCE(NULLIF(MAX(declaration_name), ''), '*宠物用品*猫砂') AS declaration_name,
             SUM(COALESCE(qty_ctn, 0)) AS qty_ctn,
             SUM(factory_subtotal) AS amount_incl_tax,
             0.13::numeric AS tax_rate
        FROM order_line_items GROUP BY order_id
    ),
    ord AS (
      SELECT o.id AS order_id, o.order_no, rr.contract_no, rr.period,
             COALESCE(o.factory_code, c_id.code,
               (SELECT p.factory_code FROM order_line_items x JOIN products p ON p.id=x.product_id
                 WHERE x.order_id=o.id AND p.factory_code IS NOT NULL LIMIT 1)) AS factory_code,
             COALESCE(c.name_cn, c.factory_name, c_id.name_cn, c_id.factory_name, o.factory) AS factory_name,
             oo.fs_sum AS expected_amount,
             COALESCE(oo.qty_ctn, 0) AS qty_ctn,
             COALESCE(oo.oli_count, 0) AS oli_count,
             rr.fob_cny,
             rr.customs_arr,
             COALESCE(bc.name_cn, NULLIF(o.issuing_company, ''), '厦门巴匕进出口有限公司') AS buyer_name,
             COALESCE(bc.tax_id, '91350206MA34RW3852') AS buyer_tax_id,
             COALESCE(c.tax_id, c_id.tax_id) AS seller_tax_id,
             COALESCE(c.bank_name, c_id.bank_name) AS seller_bank_name,
             COALESCE(c.bank_account, c_id.bank_account) AS seller_bank_account
        FROM range_rebates rr
        JOIN orders o ON o.contract_no = rr.contract_no AND COALESCE(o.status,'') <> 'cancelled'
        LEFT JOIN oli_order oo ON oo.order_id = o.id
        LEFT JOIN companies c ON c.code = o.factory_code
        LEFT JOIN companies c_id ON c_id.id = o.factory_company_id
        LEFT JOIN companies bc ON bc.name_cn = o.issuing_company OR bc.code = o.seller_code OR bc.id = o.seller_company_id
    ),
    ord_f AS (
      SELECT * FROM ord WHERE factory_code IS NOT NULL ${factoryWhere}
    ),
    ord_x AS (
      SELECT *,
             CASE WHEN oli_count > 0 AND COALESCE(expected_amount, 0) = 0 THEN 'pending_price'
                  WHEN expected_amount > 0 AND fob_cny > 0 AND expected_amount > fob_cny THEN 'inverted'
                  ELSE NULL END AS row_status
        FROM ord_f
    ),
    group_keys AS (
      SELECT period, factory_code, MAX(factory_name) AS factory_name,
             SUM(CASE WHEN row_status = 'pending_price' THEN NULL ELSE expected_amount END) AS expected_amount,
             SUM(qty_ctn) AS qty_ctn,
             COUNT(DISTINCT contract_no) AS contract_count,
             bool_or(row_status = 'inverted') AS has_inverted,
             array_agg(DISTINCT contract_no) AS contracts,
             array_agg(DISTINCT cu) FILTER (WHERE cu IS NOT NULL) AS customs
        FROM ord_x LEFT JOIN LATERAL unnest(ord_x.customs_arr) AS cu ON true
       GROUP BY period, factory_code
    )
    SELECT g.period, g.factory_code, g.factory_name, g.expected_amount, g.qty_ctn, g.contract_count,
           COALESCE(inv.uploaded_amount, 0) AS uploaded_amount,
           COALESCE(inv.invoice_count, 0) AS invoice_count,
           COALESCE(inv.invoices, '[]'::jsonb) AS invoices,
          COALESCE(lines.lines, '[]'::jsonb) AS lines,
           COALESCE(cdetail.contracts_detail, '[]'::jsonb) AS contracts_detail,
           COALESCE(odetail.orders_detail, '[]'::jsonb) AS orders_detail
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
           AND (COALESCE(fii.contract_nos::text[], '{}'::text[]) && g.contracts::text[]
             OR COALESCE(fii.customs_nos::text[], '{}'::text[]) && COALESCE(g.customs::text[], '{}'::text[]))
      ) inv ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'contract_no', d.contract_no, 'customs_no', d.customs_no,
          'order_no', d.order_no,
          'item_code', d.item_code, 'declaration_name', d.declaration_name,
          'qty_ctn', d.qty_ctn, 'amount_incl_tax', d.amount_incl_tax, 'fob_cny', d.fob_cny, 'tax_rate', d.tax_rate,
          'uploaded_amount', d.uploaded_amount, 'diff_amount', d.diff_amount, 'invoices', d.invoices,
          'status', d.row_status, 'inverted', d.inverted, 'buyer_name', d.buyer_name, 'buyer_tax_id', d.buyer_tax_id,
          'seller_tax_id', d.seller_tax_id, 'seller_bank_name', d.seller_bank_name, 'seller_bank_account', d.seller_bank_account,
          'invoice_template', d.invoice_template
        ) ORDER BY d.order_no) AS lines
        FROM (
          SELECT o2.order_no, o2.contract_no, array_to_string(o2.customs_arr, ',') AS customs_no,
                 s.item_code, s.declaration_name, s.qty_ctn,
                 CASE WHEN o2.row_status = 'pending_price' THEN NULL ELSE s.amount_incl_tax END AS amount_incl_tax,
                 o2.fob_cny, s.tax_rate,
                 COALESCE(inv2.uploaded_amount, 0) AS uploaded_amount,
                 CASE WHEN o2.row_status = 'pending_price' THEN NULL ELSE s.amount_incl_tax - COALESCE(inv2.uploaded_amount, 0) END AS diff_amount,
                 COALESCE(inv2.invoices, '[]'::jsonb) AS invoices,
                 o2.row_status, (o2.row_status = 'inverted') AS inverted,
                 o2.buyer_name, o2.buyer_tax_id, o2.seller_tax_id, o2.seller_bank_name, o2.seller_bank_account,
                 $json$__TPL__$json$ AS invoice_template
            FROM ord_x o2 JOIN oli_sku s ON s.order_id = o2.order_id
            LEFT JOIN LATERAL (
              SELECT SUM(fii.amount_incl_tax) AS uploaded_amount,
                     jsonb_agg(DISTINCT jsonb_build_object('id', fii.id, 'invoice_no', fii.invoice_no, 'amount_incl_tax', fii.amount_incl_tax, 'review_status', fii.review_status, 'file_url', NULL)) AS invoices
                FROM finance_invoices_in fii
               WHERE fii.seller_company_code = o2.factory_code
                 AND COALESCE(fii.review_status, '') NOT IN ('void', 'red_ink')
                 AND (COALESCE(fii.contract_nos::text[], '{}'::text[]) && ARRAY[o2.contract_no]::text[]
                   OR COALESCE(fii.customs_nos::text[], '{}'::text[]) && COALESCE(o2.customs_arr::text[], '{}'::text[]))
            ) inv2 ON true
           WHERE o2.period = g.period AND o2.factory_code = g.factory_code
        ) d
      ) lines ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'contract_no', cc.contract_no, 'qty_ctn', cc.q, 'amount_incl_tax', cc.amt
        ) ORDER BY cc.contract_no) AS contracts_detail
        FROM (
          SELECT contract_no, SUM(qty_ctn) AS q, SUM(expected_amount) AS amt
            FROM ord_x o3 WHERE o3.period = g.period AND o3.factory_code = g.factory_code
           GROUP BY contract_no
        ) cc
      ) cdetail ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'order_no', oo.order_no, 'qty_ctn', oo.qty_ctn,
          'amount_incl_tax', CASE WHEN oo.row_status='pending_price' THEN NULL ELSE oo.expected_amount END,
          'status', oo.row_status
        ) ORDER BY oo.order_no) AS orders_detail
        FROM ord_x oo WHERE oo.period = g.period AND oo.factory_code = g.factory_code
      ) odetail ON true
     ORDER BY g.period DESC, g.factory_name, g.factory_code`;
  const rows = (await pool.query(sql, params)).rows;
  for (const row of rows) {
    row.lines = (Array.isArray(row.lines) ? row.lines : []).map((l) => {
      const amount = money(l.amount_incl_tax);
      return { ...l, invoice_template: amount === null ? null : invoiceTemplate({ ...l, factory_name: row.factory_name }, amount, money(l.qty_ctn) || 0) };
    });
  }
  return rows;
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
    period: g.period, factory_code: g.factory_code, factory_name: g.factory_name,
    uploaded_amount: g.uploaded_amount, expected_amount: g.expected_amount, contracts_detail: g.contracts_detail || [], status: g.status === "inverted" ? "ok" : g.status,
    lines: (g.lines || []).map((l) => {
      const row = {
        period: g.period, order_no: l.order_no, item_code: l.item_code, declaration_name: l.declaration_name,
        qty_ctn: l.qty_ctn, tax_rate: l.tax_rate, status: l.status === "inverted" ? "ok" : l.status, invoice_template: l.invoice_template,
        uploaded: l.invoices.map((x) => ({ id: x.id, invoice_no: x.invoice_no, amount_incl_tax: x.amount_incl_tax, review_status: x.review_status, file_url: x.file_url })),
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
  const invoiceId = Number(body.invoice_id), action = cleanString(body.action);
  const valid = new Set(["match", "amount_mismatch", "void", "red_ink", "manual_adjust"]);
  if (!invoiceId || !valid.has(action)) return json(res, 400, { error: "invoice_id/action invalid" });
  const newStatus = action === "match" ? "matched" : action, client = await getPool().connect();
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
          SET review_status=$2, amount_incl_tax=CASE WHEN $3::boolean THEN $4::numeric ELSE amount_incl_tax END, updated_at=NOW()
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
      [invoiceId, old.invoice_no, old.seller_company_code, action, old.review_status, newStatus,
        upd.rows[0].amount_incl_tax, cleanString(body.reason) || null, JSON.stringify(body.payload || {}),
        req.user?.uid || req.user?.id || req.user?.account || null]
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
  const groups = normalizeGroups(rows, true).groups, out = [];
  if (scope === "internal") {
    out.push(["月份", "工厂代码", "工厂", "合同号", "报关单号", "SKU", "品名", "箱数", "应开含税", "已开金额", "差额", "税率", "状态", "发票号"]);
    for (const g of groups) for (const l of g.lines || [])
      out.push([g.period, g.factory_code, g.factory_name, l.contract_no, l.customs_no, l.item_code, l.declaration_name, l.qty_ctn, l.amount_incl_tax, l.invoices.reduce((s, x) => s + (x.amount_incl_tax || 0), 0), l.diff_amount, l.tax_rate, l.status, l.invoices.map((x) => x.invoice_no).join(";")]);
  } else {
    out.push(["月份", "合同号", "SKU品名", "箱数", "含税金额", "税率"]);
    for (const g of groups) for (const l of g.lines || [])
      out.push([g.period, l.contract_no, [l.item_code, l.declaration_name].filter(Boolean).join(" "), l.qty_ctn, l.amount_incl_tax ?? "", l.tax_rate]);
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
