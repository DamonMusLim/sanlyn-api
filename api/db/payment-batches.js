// api/db/payment-batches.js
//
// GET  ?mode=draft     read-only payment approval batch preview
// GET  ?mode=confirmed confirmed approval batches for a human payment list
// POST                confirm approval batch; does not execute any transfer

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);
const BELOW_COST_THRESHOLD = 1.05;

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}

function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function periodOf(row) {
  const d = row.issue_date || row.created_at;
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 7);
}

function actor(req) {
  return clean(req.user?.username || req.user?.name || req.user?.uid || req.user?.id || "", 80) || null;
}

function invoiceReason(row) {
  const parts = [];
  if (row.amount_incl_tax === null || row.amount_incl_tax === undefined) parts.push("amount_incl_tax missing");
  if (!clean(row.seller_company_code)) parts.push("seller_company_code missing");
  return parts.join(", ") || "incomplete";
}

async function loadCompanyMap(db, codes) {
  const uniq = [...new Set(codes.filter(Boolean))];
  if (!uniq.length) return new Map();
  const r = await db.query(
    `SELECT code, name_cn, name_en, COALESCE(payment_consolidation, true) AS payment_consolidation
       FROM companies
      WHERE code = ANY($1::varchar[])`,
    [uniq]
  );
  return new Map(r.rows.map(row => [row.code, row]));
}

async function estimateProfit(db, contractNos) {
  const contracts = [...new Set((contractNos || []).map(v => clean(v, 80)).filter(Boolean))];
  if (!contracts.length) {
    return { estCost: null, estRevenue: null, estProfit: null, profitStatus: "unknown" };
  }

  const r = await db.query(
    `SELECT id, freight_sale_usd, freight_cost
       FROM shipping_plans
      WHERE COALESCE(contract_nos::text[], '{}'::text[]) && $1::text[]`,
    [contracts]
  );
  if (!r.rowCount) {
    return { estCost: null, estRevenue: null, estProfit: null, profitStatus: "unknown" };
  }

  let estCost = 0;
  let estRevenue = 0;
  for (const row of r.rows) {
    const cost = money(row.freight_cost);
    const sale = money(row.freight_sale_usd);
    if (cost === null || sale === null) {
      return { estCost: null, estRevenue: null, estProfit: null, profitStatus: "unknown" };
    }
    estCost += cost;
    estRevenue += sale;
  }
  estCost = money(estCost);
  estRevenue = money(estRevenue);
  const estProfit = money(estRevenue - estCost);
  return { estCost, estRevenue, estProfit, profitStatus: estProfit <= 0 ? "no_profit" : "ok" };
}

async function buildGroups(db, rows) {
  const companyMap = await loadCompanyMap(db, rows.flatMap(r => [r.seller_company_code, r.buyer_company_code]));
  const groups = new Map();

  for (const row of rows) {
    const sellerCode = clean(row.seller_company_code, 80);
    const buyerCode = clean(row.buyer_company_code, 80);
    const currency = clean(row.currency || "CNY", 20).toUpperCase();
    const period = periodOf(row);
    const seller = companyMap.get(sellerCode);
    const consolidatable = seller?.payment_consolidation !== false;
    const key = consolidatable
      ? [sellerCode, buyerCode, currency, period].join("|")
      : `invoice|${row.id}`;

    if (!groups.has(key)) {
      groups.set(key, {
        sellerCode,
        sellerName: seller?.name_cn || seller?.name_en || row.seller_name || "",
        buyerCode,
        buyerName: companyMap.get(buyerCode)?.name_cn || companyMap.get(buyerCode)?.name_en || row.buyer_name || "",
        currency,
        period,
        invoiceIds: [],
        totalAmount: 0,
        contractNos: [],
        consolidatable,
      });
    }
    const group = groups.get(key);
    group.invoiceIds.push(row.id);
    group.totalAmount += money(row.amount_incl_tax) || 0;
    if (Array.isArray(row.contract_nos)) group.contractNos.push(...row.contract_nos);
  }

  const out = [];
  for (const group of groups.values()) {
    const est = await estimateProfit(db, group.contractNos);
    let profitStatus = est.profitStatus;
    if (profitStatus === "ok" && est.estCost !== null && group.totalAmount > est.estCost * BELOW_COST_THRESHOLD) {
      profitStatus = "below_cost";
    }
    out.push({
      sellerCode: group.sellerCode,
      sellerName: group.sellerName,
      buyerCode: group.buyerCode,
      buyerName: group.buyerName,
      currency: group.currency,
      period: group.period,
      invoiceIds: group.invoiceIds,
      totalAmount: money(group.totalAmount),
      estCost: est.estCost,
      estRevenue: est.estRevenue,
      estProfit: est.estProfit,
      profitStatus,
      consolidatable: group.consolidatable,
    });
  }

  return out.sort((a, b) =>
    `${a.period}|${a.sellerCode}|${a.buyerCode}|${a.currency}`.localeCompare(
      `${b.period}|${b.sellerCode}|${b.buyerCode}|${b.currency}`
    )
  );
}

