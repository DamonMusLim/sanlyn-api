// api/db/supplier-bills-reconcile.js
// 应付货代对账台 — 锚定源 = freight_supplier_bills (唯一真源，不用其他表兜底)
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

// 供应商名规范化(SQL_ASCII 安全:只用 replace 精确子串替换,绝不用 translate/regexp,否则按字节切坏中文)。
// 仅做「明显同主体」的机械归一:全角括号（）→半角()、去首尾空白。
// 跨主体的可疑合并(昵称/分公司/&合并账/不同税号)不在此处,交 freight_supplier_alias 映射表由 Damon 认定。
const NORM_NAME_SQL = `
  COALESCE(
    NULLIF(
      btrim(replace(replace(COALESCE(supplier, ''), '（', '('), '）', ')')),
      ''
    ),
    '(未命名)'
  )`;
// 状态机：ap_paid>=amount → paid；0<ap_paid<amount → partial；ap_paid=0/NULL → pending
function statusOf(amount, apPaid) {
  const amt = num(amount);
  const paid = num(apPaid);
  if (amt <= 0) return "pending";
  if (paid >= amt) return "paid";
  if (paid > 0) return "partial";
  return "pending";
}

// 分组维度 = (bill_month, supplier_company_code)，主视图只统计 CNY（currency_norm='CNY' 或 NULL）
// 其他币种绝不混加，单独在 other_currency_groups 里按 (bill_month, supplier_company_code, currency_norm) 分组返回
// 别名表存在性缓存(避免每请求探测)。表由 Damon 认定后建,不存在=不启用别名收敛。
let _aliasTableExists = null;
async function aliasTableExists(pool) {
  if (_aliasTableExists !== null) return _aliasTableExists;
  try {
    const r = await pool.query("SELECT to_regclass('public.freight_supplier_alias') AS t");
    _aliasTableExists = !!r.rows?.[0]?.t;
  } catch {
    _aliasTableExists = false;
  }
  return _aliasTableExists;
}

async function fetchReconcile(pool, opts) {
  const params = [opts.from, opts.to];
  // 别名映射表可选:表存在则 LEFT JOIN 收敛到 canonical_name;表不存在=纯机械规范化(等价旧行为,只多收敛全/半角括号)。
  // 映射键 = 规范化后的名(norm_name),与 seed 数据口径一致。
  const aliasJoin = opts.aliasEnabled
    ? `LEFT JOIN freight_supplier_alias a ON a.raw_name = ${NORM_NAME_SQL}`
    : "";
  const grpKeyExpr = opts.aliasEnabled
    ? `COALESCE(NULLIF(a.canonical_name, ''), ${NORM_NAME_SQL})`
    : NORM_NAME_SQL;

  let supplierWhere = "";
  if (opts.supplier) {
    // 按分组主体(归一后的名)筛选,与 grp_key 口径一致
    params.push(opts.supplier);
    supplierWhere = `AND ${grpKeyExpr} = $${params.length}`;
  }
  const sql = `
    WITH base AS (
      SELECT fsb.*,
             COALESCE(NULLIF(fsb.currency_norm, ''), 'CNY') AS ccy,
             -- 分组主体键 = 规范化供应商名(整串字节比较,SQL_ASCII 库安全)。
             -- 全/半角括号统一 + 去首尾空白 = 明显同主体自动合并;跨主体可疑合并走 freight_supplier_alias(Damon 认定)。
             -- code 不可靠(同 code 挂不同公司),仅作展示,绝不参与分组。
             ${grpKeyExpr} AS grp_key
        FROM freight_supplier_bills fsb
        ${aliasJoin}
       WHERE fsb.bill_month >= $1 AND fsb.bill_month <= $2
         ${supplierWhere}
    ),
    grp AS (
      SELECT bill_month, grp_key, ccy,
             MAX(NULLIF(supplier_company_code, '')) AS supplier_company_code,
             MAX(grp_key) AS supplier,
             COUNT(DISTINCT NULLIF(supplier_company_code, '')) AS code_variants,
             COUNT(*) AS bill_count,
             SUM(COALESCE(amount, 0)) AS amount,
             SUM(COALESCE(ap_paid_amount, 0)) AS ap_paid_amount,
             MAX(ap_paid_at) AS ap_paid_at,
             bool_and(COALESCE(reconciled, false)) AS reconciled
        FROM base
       GROUP BY bill_month, grp_key, ccy
    )
    SELECT g.*,
           COALESCE(lines.lines, '[]'::jsonb) AS lines
      FROM grp g
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'id', b.id, 'bill_month', b.bill_month, 'amount', b.amount, 'currency', b.currency,
          'currency_norm', b.ccy, 'supplier', b.supplier, 'supplier_company_code', b.supplier_company_code,
          'ap_paid_amount', b.ap_paid_amount, 'ap_paid_at', b.ap_paid_at,
          'rebill_status', b.rebill_status, 'reconciled', b.reconciled, 'bill_file', b.bill_file,
          'payment_note', b.payment_note, 'cost_category', b.cost_category, 'bl_no', b.bl_no,
          'container_no', b.container_no
        ) ORDER BY b.bill_month DESC, b.id) AS lines
        FROM base b
       WHERE b.bill_month = g.bill_month AND b.grp_key = g.grp_key
         AND b.ccy = g.ccy
      ) lines ON true
     ORDER BY g.bill_month DESC, g.supplier, g.ccy`;
  return (await pool.query(sql, params)).rows;
}

