// api/db/factory-invoice-reconcile.js
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { cleanString } from "./factory-portal-utils.js";
import { fetchRows } from "./customs-collab.js";
import crypto from "crypto";

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
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function sumMoney(list, pick) {
  return money(list.reduce((s, x) => s + (money(pick(x)) || 0), 0)) || 0;
}

function gate(expected) {
  return Math.max((money(expected) || 0) * 0.05, 5000);
}

function rowStatus({ hasFer, rowExpected, uploaded }) {
  if (!hasFer) return "pending_customs";
  if (rowExpected === null) return "need_amount";
  if ((money(uploaded) || 0) === 0) return "missing";
  const diff = Math.abs(rowExpected - (money(uploaded) || 0));
  if (diff <= 1) return "matched";
  if (diff <= gate(rowExpected)) return "pending";
  return "amount_mismatch";
}

function groupStatus(expected, uploaded, anchoredCount) {
  if (!anchoredCount || expected === null) return "pending_customs";
  if (expected > 0 && (money(uploaded) || 0) === 0) return "missing";
  const diff = Math.abs(expected - (money(uploaded) || 0));
  if (diff <= 1) return "matched";
  if (diff <= gate(expected)) return "pending";
  return "amount_mismatch";
}

function settleLabel(status, labels = []) {
  const base = {
    settled: "已结算",
    unsettled: "待结算",
    untouched: "未动",
    abnormal: "异常",
    pending_customs: "待报关",
    need_amount: "金额待定",
  }[status] || status || "";
  return (status === "unsettled" || status === "untouched") && labels.length ? labels.join("·") : base;
}

