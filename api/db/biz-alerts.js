// GET/PATCH /api/db/biz-alerts — 业务预警：信用额度 / 合同日期。
// 零数据只显示未接入或未设置；信用额度必须人工设置，不反推额度。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const COMPANY_COLS = [
  "credit_limit",
  "credit_currency",
  "credit_limit_note",
  "contract_start",
  "contract_end",
];
const FSB_COLS = [
  "payer_company_code",
  "sale_amount",
  "ar_paid_amount",
  "currency",
  "rebill_status",
];

function clean(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function numOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function dateOrNull(v) {
  const s = clean(v, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function roleCanWrite(req) {
  return req.user?.role === "admin";
}

function basis(state, note, extra = {}) {
  return { state, note, ...extra };
}

async function tableColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

async function loadSchema(pool) {
  const [companies, bills] = await Promise.all([
    tableColumns(pool, "companies"),
    tableColumns(pool, "freight_supplier_bills"),
  ]);
  return {
    companies,
    bills,
    companyReady: COMPANY_COLS.every((c) => companies.has(c)),
    billsReady: FSB_COLS.every((c) => bills.has(c)),
  };
}

async function loadCompanies(pool, schema) {
  if (!schema.companyReady) {
    const r = await pool.query(
      "SELECT id, code, name_cn, name_en FROM companies ORDER BY code ASC"
    );
    return r.rows.map((x) => ({
      ...x,
      credit_limit: null,
      credit_currency: null,
      credit_limit_note: null,
      contract_start: null,
      contract_end: null,
    }));
  }
  const r = await pool.query(
    `SELECT id, code, name_cn, name_en, credit_limit, credit_currency,
            credit_limit_note, to_char(contract_start,'YYYY-MM-DD') AS contract_start,
            to_char(contract_end,'YYYY-MM-DD') AS contract_end
       FROM companies
      ORDER BY code ASC`
  );
  return r.rows;
}

async function loadUsage(pool, schema) {
  if (!schema.billsReady) return { rows: [], connected: false };
  const r = await pool.query(
    `SELECT payer_company_code AS code, currency,
            COUNT(*)::int AS row_count,
            COUNT(*) FILTER (WHERE sale_amount IS NULL)::int AS missing_sale_amount,
            COUNT(*) FILTER (WHERE ar_paid_amount IS NULL)::int AS missing_paid_amount,
            SUM(GREATEST(COALESCE(sale_amount,0) - COALESCE(ar_paid_amount,0),0)) AS used_amount
       FROM freight_supplier_bills
      WHERE NULLIF(BTRIM(payer_company_code), '') IS NOT NULL
        AND NULLIF(BTRIM(currency), '') IS NOT NULL
        AND COALESCE(rebill_status, '') NOT IN ('voided', 'absorbed')
      GROUP BY payer_company_code, currency`
  );
  return { rows: r.rows, connected: true };
}

function companyName(c) {
  return c.name_cn || c.name_en || c.code || "未设置";
}

function buildCredit(companies, usageState) {
  const usage = new Map();
  usageState.rows.forEach((r) => usage.set(`${r.code}::${r.currency}`, r));
  const unset = [];
  const incomplete = [];
  const alerts = [];
  let configured = 0;
  companies.forEach((c) => {
    const limit = c.credit_limit === null ? null : Number(c.credit_limit);
    const currency = clean(c.credit_currency, 8).toUpperCase();
    if (!Number.isFinite(limit) || limit <= 0) {
      unset.push({ id: c.id, code: c.code, name: companyName(c) });
      return;
    }
    configured += 1;
    if (!currency) {
      incomplete.push({ id: c.id, code: c.code, name: companyName(c), reason: "额度币种未设置" });
      return;
    }
    const row = usage.get(`${c.code}::${currency}`);
    if (!usageState.connected || !row) return;
    const used = Number(row.used_amount || 0);
    const ratio = limit > 0 ? used / limit : null;
    if (ratio !== null && ratio >= 0.8) {
      alerts.push({
        id: `credit:${c.id}:${currency}`,
        company_id: c.id,
        code: c.code,
        name: companyName(c),
        credit_limit: limit,
        credit_currency: currency,
        used_amount: used,
        ratio,
        row_count: Number(row.row_count || 0),
        missing_paid_amount: Number(row.missing_paid_amount || 0),
        basis: `依据 freight_supplier_bills.payer_company_code=${c.code}、currency=${currency}、sale_amount-ar_paid_amount；未使用 ar_status`,
      });
    }
  });
  alerts.sort((a, b) => b.ratio - a.ratio);
  return {
    state: usageState.connected ? "ready" : "not_connected",
    count: usageState.connected ? alerts.length : null,
    rows: alerts,
    unset: { count: unset.length, rows: unset },
    incomplete: { count: incomplete.length, rows: incomplete },
    configured,
    basis: basis(
      usageState.connected ? "ready" : "not_connected",
      usageState.connected
        ? "只有 companies.credit_limit 与 credit_currency 已人工设置的公司才计算；已用=freight_supplier_bills 未收金额汇总。"
        : "freight_supplier_bills 必要列未接入，信用额度预警不计算。",
      { threshold: "80%", table: "companies + freight_supplier_bills" }
    ),
  };
}

function buildContracts(companies) {
  const unset = [];
  const alerts = [];
  const today = new Date();
  const end = new Date(today.getTime() + 30 * 86400000);
  let configured = 0;
  companies.forEach((c) => {
    if (!c.contract_start && !c.contract_end) {
      unset.push({ id: c.id, code: c.code, name: companyName(c) });
      return;
    }
    configured += 1;
    if (!c.contract_end) return;
    const d = new Date(c.contract_end + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) return;
    if (d <= end) {
      const days = Math.ceil((d.getTime() - today.getTime()) / 86400000);
      alerts.push({
        id: `contract:${c.id}`,
        company_id: c.id,
        code: c.code,
        name: companyName(c),
        contract_start: c.contract_start,
        contract_end: c.contract_end,
        days_left: days,
        basis: "依据 companies.contract_end 已填写；未填写合同日期的公司只归入未设置，不产生预警",
      });
    }
  });
  alerts.sort((a, b) => a.days_left - b.days_left);
  return {
    state: "ready",
    count: alerts.length,
    rows: alerts,
    unset: { count: unset.length, rows: unset },
    configured,
    basis: basis("ready", "只统计已填写 contract_end 且已过期或 30 天内到期的公司。", {
      threshold: "30天",
      table: "companies",
    }),
  };
}

async function list(req, res, pool) {
  const schema = await loadSchema(pool);
  const companies = await loadCompanies(pool, schema);
  const usage = await loadUsage(pool, schema);
  const missingCompanyCols = COMPANY_COLS.filter((c) => !schema.companies.has(c));
  const missingBillCols = FSB_COLS.filter((c) => !schema.bills.has(c));
  return res.status(200).json({
    success: true,
    generated_at: new Date().toISOString(),
    migration_required: missingCompanyCols.length > 0,
    schema: {
      companies: schema.companyReady ? "ready" : "not_connected",
      freight_supplier_bills: schema.billsReady ? "ready" : "not_connected",
      missing_company_columns: missingCompanyCols,
      missing_bill_columns: missingBillCols,
    },
    companies,
    credit: schema.companyReady
      ? buildCredit(companies, usage)
      : {
          state: "not_connected",
          count: null,
          rows: [],
          unset: { count: null, rows: [] },
          incomplete: { count: null, rows: [] },
          configured: null,
          basis: basis("not_connected", "companies 信用额度字段未接入；先执行待批准 migration。"),
        },
    contracts: schema.companyReady
      ? buildContracts(companies)
      : {
          state: "not_connected",
          count: null,
          rows: [],
          unset: { count: null, rows: [] },
          configured: null,
          basis: basis("not_connected", "companies 合同日期字段未接入；先执行待批准 migration。"),
        },
  });
}

async function updateSettings(req, res, pool) {
  if (!roleCanWrite(req)) return res.status(403).json({ success: false, error: "Forbidden: admin only" });
  const schema = await loadSchema(pool);
  if (!schema.companyReady) {
    return res.status(409).json({ success: false, error: "业务预警字段未接入，先执行待批准 migration" });
  }
  const b = req.body || {};
  const id = Number.parseInt(b.company_id || b.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, error: "company_id 必填" });
  const limit = numOrNull(b.credit_limit);
  if (Number.isNaN(limit) || (limit !== null && limit < 0)) {
    return res.status(400).json({ success: false, error: "credit_limit 必须是非负数字或留空" });
  }
  const currency = clean(b.credit_currency, 8).toUpperCase() || null;
  const note = clean(b.credit_limit_note, 1000) || null;
  const start = dateOrNull(b.contract_start);
  const end = dateOrNull(b.contract_end);
  const r = await pool.query(
    `UPDATE companies
        SET credit_limit=$2, credit_currency=$3, credit_limit_note=$4,
            contract_start=$5, contract_end=$6, updated_at=NOW()
      WHERE id=$1
      RETURNING id, code, name_cn, name_en, credit_limit, credit_currency,
                credit_limit_note, to_char(contract_start,'YYYY-MM-DD') AS contract_start,
                to_char(contract_end,'YYYY-MM-DD') AS contract_end`,
    [id, limit, currency, note, start, end]
  );
  if (!r.rowCount) return res.status(404).json({ success: false, error: "company not found" });
  return res.status(200).json({ success: true, data: r.rows[0] });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    if (req.method === "GET") return list(req, res, pool);
    if (req.method === "PATCH") return updateSettings(req, res, pool);
    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    console.error("[biz-alerts]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
