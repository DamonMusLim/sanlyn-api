// api/db/customer-ar-reconcile.js
// 应收客户对账台 — 锚定源 = finance_export_rebates.fob_cny (报关销售额,唯一真源,绝不用 orders.total/OLI)
// ⚠️ 受众隔离:此表将外发客户,返回字段绝不含工厂采购价/货代成本/factory_price
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
function rangeFromQuery(q) {
  let from = parseMonth(q.from);
  let to = parseMonth(q.to);
  if (!from && !to) {
    const d = new Date();
    from = to = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (!from) from = to;
  if (!to) to = from;
  if (!from || !to || from > to) return null;
  return { from, to };
}
function money(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function num(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
// 状态机:已收>=应收→received(已收清);0<已收<应收→partial(部分收);否则→pending(待收,黄)
function statusOf(expected, received) {
  const exp = num(expected);
  const rec = num(received);
  if (exp <= 0) return "pending";
  if (rec >= exp) return "received";
  if (rec > 0) return "partial";
  return "pending";
}

// 分组维度 = (period=报关月, customer_id);锚=SUM(fob_cny)报关销售额;不同 customer_id 不合并
async function fetchReconcile(pool, opts) {
  const params = [opts.from, opts.to];
  let custWhere = "";
  if (opts.customerId) {
    params.push(opts.customerId);
    custWhere = `AND COALESCE(r.customer_id::text, 'none') = $${params.length}`;
  }
  const sql = `
    WITH base AS (
      SELECT r.customs_no, r.contract_no, r.customer_id, r.export_date,
             COALESCE(r.fob_cny, 0) AS fob_cny,
             to_char(r.export_date, 'YYYY-MM') AS period,
             COALESCE(r.customer_id::text, 'none') AS grp_key
        FROM finance_export_rebates r
       WHERE r.export_date >= ($1 || '-01')::date
         AND r.export_date <  (($2 || '-01')::date + interval '1 month')
         ${custWhere}
    ),
    grp AS (
      SELECT period, grp_key,
             MAX(customer_id) AS customer_id,
             COUNT(*) AS decl_count,
             SUM(fob_cny) AS expected_amount,
             array_agg(DISTINCT contract_no) FILTER (WHERE contract_no IS NOT NULL) AS contracts,
             array_agg(DISTINCT customs_no) FILTER (WHERE customs_no IS NOT NULL) AS customs
        FROM base
       GROUP BY period, grp_key
    )
    SELECT g.period, g.grp_key, g.customer_id, g.decl_count, g.expected_amount,
           g.contracts, g.customs,
           COALESCE(NULLIF(cu.name_cn,''), NULLIF(cu.name_en,''), NULLIF(cu.name,''),
                    NULLIF(cu.client_code,''),
                    CASE WHEN g.customer_id IS NULL THEN '未分配客户'
                         ELSE '客户#' || g.customer_id::text END) AS customer_name,
           cu.client_code AS customer_code,
           COALESCE(inv.uploaded_amount, 0) AS uploaded_amount,
           COALESCE(rcv.received_amount, 0) AS received_amount,
           COALESCE(lines.lines, '[]'::jsonb) AS lines
      FROM grp g
      LEFT JOIN customers cu ON cu.id = g.customer_id
      LEFT JOIN LATERAL (
        -- 已开:排除作废/红冲/草稿(CI-DRAFT-*);按报关单或合同重叠匹配本组。
        -- 注(codex审):一票挂多合同跨报关月时各组可能各计整票(缺分摊列),数据完善后按分摊改进
        SELECT SUM(fio.amount_incl_tax) AS uploaded_amount
          FROM finance_invoices_out fio
         WHERE fio.customer_id = g.customer_id
           AND COALESCE(fio.void_status,'') <> 'void'
           AND COALESCE(fio.review_status,'') NOT IN ('void','red_ink')
           AND COALESCE(fio.invoice_no,'') NOT LIKE 'CI-DRAFT%'
           AND (COALESCE(fio.customs_nos::text[], '{}'::text[]) && COALESCE(g.customs::text[], '{}'::text[])
             OR COALESCE(fio.contract_nos::text[], '{}'::text[]) && COALESCE(g.contracts::text[], '{}'::text[]))
      ) inv ON true
      LEFT JOIN LATERAL (
        -- 已收:只计已分摊金额 amount_alloc(未分摊水单不虚计整笔,避免一单连多合同重复吃 bs.amount)
        SELECT SUM(bsl.amount_alloc) AS received_amount
          FROM bank_slip_links bsl
          JOIN bank_slips bs ON bs.id = bsl.slip_id
         WHERE bsl.contract_no = ANY(COALESCE(g.contracts, '{}'::text[]))
           AND bsl.amount_alloc IS NOT NULL
      ) rcv ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'customs_no', b.customs_no, 'contract_no', b.contract_no,
          'export_date', b.export_date, 'fob_cny', b.fob_cny
        ) ORDER BY b.export_date DESC) AS lines
        FROM base b
       WHERE b.period = g.period AND COALESCE(b.customer_id::text,'none') = g.grp_key
      ) lines ON true
     ORDER BY g.period DESC, g.expected_amount DESC`;
  return (await pool.query(sql, params)).rows;
}

function normalizeGroups(rows, detail) {
  const toGroup = (r) => {
    const expected = money(r.expected_amount) || 0;
    const uploaded = money(r.uploaded_amount) || 0;
    const received = money(r.received_amount) || 0;
    const g = {
      period: r.period,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      customer_code: r.customer_code || null,
      decl_count: Number(r.decl_count) || 0,
      expected_amount: expected,   // 应收(报关销售额锚定)
      uploaded_amount: uploaded,   // 已开(向客户CI)
      received_amount: received,   // 已收(客户回款)
      diff_amount: money(expected - received),
      status: statusOf(expected, received),
    };
    if (detail) {
      g.lines = (Array.isArray(r.lines) ? r.lines : []).map((l) => ({
        customs_no: l.customs_no || null,
        contract_no: l.contract_no || null,
        export_date: l.export_date || null,
        fob_cny: money(l.fob_cny),
      }));
    }
    return g;
  };
  const groups = rows.map(toGroup);
  const summary = groups.reduce((s, g) => {
    s.expected_amount += g.expected_amount || 0;
    s.uploaded_amount += g.uploaded_amount || 0;
    s.received_amount += g.received_amount || 0;
    s.customers.add(g.grp_key || g.customer_id);
    s.decl_count += g.decl_count;
    if (g.status === "pending") s.pending += 1;
    if (g.status === "partial") s.partial += 1;
    return s;
  }, { expected_amount: 0, uploaded_amount: 0, received_amount: 0, customers: new Set(), decl_count: 0, pending: 0, partial: 0 });
  summary.expected_amount = money(summary.expected_amount);
  summary.uploaded_amount = money(summary.uploaded_amount);
  summary.received_amount = money(summary.received_amount);
  summary.diff_amount = money((summary.expected_amount || 0) - (summary.received_amount || 0));
  summary.customers = summary.customers.size;
  return { summary, groups };
}

async function handleInternal(req, res) {
  if (!requireFinance(req, res)) return;
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const rows = await fetchReconcile(getPool(), {
    ...range,
    customerId: cleanString(req.query.customer_id) || null,
  });
  const data = normalizeGroups(rows, req.query.detail === "1");
  return res.json({ success: true, period: { from: range.from, to: range.to }, ...data });
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, filename, rows) {
  const csv = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
}
const STATUS_LABEL = { received: "已收", partial: "部分收", pending: "待收" };

async function handleDownload(req, res) {
  if (!requireFinance(req, res)) return;
  if ((cleanString(req.query.format) || "csv") !== "csv") return json(res, 400, { error: "today only csv" });
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const rows = await fetchReconcile(getPool(), {
    ...range,
    customerId: cleanString(req.query.customer_id) || null,
  });
  const { groups } = normalizeGroups(rows, false);
  const out = [["月份", "客户", "客户码", "报关单数", "应收(锚定)", "已开", "已收", "差额", "状态"]];
  for (const g of groups) {
    out.push([g.period, g.customer_name, g.customer_code || "", g.decl_count, g.expected_amount, g.uploaded_amount, g.received_amount, g.diff_amount, STATUS_LABEL[g.status] || g.status]);
  }
  return sendCsv(res, `customer-ar-reconcile-${range.from}-${range.to}.csv`, out);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const action = cleanString(req.query?.action);
    if (req.method === "GET" && action === "download") return handleDownload(req, res);
    if (req.method === "GET") return handleInternal(req, res);
    return json(res, 405, { error: "Method not allowed" });
  } catch (e) {
    console.error("[customer-ar-reconcile]", e);
    return json(res, 500, { error: "Internal server error", detail: e.message });
  }
}