async function loadDraftRows(db) {
  const r = await db.query(
    `SELECT id, invoice_no, seller_name, seller_company_code, buyer_name, buyer_company_code,
            amount_incl_tax, currency, issue_date, created_at, contract_nos
       FROM finance_invoices_in fii
      WHERE COALESCE(review_status, '') IN ('pending','')
        AND amount_incl_tax IS NOT NULL
        AND seller_company_code IS NOT NULL
        AND btrim(seller_company_code) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM payment_batch_items pbi WHERE pbi.finance_invoice_in_id = fii.id
        )
      ORDER BY COALESCE(issue_date, created_at), seller_company_code, id`
  );
  return r.rows;
}

async function loadIncomplete(db) {
  const r = await db.query(
    `SELECT id, invoice_no, seller_name, seller_company_code, amount_incl_tax
       FROM finance_invoices_in fii
      WHERE COALESCE(review_status, '') IN ('pending','')
        AND (amount_incl_tax IS NULL OR seller_company_code IS NULL OR btrim(seller_company_code) = '')
        AND NOT EXISTS (
          SELECT 1 FROM payment_batch_items pbi WHERE pbi.finance_invoice_in_id = fii.id
        )
      ORDER BY id DESC
      LIMIT 500`
  );
  return r.rows.map(row => ({
    id: row.id,
    invoiceNo: row.invoice_no || "",
    sellerName: row.seller_name || "",
    reason: invoiceReason(row),
  }));
}

async function handleDraft(req, res) {
  const pool = getPool();
  const [rows, incomplete] = await Promise.all([loadDraftRows(pool), loadIncomplete(pool)]);
  const groups = await buildGroups(pool, rows);
  return json(res, 200, { success: true, groups, incomplete });
}

async function loadRowsForConfirm(client, invoiceIds) {
  const r = await client.query(
    `SELECT id, invoice_no, seller_name, seller_company_code, buyer_name, buyer_company_code,
            review_status,
            amount_incl_tax, currency, issue_date, created_at, contract_nos
       FROM finance_invoices_in
      WHERE id = ANY($1::int[])
      FOR UPDATE`,
    [invoiceIds]
  );
  if (r.rowCount !== invoiceIds.length) {
    throw Object.assign(new Error("some invoices were not found"), { status: 404 });
  }

  const batched = await client.query(
    `SELECT finance_invoice_in_id
       FROM payment_batch_items
      WHERE finance_invoice_in_id = ANY($1::int[])`,
    [invoiceIds]
  );
  if (batched.rowCount) {
    throw Object.assign(new Error("部分发票已经进入付款审批批次，不能重复打包"), { status: 409 });
  }

  const invalid = r.rows.find(row =>
    !["pending", ""].includes(String(row.review_status || "")) ||
    row.amount_incl_tax === null ||
    !clean(row.seller_company_code)
  );
  if (invalid) {
    throw Object.assign(new Error(`发票 ${invalid.id} 状态或关键字段不允许打包`), { status: 409 });
  }
  return r.rows;
}

function assertOneRequestedGroup(group, body) {
  const expected = {
    sellerCode: clean(body.sellerCode, 80),
    buyerCode: clean(body.buyerCode, 80),
    currency: clean(body.currency, 20).toUpperCase(),
    period: clean(body.period, 7),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!value) throw Object.assign(new Error(`${key} required`), { status: 400 });
    if (group[key] !== value) {
      throw Object.assign(new Error(`提交批次与服务端重算结果不一致: ${key}`), { status: 409 });
    }
  }
}