function settleStatus({ hasFer = true, expected, uploaded, paid, anchoredCount = 1 }) {
  const up = money(uploaded) || 0;
  const pa = money(paid) || 0;
  if (!anchoredCount || !hasFer) return { settle_status: "pending_customs", settle_labels: [] };
  if (expected === null || expected === undefined) return { settle_status: "need_amount", settle_labels: [] };
  const ex = money(expected) || 0;
  if (up > ex + 1 || (up > 0 && Math.abs(ex - up) > gate(ex))) {
    return { settle_status: "abnormal", settle_labels: [] };
  }
  if (up >= ex - 1 && pa >= ex - 1) return { settle_status: "settled", settle_labels: [] };
  if (up === 0 && pa === 0) return { settle_status: "untouched", settle_labels: ["待开票", "待付款"] };
  const labels = [];
  if (up < ex - 1) labels.push("待开票");
  if (pa < ex - 1) labels.push("待付款");
  return { settle_status: "unsettled", settle_labels: labels };
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

async function fetchFerSet(pool, keys) {
  if (!keys.length) return new Set();
  const r = await pool.query(
    `SELECT DISTINCT customs_no FROM finance_export_rebates WHERE customs_no = ANY($1)`,
    [keys]
  );
  return new Set(r.rows.map((x) => x.customs_no).filter(Boolean));
}

async function fetchInvoices(pool, keys) {
  if (!keys.length) return new Map();
  const r = await pool.query(
    `SELECT l.customs_no,
            jsonb_agg(jsonb_build_object(
              'id', fii.id,
              'invoice_no', fii.invoice_no,
              'amount_incl_tax', fii.amount_incl_tax,
              'review_status', fii.review_status,
              'file_url', CASE
                WHEN jsonb_typeof(fii.attachments)='array'
                  THEN COALESCE(fii.attachments->0->>'oss_url', fii.attachments->0->>'url')
                WHEN jsonb_typeof(fii.attachments)='object'
                  THEN COALESCE(fii.attachments->>'oss_url', fii.attachments->>'url')
                ELSE NULL END
            ) ORDER BY fii.invoice_no NULLS LAST, fii.id) AS invoices
       FROM invoice_customs_links l
       JOIN finance_invoices_in fii ON fii.id = l.invoice_id
      WHERE l.customs_no = ANY($1)
        AND l.link_status = 'active'
        AND COALESCE(fii.review_status,'') NOT IN ('void','red_ink')
      GROUP BY l.customs_no`,
    [keys]
  );
  return new Map(r.rows.map((x) => [
    x.customs_no,
    (Array.isArray(x.invoices) ? x.invoices : []).map(compactInvoice),
  ]));
}

function normalizeRow(r, ferSet, invoiceMap) {
  const customsNo = cleanString(r.customs_no);
  const hasFer = ferSet.has(customsNo);
  const manual = money(r.manual_expected_amount);
  const declare = money(r.declare_amount);
  const anchored = hasFer && (manual ?? declare) !== null;
  const rowExpected = anchored ? (manual ?? declare) : null;
  const uploaded = money(r.uploaded_amount) || 0;
  const invoices = invoiceMap.get(customsNo) || [];
  const anchorSource = anchored ? (manual !== null ? "manual" : (declare !== null ? "declare" : null)) : null;
  const paid = money(r.paid_amount) || 0;
  const settle = settleStatus({ hasFer, expected: rowExpected, uploaded, paid });
  return {
    customs_no: customsNo || null,
    contract_no: r.contract_no || null,
    order_nos: r.order_nos || r.order_no || null,
    qty_ctn: money(r.qty) || 0,
    amount_incl_tax: rowExpected,
    declare_amount: declare,
    manual_expected_amount: manual,
    anchor_source: anchorSource,
    anchored,
    uploaded_amount: uploaded,
    diff_amount: rowExpected === null ? null : money(rowExpected - uploaded),
    invoices,
    status: rowStatus({ hasFer, rowExpected, uploaded }),
    ...settle,
    paid_amount: paid,
    slip_count: Number(r.slip_count) || 0,
  };
}

function groupRows(rows, ferSet, invoiceMap) {
  const map = new Map();
  for (const r of rows) {
    const period = r.period || (r.export_date ? String(r.export_date).slice(0, 7) : "");
    const key = `${r.factory_code || ""}\t${period}`;
    if (!map.has(key)) {
      map.set(key, {
        factory_code: r.factory_code || null,
        factory_name: r.factory_name || r.factory_code || "",
        period,
        lines: [],
      });
    }
    map.get(key).lines.push(normalizeRow(r, ferSet, invoiceMap));
  }
  const groups = [...map.values()].map((g) => {
    const anchored = g.lines.filter((l) => l.anchored);
    const expected = anchored.length ? sumMoney(anchored, (l) => l.amount_incl_tax) : null;
    const uploaded = sumMoney(g.lines, (l) => l.uploaded_amount);
    const paid = sumMoney(g.lines, (l) => l.paid_amount);
    const invoiceIds = new Set(g.lines.flatMap((l) => l.invoices.map((x) => x.id).filter(Boolean)));
    const pendingCustomsCount = g.lines.filter((l) => l.status === "pending_customs").length;
    const settle = settleStatus({ expected, uploaded, paid, anchoredCount: anchored.length });
    return {
      ...g,
      expected_amount: expected,
      uploaded_amount: uploaded,
      diff_amount: expected === null ? null : money(expected - uploaded),
      qty_ctn: sumMoney(g.lines, (l) => l.qty_ctn),
      invoice_count: invoiceIds.size || g.lines.reduce((s, l) => s + (l.invoices.length || 0), 0),
      paid_amount: paid,
      slip_count: g.lines.reduce((s, l) => s + (Number(l.slip_count) || 0), 0),
      anchored_count: anchored.length,
      pending_customs_count: pendingCustomsCount,
      need_amount_count: g.lines.filter((l) => l.status === "need_amount").length,
      status: groupStatus(expected, uploaded, anchored.length),
      ...settle,
    };
  });
  groups.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(a.factory_name).localeCompare(String(b.factory_name)));
  const summary = groups.reduce((s, g) => {
    s.expected_amount += g.expected_amount || 0;
    s.uploaded_amount += g.uploaded_amount || 0;
    s.paid_amount += g.paid_amount || 0;
    s.factories.add(g.factory_code);
    s.invoice_count += g.invoice_count || 0;
    s.pending_customs_rows += g.pending_customs_count || 0;
    if (g.settle_status === "settled") s.settled += 1;
    if (g.settle_status === "unsettled") s.unsettled += 1;
    if (g.settle_status === "untouched") s.untouched += 1;
    if (g.settle_status === "abnormal") s.abnormal += 1;
    return s;
  }, {
    expected_amount: 0, uploaded_amount: 0, paid_amount: 0, factories: new Set(),
    invoice_count: 0, abnormal: 0, pending_customs_rows: 0, settled: 0, unsettled: 0, untouched: 0,
  });
  summary.expected_amount = money(summary.expected_amount) || 0;
  summary.uploaded_amount = money(summary.uploaded_amount) || 0;
  summary.paid_amount = money(summary.paid_amount) || 0;
  summary.diff_amount = money(summary.expected_amount - summary.uploaded_amount);
  summary.factories = [...summary.factories].filter(Boolean).length;
  return { summary, groups };
}

