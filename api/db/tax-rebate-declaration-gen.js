import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { buildZip, renderExportXls, renderPurchaseXls } from "./tax-rebate-declaration-xls-template.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);

function periodInfo(period) {
  const s = String(period || "").replace(/[^0-9]/g, "");
  if (!/^\d{6}$/.test(s)) return null;
  const m = Number(s.slice(4, 6));
  if (m < 1 || m > 12) return null;
  return {
    period: s,
    start: `${s.slice(0, 4)}-${s.slice(4, 6)}-01`,
    end: new Date(Date.UTC(Number(s.slice(0, 4)), m, 1)).toISOString().slice(0, 10),
  };
}

function batchNo(v) {
  const s = String(v || "001").replace(/[^0-9]/g, "");
  return s.padStart(3, "0").slice(-3);
}

function linkNo(period, batch, seq) {
  return `${period}${batch}${String(seq).padStart(8, "0")}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round(num(v) * 100) / 100;
}

function dateOnly(v) {
  return v ? String(v).slice(0, 10) : "";
}

function itemWeight(row) {
  const amount = num(row.declaration_amount);
  if (amount > 0) return amount;
  const qty = num(row.qty);
  return qty > 0 ? qty : 1;
}

async function updateDeclarationItem(pool, id, body) {
  const fob = body?.fob_usd === "" || body?.fob_usd == null ? null : Number(body.fob_usd);
  if (fob != null && (!Number.isFinite(fob) || fob < 0)) throw new Error("fob_usd must be a non-negative number");
  const source = fob == null ? "pending_pdf_anchor" : "pdf_anchor_manual";
  const r = await pool.query(
    `UPDATE customs_declaration_items
        SET fob_usd=$2,
            fob_usd_source=$3,
            raw = COALESCE(raw, '{}'::jsonb) || jsonb_build_object('fob_usd_source', $3, 'fob_usd_updated_at', now()),
            updated_at=now()
      WHERE id=$1
      RETURNING id, declaration_id, hs_code, declaration_name_cn, fob_usd, fob_usd_source`,
    [id, fob, source]
  );
  if (!r.rows.length) throw new Error("declaration item not found");
  return r.rows[0];
}

async function loadRows(pool, info) {
  const r = await pool.query(
    `WITH product_rates AS (
       SELECT hs_code, MAX(rebate_rate) AS rebate_rate
         FROM products
        WHERE hs_code IS NOT NULL AND hs_code <> '' AND rebate_rate IS NOT NULL
        GROUP BY hs_code
     )
     SELECT
       fer.customs_no AS fer_customs_no, fer.contract_no, fer.export_date AS fer_export_date,
       d.id AS declaration_id, d.declaration_no, d.declared_at,
       i.id AS item_id, i.hs_code, i.declaration_name_cn, i.unit, i.qty, i.declaration_amount,
       i.sort_order, i.fob_usd, i.fob_usd_source,
       l.id AS link_id, l.invoice_id, l.invoice_no AS link_invoice_no, l.factory_code, l.allocated_amount, l.link_status,
       inv.invoice_no, inv.invoice_code, inv.issue_date, inv.seller_name, inv.seller_tax_id,
       inv.amount_ex_tax, inv.total_tax, inv.amount_incl_tax, inv.tax_rate,
       pr.rebate_rate AS product_rebate_rate
     FROM finance_export_rebates fer
     JOIN customs_declarations d
       ON d.declaration_no = COALESCE(fer.raw->>'declaration_no', fer.customs_no)
       OR d.declaration_no = fer.customs_no
     JOIN customs_declaration_items i ON i.declaration_id = d.id
     LEFT JOIN invoice_customs_links l
       ON l.customs_no IN (d.declaration_no, fer.customs_no)
      AND COALESCE(l.link_status, 'active') = 'active'
     LEFT JOIN finance_invoices_in inv
       ON inv.id = l.invoice_id OR (l.invoice_id IS NULL AND inv.invoice_no = l.invoice_no)
     LEFT JOIN product_rates pr ON pr.hs_code = i.hs_code
     WHERE fer.export_date >= $1::date AND fer.export_date < $2::date
     ORDER BY d.declaration_no, COALESCE(i.sort_order, 999), i.id, l.id NULLS LAST`,
    [info.start, info.end]
  );
  const rows = r.rows;
  const hsRates = await loadHsRates(pool, [...new Set(rows.map((x) => x.hs_code).filter(Boolean))]);
  for (const row of rows) {
    if (hsRates.has(row.hs_code)) row.hs_rebate_rate = hsRates.get(row.hs_code);
  }
  return rows;
}

function ident(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

async function loadHsRates(pool, hsCodes) {
  const out = new Map();
  if (!hsCodes.length) return out;
  const exists = await pool.query(`SELECT to_regclass('public.hs_rebate_rates') AS t`);
  if (!exists.rows[0]?.t) return out;
  const colsR = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='hs_rebate_rates'`
  );
  const cols = new Set(colsR.rows.map((r) => r.column_name));
  const hsCol = ["hs_code", "commodity_code", "code"].find((c) => cols.has(c));
  const rateCol = ["rebate_rate", "tax_rebate_rate", "refund_rate"].find((c) => cols.has(c));
  if (!hsCol || !rateCol) return out;
  const r = await pool.query(
    `SELECT ${ident(hsCol)} AS hs_code, ${ident(rateCol)} AS rebate_rate
       FROM hs_rebate_rates
      WHERE ${ident(hsCol)} = ANY($1::text[]) AND ${ident(rateCol)} IS NOT NULL`,
    [hsCodes]
  );
  for (const row of r.rows) out.set(row.hs_code, Number(row.rebate_rate));
  return out;
}