async function handlePost(req, res) {
  const body = req.body || {};
  const invoiceIds = Array.isArray(body.invoiceIds)
    ? [...new Set(body.invoiceIds.map(v => Number.parseInt(v, 10)).filter(Number.isInteger))]
    : [];
  if (!invoiceIds.length) return json(res, 400, { success: false, error: "invoiceIds required" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await loadRowsForConfirm(client, invoiceIds);
    const groups = await buildGroups(client, rows);
    if (groups.length !== 1) {
      throw Object.assign(new Error("所选发票不能组成同一个付款审批批次"), { status: 409 });
    }
    const group = groups[0];
    assertOneRequestedGroup(group, body);

    if (["below_cost", "no_profit"].includes(group.profitStatus) && body.riskAcknowledged !== true) {
      await client.query("ROLLBACK");
      return json(res, 409, {
        success: false,
        error: "该批低于成本/无利润，需要确认风险后才能提交",
        profitStatus: group.profitStatus,
        estProfit: group.estProfit,
      });
    }

    const batch = await client.query(
      `INSERT INTO payment_batches
         (seller_company_code, buyer_company_code, currency, period, total_amount, invoice_count,
          est_cost, est_revenue, est_profit, profit_status, risk_acknowledged,
          status, confirmed_by, confirmed_at, created_at)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'confirmed',$12,NOW(),NOW())
       RETURNING id`,
      [
        group.sellerCode, group.buyerCode, group.currency, group.period,
        group.totalAmount, group.invoiceIds.length, group.estCost, group.estRevenue,
        group.estProfit, group.profitStatus, body.riskAcknowledged === true, actor(req),
      ]
    );
    const batchId = batch.rows[0].id;

    for (const row of rows) {
      await client.query(
        `INSERT INTO payment_batch_items (batch_id, finance_invoice_in_id, amount)
         VALUES ($1,$2,$3)`,
        [batchId, row.id, row.amount_incl_tax]
      );
    }

    await client.query(
      `UPDATE finance_invoices_in
          SET review_status = 'approved', updated_at = NOW()
        WHERE id = ANY($1::int[])`,
      [invoiceIds]
    );

    await client.query("COMMIT");
    return json(res, 200, {
      success: true,
      batchId,
      invoiceCount: group.invoiceIds.length,
      totalAmount: group.totalAmount,
      profitStatus: group.profitStatus,
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    const status = err.code === "23505" ? 409 : (err.status || 500);
    const error = err.code === "23505"
      ? "部分发票已经进入付款审批批次，不能重复打包"
      : err.message;
    console.error("[payment-batches]", err);
    return json(res, status, { success: false, error });
  } finally {
    client.release();
  }
}

async function handleConfirmed(req, res) {
  const period = clean(req.query?.period, 7);
  if (period && !/^\d{4}-\d{2}$/.test(period)) {
    return json(res, 400, { success: false, error: "period must be YYYY-MM" });
  }
  const params = [];
  let where = "";
  if (period) {
    params.push(period);
    where = `WHERE pb.period = $${params.length}`;
  }

  const pool = getPool();
  const r = await pool.query(
    `SELECT pb.*,
            sc.name_cn AS seller_name, bc.name_cn AS buyer_name,
            ba.bank_name, ba.bank_name_en, ba.account_no, ba.account_holder, ba.swift,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', fii.id,
                  'invoiceNo', fii.invoice_no,
                  'amount', pbi.amount,
                  'issueDate', fii.issue_date,
                  'contractNos', fii.contract_nos
                )
                ORDER BY fii.id
              ) FILTER (WHERE fii.id IS NOT NULL),
              '[]'::json
            ) AS invoices
       FROM payment_batches pb
       LEFT JOIN companies sc ON sc.code = pb.seller_company_code
       LEFT JOIN companies bc ON bc.code = pb.buyer_company_code
       LEFT JOIN LATERAL (
         SELECT bank_name, bank_name_en, account_no, account_holder, swift
           FROM bank_accounts
          WHERE company_code = pb.seller_company_code
            AND currency = pb.currency
            AND active = TRUE
          ORDER BY is_default DESC, id ASC
          LIMIT 1
       ) ba ON TRUE
       LEFT JOIN payment_batch_items pbi ON pbi.batch_id = pb.id
       LEFT JOIN finance_invoices_in fii ON fii.id = pbi.finance_invoice_in_id
      ${where}
      GROUP BY pb.id, sc.name_cn, bc.name_cn, ba.bank_name, ba.bank_name_en,
               ba.account_no, ba.account_holder, ba.swift
      ORDER BY pb.confirmed_at DESC, pb.id DESC`,
    params
  );

  return json(res, 200, {
    success: true,
    batches: r.rows.map(row => ({
      id: row.id,
      sellerCode: row.seller_company_code,
      sellerName: row.seller_name || "",
      buyerCode: row.buyer_company_code,
      buyerName: row.buyer_name || "",
      currency: row.currency,
      period: row.period,
      totalAmount: money(row.total_amount),
      invoiceCount: row.invoice_count,
      estCost: money(row.est_cost),
      estRevenue: money(row.est_revenue),
      estProfit: money(row.est_profit),
      profitStatus: row.profit_status,
      riskAcknowledged: row.risk_acknowledged,
      status: row.status,
      confirmedBy: row.confirmed_by,
      confirmedAt: row.confirmed_at,
      bankAccount: row.account_no ? {
        bankName: row.bank_name || "",
        bankNameEn: row.bank_name_en || "",
        accountNo: row.account_no,
        accountHolder: row.account_holder || "",
        swift: row.swift || "",
      } : null,
      invoices: row.invoices || [],
    })),
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!FINANCE_ROLES.has(req.user?.role)) {
    return json(res, 403, { success: false, error: "admin or finance role required" });
  }

  try {
    if (req.method === "GET") {
      const mode = clean(req.query?.mode || "draft", 20);
      if (mode === "draft") return handleDraft(req, res);
      if (mode === "confirmed") return handleConfirmed(req, res);
      return json(res, 400, { success: false, error: "mode must be draft or confirmed" });
    }
    if (req.method === "POST") return handlePost(req, res);
    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (err) {
    console.error("[payment-batches]", err);
    return json(res, 500, { success: false, error: err.message });
  }
}