async function loadData(pool, range, factoryCode) {
  const rows = await fetchRows(pool, { ...range, factoryCode });
  const keys = [...new Set(rows.map((r) => cleanString(r.customs_no)).filter(Boolean))];
  const [ferSet, invoiceMap] = await Promise.all([fetchFerSet(pool, keys), fetchInvoices(pool, keys)]);
  return groupRows(rows, ferSet, invoiceMap);
}

async function handleInternal(req, res) {
  if (!requireFinance(req, res)) return;
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const data = await loadData(getPool(), range, cleanString(req.query.factory_code) || null);
  return res.json({ success: true, period: { from: range.from, to: range.to }, ...data });
}

async function handlePortalLink(req, res) {
  if (!requireFinance(req, res)) return;
  const factoryCode = cleanString(req.query.factory_code);
  if (!factoryCode) return json(res, 400, { error: "factory_code required" });
  const pool = getPool();
  const found = await pool.query(
    `SELECT code, expires_at
       FROM invoice_links
      WHERE purpose='portal' AND scope_type='factory' AND scope_value=$1 AND expires_at > NOW()
      ORDER BY expires_at DESC LIMIT 1`,
    [factoryCode]
  );
  let row = found.rows[0];
  if (!row) {
    const prefix = (factoryCode.match(/[a-z]/ig) || []).join("").toLowerCase().slice(0, 2) || "fx";
    const code = `${prefix}${crypto.randomBytes(6).toString("hex")}`;
    const createdBy = req.user?.uid || req.user?.account || "reconcile";
    const ins = await pool.query(
      `INSERT INTO invoice_links
         (code,purpose,scope_type,scope_value,order_no,expires_at,created_by,created_at)
       VALUES ($1,'portal','factory',$2,'',NOW()+interval '1 year',$3,NOW())
       RETURNING code, expires_at`,
      [code, factoryCode, createdBy]
    );
    row = ins.rows[0];
  }
  return res.json({
    success: true,
    code: row.code,
    path: `/public/customs-collab-factory.html?c=${row.code}`,
    expires_at: row.expires_at,
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
  if (!requireFinance(req, res)) return;
  const scope = cleanString(req.query.scope) || "internal";
  if ((cleanString(req.query.format) || "csv") !== "csv") return json(res, 400, { error: "today only csv" });
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const factoryCode = cleanString(req.query.factory_code) || null;
  const { groups } = await loadData(getPool(), range, factoryCode);
  const out = [["月份", "工厂代码", "工厂", "报关单号", "合同号", "订单号", "箱数", "应开(锚定)", "已开", "已付", "差额", "状态", "锚定源", "发票号", "结算状态"]];
  for (const g of groups) {
    for (const l of g.lines || []) {
      out.push([
        g.period, g.factory_code, g.factory_name, l.customs_no, l.contract_no, l.order_nos,
        l.qty_ctn, l.amount_incl_tax ?? "",
        l.uploaded_amount, l.paid_amount, l.diff_amount ?? "", l.status, l.anchor_source || "",
        l.invoices.map((x) => x.invoice_no).filter(Boolean).join(";"),
        settleLabel(l.settle_status, l.settle_labels),
      ]);
    }
  }
  return sendCsv(res, `factory-invoice-reconcile-${scope}-${range.from}-${range.to}.csv`, out);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const action = cleanString(req.query?.action);
    if (req.method === "GET" && action === "factory") {
      return json(res, 410, { error: "此工厂端已迁移至报关单开票协同(customs-collab)工厂页" });
    }
    if (req.method === "GET" && action === "download") return handleDownload(req, res);
    if (req.method === "GET" && action === "portal_link") return handlePortalLink(req, res);
    if (req.method === "POST" && action === "mark") return handleMark(req, res);
    if (req.method === "GET") return handleInternal(req, res);
    return json(res, 405, { error: "Method not allowed" });
  } catch (e) {
    console.error("[factory-invoice-reconcile]", e);
    return json(res, 500, { error: "Internal server error", detail: e.message });
  }
}