export function buildValidation(rows) {
  const byDecl = new Map();
  const validations = [];
  for (const row of rows) {
    if (!byDecl.has(row.declaration_no)) byDecl.set(row.declaration_no, { invoices: 0, fob: 0, rate: 0, taxRate: 0 });
    const state = byDecl.get(row.declaration_no);
    if (row.invoice_no || row.link_invoice_no) state.invoices += 1;
    const fobMissing = row.fob_usd == null || row.fob_usd_source === "pending_pdf_anchor";
    if (fobMissing) state.fob += 1;
    const rate = row.hs_rebate_rate ?? row.product_rebate_rate;
    if (rate == null || Number(rate) <= 0) state.rate += 1;
    if ((row.invoice_no || row.link_invoice_no) && (row.tax_rate == null || Number(row.tax_rate) <= 0)) state.taxRate += 1;
  }
  for (const [declarationNo, state] of byDecl.entries()) {
    if (!state.invoices) validations.push({ level: "error", type: "missing_invoice", declaration_no: declarationNo, message: "报关单缺有效进项票绑定" });
    if (state.fob) validations.push({ level: "error", type: "missing_fob_usd", declaration_no: declarationNo, message: `缺美元FOB锚定值 ${state.fob} 行，需人工核对报关单PDF后补录` });
    if (state.rate) validations.push({ level: "error", type: "missing_rebate_rate", declaration_no: declarationNo, message: `缺退税率 ${state.rate} 行` });
    if (state.taxRate) validations.push({ level: "error", type: "missing_tax_rate", declaration_no: declarationNo, message: `缺征税率 ${state.taxRate} 行` });
  }
  if (!rows.length) validations.push({ level: "error", type: "no_rows", message: "该申报年月未找到可生成的报关单明细" });
  return validations;
}

function rowInvoiceWeight(row) {
  const amount = num(row.allocated_amount ?? row.amount_ex_tax);
  return amount > 0 ? amount : 1;
}

