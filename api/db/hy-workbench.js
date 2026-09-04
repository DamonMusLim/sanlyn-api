import { requireAuth } from "../auth.js";
import { getPool, setCors } from "../db.js";

const VERSION = "v2026.09.05-1";
const LIMIT = 80;
const NEED_BILL_COLS = ["id", "supplier", "bl_no", "cost_category", "amount", "currency", "bill_month", "ar_paid_at", "ap_paid_at"];

function clean(v, max = 160) {
  return String(v ?? "").trim().slice(0, max);
}

function ymd(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(clean(v, 20)) ? clean(v, 20) : "";
}

function range(q) {
  const now = new Date();
  const d = (days) => {
    const x = new Date(now);
    x.setUTCDate(x.getUTCDate() + days);
    return x.toISOString().slice(0, 10);
  };
  return { from: ymd(q?.from) || d(-60), to: ymd(q?.to) || d(30) };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function ident(v) {
  return '"' + String(v).replace(/"/g, '""') + '"';
}

async function tableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(r.rows[0]?.name);
}

async function columns(pool, table) {
  if (!(await tableExists(pool, table))) return new Set();
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function todo(type, time, title, party, url, id, extra = {}) {
  return { id: `${type}:${id || title}`, type, time: time || null, title, party: party || "未接入", url, ...extra };
}

async function mailDraftTodos(pool, rg) {
  const cols = await columns(pool, "mail_outbox");
  if (!cols.has("status")) return { rows: [], note: "未接入: 缺 mail_outbox.status" };
  const dateCol = cols.has("prepared_at") ? "prepared_at" : cols.has("created_at") ? "created_at" : "";
  const party = cols.has("to_emails") ? "to_emails::text" : cols.has("sender_key") ? "sender_key::text" : "NULL";
  const where = ["status='draft'"];
  const args = [];
  if (dateCol) {
    args.push(rg.from, rg.to);
    where.push(`${dateCol} >= $1::date AND ${dateCol} < ($2::date + interval '1 day')`);
  }
  const r = await pool.query(
    `SELECT id::text, ${dateCol ? `to_char(${dateCol},'YYYY-MM-DD')` : "NULL"} AS time, ${party} AS party
       FROM mail_outbox WHERE ${where.join(" AND ")}
      ORDER BY ${dateCol ? dateCol + " DESC NULLS LAST," : ""} id DESC LIMIT ${LIMIT}`,
    args
  );
  return { rows: r.rows.map((x) => todo("邮件", x.time, "待发邮件", x.party, "/hy/mail.html#draft", x.id)) };
}

async function replyTodos(req, rg) {
  const host = req.headers.host;
  if (!host) return { rows: [], note: "未接入: 缺请求 host, 无法读取 /api/db/mail-replies" };
  try {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const url = `${proto}://${host}/api/db/mail-replies`;
    const r = await fetch(url, { headers: { authorization: req.headers.authorization || "" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { rows: [], note: `未接入: mail-replies ${j.error || r.status}` };
    const from = new Date(rg.from + "T00:00:00Z").getTime();
    const to = new Date(rg.to + "T23:59:59Z").getTime();
    const rows = [];
    for (const item of Array.isArray(j.data) ? j.data : []) {
      const t = item.sent_at ? new Date(item.sent_at).getTime() : null;
      if (t && (t < from || t > to)) continue;
      for (const p of Array.isArray(item.parties) ? item.parties : []) {
        if (Number(p.party_pending_count ?? (p.replied === false ? 1 : 0)) <= 0 && p.replied !== false) continue;
        rows.push(todo("邮件", item.sent_at ? String(item.sent_at).slice(0, 10) : null, "等回复", p.party_label, "/hy/mail.html#reply", `${item.outbox_id}:${p.party_key}`));
      }
    }
    return { rows: rows.slice(0, LIMIT), note: j.upstream_ok ? null : `未接入: ${j.upstream_error || "reply_index_unavailable"}` };
  } catch (err) {
    return { rows: [], note: `未接入: mail-replies 读取失败 ${err.message}` };
  }
}

async function arTodos(pool) {
  if (!(await tableExists(pool, "v_ar_aging"))) return { rows: [], summary: { overdue_total: null, nodate_total: null }, note: "未接入: 缺 v_ar_aging" };
  const r = await pool.query(
    `SELECT settle_party, ccy, bucket_older, bucket_nodate, rows_cnt
       FROM v_ar_aging
      WHERE COALESCE(bucket_older,0) <> 0 OR COALESCE(bucket_nodate,0) <> 0
      ORDER BY COALESCE(bucket_older,0) DESC NULLS LAST LIMIT ${LIMIT}`
  );
  let overdue = 0, nodate = 0;
  const rows = [];
  for (const x of r.rows) {
    const oldAmt = num(x.bucket_older);
    const nodateAmt = num(x.bucket_nodate);
    if (oldAmt) {
      overdue += oldAmt;
      rows.push(todo("催款", null, `真超期 ${x.ccy || ""} ${oldAmt}`, x.settle_party, "/hy/grid.html?module=v_ar_aging", `${x.settle_party}:old`, { amount: oldAmt, ccy: x.ccy || null }));
    }
    if (nodateAmt) {
      nodate += nodateAmt;
      rows.push(todo("催款", null, `无账期日期·未纳入 ${x.ccy || ""} ${nodateAmt}`, x.settle_party, "/hy/grid.html?module=v_ar_aging_caveat", `${x.settle_party}:nodate`, { amount: nodateAmt, excluded: true, ccy: x.ccy || null }));
    }
  }
  return { rows, summary: { overdue_total: num(overdue), nodate_total: num(nodate) } };
}

async function auditTodos(pool, rgArgs) {
  if (!(await tableExists(pool, "v_hy_audit_all"))) return { rows: [], total: null, note: "未接入: 缺 v_hy_audit_all" };
  const cols = await columns(pool, "v_hy_audit_all");
  const dateCol = ["followup_at", "created_at", "updated_at"].find((c) => cols.has(c)) || "";
  const r = await pool.query(
    `SELECT * FROM v_hy_audit_all
      ${dateCol ? "WHERE " + ident(dateCol) + " >= $1::date AND " + ident(dateCol) + " < ($2::date + interval '1 day')" : ""}
      ORDER BY ${dateCol ? ident(dateCol) + " DESC NULLS LAST," : ""} 1 DESC LIMIT ${LIMIT}`,
    dateCol ? rgArgs : []
  );
  const rows = r.rows.map((x, i) => todo("待审核", x.created_at || x.updated_at || null, clean(x.title || x.description || x.check_code || x.target_table || "待审核"), clean(x.party || x.target_table || x.owner || "未接入"), "/hy/grid.html?module=v_hy_audit_all", x.id || i));
  const c = await pool.query("SELECT COUNT(*)::int AS n FROM v_hy_audit_all");
  return { rows, total: Number(c.rows[0]?.n || 0) || null };
}

function billInvoiceJoin(linkCols) {
  if (!linkCols.has("bill_id")) return null;
  if (linkCols.has("invoice_id")) return "fbi.bill_id::text=b.id::text AND fio.id::text=fbi.invoice_id::text";
  if (linkCols.has("invoice_no")) return "fbi.bill_id::text=b.id::text AND fio.invoice_no::text=fbi.invoice_no::text";
  return null;
}

async function uninvoiced(pool, billCols, linkCols) {
  const join = billInvoiceJoin(linkCols);
  if (!join || !billCols.has("id")) return { state: "not_connected", rows: [], note: "未接入: 缺 freight_bill_invoices.bill_id + invoice_id/invoice_no 关联键" };
  const outCols = await columns(pool, "finance_invoices_out");
  if (!outCols.has("invoice_no")) return { state: "not_connected", rows: [], note: "未接入: 缺 finance_invoices_out.invoice_no" };
  const voidFilter = outCols.has("void_status") ? "AND COALESCE(fio.void_status,'') NOT IN ('void','voided','red')" : "";
  const r = await pool.query(
    `SELECT b.id::text, b.bl_no, b.supplier, b.bill_month, b.cost_category, b.amount, b.currency
       FROM freight_supplier_bills b
      WHERE NOT EXISTS (
        SELECT 1 FROM freight_bill_invoices fbi
        JOIN finance_invoices_out fio ON ${join.replace("b.", "b.")}
        WHERE COALESCE(fio.invoice_no,'') <> ''
          ${voidFilter}
      )
      ORDER BY b.created_at DESC NULLS LAST, b.id DESC LIMIT 40`
  );
  const c = await pool.query(
    `SELECT COUNT(*)::int AS n FROM freight_supplier_bills b
      WHERE NOT EXISTS (
        SELECT 1 FROM freight_bill_invoices fbi
        JOIN finance_invoices_out fio ON ${join}
        WHERE COALESCE(fio.invoice_no,'') <> ''
          ${voidFilter}
      )`
  );
  return { state: "ready", total: Number(c.rows[0]?.n || 0) || null, join_key: linkCols.has("invoice_id") ? "freight_bill_invoices.bill_id -> freight_supplier_bills.id; invoice_id -> finance_invoices_out.id" : "freight_bill_invoices.bill_id -> freight_supplier_bills.id; invoice_no -> finance_invoices_out.invoice_no", rows: r.rows };
}

async function unsettled(pool, billCols) {
  const missing = NEED_BILL_COLS.filter((c) => !billCols.has(c));
  if (missing.length) return { state: "not_connected", rows: [], total: null, note: `未接入: 缺 freight_supplier_bills.${missing.join("/")}` };
  const [cnt, rows] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM freight_supplier_bills WHERE ar_paid_at IS NULL AND ap_paid_at IS NULL"),
    pool.query(`SELECT id::text, bl_no, supplier, bill_month, cost_category, amount, currency
                  FROM freight_supplier_bills
                 WHERE ar_paid_at IS NULL AND ap_paid_at IS NULL
                 ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 40`),
  ]);
  return { state: "ready", total: Number(cnt.rows[0]?.n || 0) || null, rows: rows.rows };
}

async function warnings(pool) {
  const [billCols, linkCols, outCols] = await Promise.all([
    columns(pool, "freight_supplier_bills"),
    columns(pool, "freight_bill_invoices"),
    columns(pool, "finance_invoices_out"),
  ]);
  if (!outCols.size) {
    return { uninvoiced: { state: "not_connected", rows: [], note: "未接入: 缺 finance_invoices_out" }, unsettled: await unsettled(pool, billCols) };
  }
  return { uninvoiced: await uninvoiced(pool, billCols, linkCols), unsettled: await unsettled(pool, billCols) };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "method_not_allowed" });
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const pool = getPool();
  const rg = range(req.query || {});
  try {
    const [drafts, replies, ar, audit, warn] = await Promise.all([
      mailDraftTodos(pool, rg),
      replyTodos(req, rg),
      arTodos(pool),
      auditTodos(pool, [rg.from, rg.to]),
      warnings(pool),
    ]);
    const todos = drafts.rows.concat(replies.rows, ar.rows, audit.rows).slice(0, 220);
    return res.status(200).json({ success: true, version: VERSION, generated_at: new Date().toISOString(), range: rg, todos, notes: { mail_drafts: drafts.note || null, mail_replies: replies.note || null, ar: ar.note || null, audit: audit.note || null }, ar_summary: ar.summary, audit_summary: { total: audit.total }, warnings: warn });
  } catch (err) {
    console.error("[hy-workbench] GET error:", err);
    return res.status(500).json({ success: false, error: "Internal server error", detail: err.message });
  }
}
