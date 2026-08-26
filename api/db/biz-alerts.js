// GET/PATCH/POST/DELETE /api/db/biz-alerts — 业务预警：信用额度 / 合同日期。
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
const IGNORE_SCOPE_PREFIX = "biz-alerts";
// Unit: rows where ar_paid_amount > 0. Less than 1 means payment writeback has
// not produced any usable paid amount data, so credit usage must not calculate.
const MIN_PAID_POSITIVE_ROWS = 1;

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

function actorFrom(req) {
  const u = req.user || {};
  return clean(u.employee_code || u.staff_no || u.username || u.account || u.email || u.uid || u.id || u.sub || u.name || "unknown", 120);
}

function ignoreScope(kind) {
  return `${IGNORE_SCOPE_PREFIX}:${kind}`;
}

function basis(state, note, extra = {}) {
  return { state, note, ...extra };
}

async function tableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(r.rows[0]?.name);
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
  const ignoresReady = await tableExists(pool, "alert_ignores");
  return {
    companies,
    bills,
    ignoresReady,
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
  const stats = await pool.query(
    `SELECT COUNT(*)::int AS total_rows,
            COUNT(*) FILTER (WHERE COALESCE(ar_paid_amount,0) > 0)::int AS paid_positive_rows,
            COUNT(*) FILTER (WHERE NULLIF(BTRIM(payer_company_code), '') IS NOT NULL)::int AS payer_company_code_rows
       FROM freight_supplier_bills`
  );
  const coverage = {
    total_rows: Number(stats.rows[0]?.total_rows || 0),
    paid_positive_rows: Number(stats.rows[0]?.paid_positive_rows || 0),
    payer_company_code_rows: Number(stats.rows[0]?.payer_company_code_rows || 0),
    min_paid_positive_rows: MIN_PAID_POSITIVE_ROWS,
  };
  if (coverage.paid_positive_rows < MIN_PAID_POSITIVE_ROWS) {
    return { rows: [], connected: true, hasUsablePaidData: false, coverage };
  }
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
  return { rows: r.rows, connected: true, hasUsablePaidData: true, coverage };
}

function companyName(c) {
  return c.name_cn || c.name_en || c.code || "未设置";
}