export function buildPairs(rows, info, batch) {
  const linkTotals = new Map();
  const exportSplits = new Map();
  for (const row of rows) {
    const key = row.link_id || `missing-${row.item_id}`;
    const cur = linkTotals.get(key) || { total: 0, rows: [] };
    cur.total += itemWeight(row);
    cur.rows.push(row);
    linkTotals.set(key, cur);

    const itemKey = row.item_id || `missing-${row.declaration_no}-${row.sort_order || ""}-${row.hs_code || ""}`;
    const split = exportSplits.get(itemKey) || { total: 0 };
    split.total += rowInvoiceWeight(row);
    exportSplits.set(itemKey, split);
  }
  const exportRows = [];
  const purchaseRows = [];
  let seq = 1;
  for (const row of rows) {
    const key = row.link_id || `missing-${row.item_id}`;
    const group = linkTotals.get(key) || { total: itemWeight(row), rows: [row] };
    const no = linkNo(info.period, batch, seq);
    const weight = itemWeight(row) / (group.total || itemWeight(row));
    const itemKey = row.item_id || `missing-${row.declaration_no}-${row.sort_order || ""}-${row.hs_code || ""}`;
    const exportSplit = exportSplits.get(itemKey);
    // Multiple active invoices can point at one customs item; split export qty/FOB by invoice weight so export totals stay anchored.
    const exportWeight = rowInvoiceWeight(row) / (exportSplit?.total || rowInvoiceWeight(row));
    const invoiceAmount = row.allocated_amount ?? row.amount_ex_tax ?? 0;
    const taxable = round2(num(invoiceAmount) * weight);
    const rebateRate = Number(row.hs_rebate_rate ?? row.product_rebate_rate ?? 0);
    const note = row.fob_usd == null || row.fob_usd_source === "pending_pdf_anchor" ? "缺美元FOB锚定值" : "";
    const qty = row.qty == null ? "" : round2(Number(row.qty) * exportWeight);
    const fobUsd = row.fob_usd == null ? null : round2(Number(row.fob_usd) * exportWeight);
    exportRows.push({
      link_no: no,
      declaration_no: row.declaration_no,
      sort_order: row.sort_order || 1,
      export_date: dateOnly(row.declared_at || row.fer_export_date),
      hs_code: row.hs_code,
      goods_name: row.declaration_name_cn,
      unit: row.unit,
      qty,
      fob_usd: fobUsd,
      note,
    });
    if (row.invoice_no || row.link_invoice_no) {
      purchaseRows.push({
        link_no: no,
        invoice_no: row.invoice_no || row.link_invoice_no,
        seller_tax_id: row.seller_tax_id,
        issue_date: dateOnly(row.issue_date),
        hs_code: row.hs_code,
        goods_name: row.declaration_name_cn,
        unit: row.unit,
        qty: row.qty == null ? "" : Number(row.qty),
        taxable_amount: taxable,
        tax_rate: row.tax_rate == null ? null : Number(row.tax_rate),
        rebate_rate: rebateRate,
        rebate_amount: round2(taxable * rebateRate),
        note: group.rows.length > 1 ? "按报关项金额/数量权重分摊进项票金额" : "",
      });
    }
    seq += 1;
  }
  const totalRebate = round2(purchaseRows.reduce((s, r) => s + num(r.rebate_amount), 0));
  return { exportRows, purchaseRows, totalRebate };
}

export async function buildDeclarationPackage({ period, batch = "001" } = {}) {
  const info = periodInfo(period);
  if (!info) throw new Error("period must be YYYYMM");
  const b = batchNo(batch);
  const pool = getPool();
  const rows = await loadRows(pool, info);
  const validations = buildValidation(rows);
  const data = buildPairs(rows, info, b);
  return { success: true, period: info.period, batch: b, validations, ...data };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!FINANCE_ROLES.has(req.user?.role)) return res.status(403).json({ error: "仅财务/管理员可操作" });
  const pool = getPool();
  try {
    const itemMatch = req.path.match(/\/declaration-items\/(\d+)$/);
    if (itemMatch && req.method === "POST") {
      const row = await updateDeclarationItem(pool, itemMatch[1], req.body || {});
      return res.json({ success: true, data: row });
    }
    const input = req.method === "POST" ? { ...req.query, ...(req.body || {}) } : req.query;
    const pkg = await buildDeclarationPackage(input);
    if (input.preview === "1" || input.validate === "1") return res.json(pkg);
    const [exportXls, purchaseXls] = await Promise.all([
      renderExportXls(pkg),
      renderPurchaseXls(pkg),
    ]);
    const zip = buildZip([
      { name: "出口明细.xls", data: exportXls },
      { name: "进货明细.xls", data: purchaseXls },
    ]);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=\"tax-rebate-${pkg.period}-${pkg.batch}.zip\"`);
    return res.status(200).send(zip);
  } catch (e) {
    console.error("[tax-rebate-declaration-gen]", e);
    return res.status(500).json({ error: e.message });
  }
}