function normalizeGroups(rows, detail) {
  const cnyRows = rows.filter((r) => r.ccy === "CNY");
  const otherRows = rows.filter((r) => r.ccy !== "CNY");

  const toGroup = (r) => {
    const amount = money(r.amount) || 0;
    const apPaid = money(r.ap_paid_amount) || 0;
    const diff = money(amount - apPaid);
    const codeVariants = Number(r.code_variants) || 0;
    const g = {
      bill_month: r.bill_month,
      supplier_company_code: r.supplier_company_code,
      supplier: r.supplier,
      currency: r.ccy,
      bill_count: Number(r.bill_count) || 0,
      amount,
      ap_paid_amount: apPaid,
      ap_paid_at: r.ap_paid_at,
      diff_amount: diff,
      reconciled: !!r.reconciled,
      status: statusOf(amount, apPaid),
      // 别名标记:同一供应商名挂了多个 supplier_company_code → 主数据待补/归一(仅提示,不擅自合并)
      alias_warn: codeVariants > 1,
      code_variants: codeVariants,
    };
    if (detail) {
      g.lines = (Array.isArray(r.lines) ? r.lines : []).map((l) => ({
        id: l.id,
        bill_month: l.bill_month,
        amount: money(l.amount),
        currency: l.currency,
        currency_norm: l.currency_norm,
        ap_paid_amount: money(l.ap_paid_amount),
        ap_paid_at: l.ap_paid_at,
        diff_amount: money((l.amount || 0) - (l.ap_paid_amount || 0)),
        status: statusOf(l.amount, l.ap_paid_amount),
        rebill_status: l.rebill_status,
        reconciled: !!l.reconciled,
        bill_file: l.bill_file || null,
        payment_note: l.payment_note || null,
        cost_category: l.cost_category || null,
        bl_no: l.bl_no || null,
        container_no: l.container_no || null,
      }));
    }
    return g;
  };

  const groups = cnyRows.map(toGroup);
  const otherGroups = otherRows.map(toGroup);

  const summary = groups.reduce((s, g) => {
    s.amount += g.amount || 0;
    s.ap_paid_amount += g.ap_paid_amount || 0;
    s.suppliers.add(g.supplier_company_code);
    s.bill_count += g.bill_count;
    if (g.status === "pending") s.pending += 1;
    if (g.status === "partial") s.partial += 1;
    if (g.reconciled) s.reconciled_count += 1;
    if (g.alias_warn) s.alias_groups += 1;
    return s;
  }, { amount: 0, ap_paid_amount: 0, suppliers: new Set(), bill_count: 0, pending: 0, partial: 0, reconciled_count: 0, alias_groups: 0 });
  summary.amount = money(summary.amount);
  summary.ap_paid_amount = money(summary.ap_paid_amount);
  summary.diff_amount = money(summary.amount - summary.ap_paid_amount);
  summary.suppliers = summary.suppliers.size;

  return { summary, groups, other_currency_groups: otherGroups };
}

async function handleInternal(req, res) {
  if (!requireFinance(req, res)) return;
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const pool = getPool();
  const rows = await fetchReconcile(pool, {
    ...range,
    supplier: cleanString(req.query.supplier) || null,
    aliasEnabled: await aliasTableExists(pool),
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

const STATUS_LABEL = { paid: "已付", partial: "部分付", pending: "待付" };

async function handleDownload(req, res) {
  if (!requireFinance(req, res)) return;
  if ((cleanString(req.query.format) || "csv") !== "csv") return json(res, 400, { error: "today only csv" });
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const pool = getPool();
  const rows = await fetchReconcile(pool, {
    ...range,
    supplier: cleanString(req.query.supplier) || null,
    aliasEnabled: await aliasTableExists(pool),
  });
  const { groups, other_currency_groups } = normalizeGroups(rows, false);
  const out = [["月份", "供应商", "供应商码", "单据数", "账单合计", "币种", "已付", "差额", "状态"]];
  for (const g of [...groups, ...other_currency_groups]) {
    out.push([g.bill_month, g.supplier, g.supplier_company_code, g.bill_count, g.amount, g.currency, g.ap_paid_amount, g.diff_amount, STATUS_LABEL[g.status] || g.status]);
  }
  return sendCsv(res, `supplier-bills-reconcile-${range.from}-${range.to}.csv`, out);
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
    console.error("[supplier-bills-reconcile]", e);
    return json(res, 500, { error: "Internal server error", detail: e.message });
  }
}