function buildCredit(companies, usageState) {
  const coverage = usageState.coverage || null;
  if (usageState.connected && !usageState.hasUsablePaidData) {
    const paid = coverage?.paid_positive_rows ?? 0;
    const total = coverage?.total_rows ?? 0;
    const payer = coverage?.payer_company_code_rows ?? 0;
    const note = `已收金额尚未接入（ar_paid_amount 当前 ${paid}/${total} 行有值）。收付回写管道修复上线并产生数据后，此处自动生效。`;
    return {
      state: "no_data",
      count: null,
      rows: [],
      unset: { count: null, rows: [] },
      incomplete: { count: null, rows: [] },
      configured: null,
      basis: basis("no_data", note, {
        threshold: `${MIN_PAID_POSITIVE_ROWS}行 ar_paid_amount > 0`,
        table: "companies + freight_supplier_bills",
        payer_company_code_coverage: `${payer}/${total}`,
      }),
    };
  }
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
      {
        threshold: "80%",
        table: "companies + freight_supplier_bills",
        payer_company_code_coverage: coverage
          ? `${coverage.payer_company_code_rows}/${coverage.total_rows}`
          : "未接入",
      }
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

async function loadIgnored(pool, schema) {
  if (!schema.ignoresReady) return { state: "not_connected", targets: new Set(), count: null };
  const r = await pool.query(
    `SELECT scope, target_key
       FROM alert_ignores
      WHERE scope = ANY($1::text[])`,
    [[ignoreScope("credit"), ignoreScope("contracts")]]
  );
  const targets = new Set(r.rows.map((x) => `${x.scope}:${x.target_key}`));
  return { state: "ready", targets, count: targets.size };
}

function applyIgnores(block, kind, ignored) {
  if (!block || block.state !== "ready") return block;
  const scope = ignoreScope(kind);
  const allRows = Array.isArray(block.rows) ? block.rows : [];
  const rows = allRows.filter((r) => !ignored.targets.has(`${scope}:${r.id}`));
  return {
    ...block,
    count: rows.length,
    rows,
    ignored_count: allRows.length - rows.length,
  };
}

async function list(req, res, pool) {
  const schema = await loadSchema(pool);
  const companies = await loadCompanies(pool, schema);
  const usage = await loadUsage(pool, schema);
  const ignored = await loadIgnored(pool, schema);
  const missingCompanyCols = COMPANY_COLS.filter((c) => !schema.companies.has(c));
  const missingBillCols = FSB_COLS.filter((c) => !schema.bills.has(c));
  let credit = schema.companyReady
    ? applyIgnores(buildCredit(companies, usage), "credit", ignored)
    : {
        state: "not_connected",
        count: null,
        rows: [],
        unset: { count: null, rows: [] },
        incomplete: { count: null, rows: [] },
        configured: null,
        basis: basis("not_connected", "companies 信用额度字段未接入；先执行待批准 migration。"),
      };
  let contracts = schema.companyReady
    ? applyIgnores(buildContracts(companies), "contracts", ignored)
    : {
        state: "not_connected",
        count: null,
        rows: [],
        unset: { count: null, rows: [] },
        configured: null,
        basis: basis("not_connected", "companies 合同日期字段未接入；先执行待批准 migration。"),
      };
  if (!schema.companyReady) {
    const note = `未接入: 缺 ${missingCompanyCols.map((c) => `companies.${c}`).join(" / ")}；当前填充率 未接入`;
    credit = { ...credit, basis: basis("not_connected", note) };
    contracts = { ...contracts, basis: basis("not_connected", note) };
  } else if (!schema.billsReady && credit.state === "not_connected") {
    const note = `未接入: 缺 ${missingBillCols.map((c) => `freight_supplier_bills.${c}`).join(" / ")}；当前填充率 未接入`;
    credit = { ...credit, basis: basis("not_connected", note) };
  }
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
    ignore: schema.ignoresReady
      ? { state: "ready", ignored_count: ignored.count, table: "alert_ignores" }
      : { state: "not_connected", ignored_count: null, missing_fields: ["alert_ignores"], note: "未接入: 缺 alert_ignores；当前填充率 未接入" },
    companies,
    credit,
    contracts,
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

async function assertReadyAlert(pool, kind, id) {
  if (!["credit", "contracts"].includes(kind)) {
    return { ok: false, status: 403, error: "not_connected alert cannot be ignored" };
  }
  const schema = await loadSchema(pool);
  if (!schema.ignoresReady) {
    return { ok: false, status: 409, error: "未接入: 缺 alert_ignores；当前填充率 未接入" };
  }
  if (!schema.companyReady) {
    return { ok: false, status: 403, error: "not_connected alert cannot be ignored" };
  }
  const companies = await loadCompanies(pool, schema);
  const block = kind === "credit"
    ? buildCredit(companies, await loadUsage(pool, schema))
    : buildContracts(companies);
  if (block.state !== "ready") {
    return { ok: false, status: 403, error: "not_connected alert cannot be ignored" };
  }
  const row = (block.rows || []).find((r) => String(r.id) === String(id));
  if (!row) return { ok: false, status: 404, error: "alert row not found" };
  return { ok: true, schema, row };
}

async function ignoreAlert(req, res, pool) {
  const kind = clean(req.body?.kind || req.body?.tab, 40);
  const id = clean(req.body?.id, 160);
  if (!id) return res.status(400).json({ success: false, error: "id required" });
  const found = await assertReadyAlert(pool, kind, id);
  if (!found.ok) return res.status(found.status).json({ success: false, error: found.error });
  const actor = actorFrom(req);
  const note = clean(req.body?.note || req.body?.notes || `ignored by ${actor}`, 1000);
  await pool.query(
    `INSERT INTO alert_ignores (scope, target_key, actor, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (scope, target_key)
     DO UPDATE SET actor=EXCLUDED.actor, note=EXCLUDED.note, created_at=NOW()`,
    [ignoreScope(kind), id, actor, note]
  );
  return res.status(200).json({ success: true, ignored: true, scope: ignoreScope(kind), target_key: id });
}

async function unignoreAlert(req, res, pool) {
  const kind = clean(req.body?.kind || req.query?.kind || req.body?.tab || req.query?.tab, 40);
  const id = clean(req.body?.id || req.query?.id, 160);
  if (!["credit", "contracts"].includes(kind)) {
    return res.status(403).json({ success: false, error: "not_connected alert cannot be unignored" });
  }
  if (!id) return res.status(400).json({ success: false, error: "id required" });
  if (!(await tableExists(pool, "alert_ignores"))) {
    return res.status(409).json({ success: false, error: "未接入: 缺 alert_ignores；当前填充率 未接入" });
  }
  await pool.query(
    `DELETE FROM alert_ignores
      WHERE scope=$1 AND target_key=$2`,
    [ignoreScope(kind), id]
  );
  return res.status(200).json({ success: true, ignored: false });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    if (req.method === "GET") return list(req, res, pool);
    if (req.method === "PATCH") return updateSettings(req, res, pool);
    if (req.method === "POST") return ignoreAlert(req, res, pool);
    if (req.method === "DELETE") return unignoreAlert(req, res, pool);
    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    console.error("[biz-alerts]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
