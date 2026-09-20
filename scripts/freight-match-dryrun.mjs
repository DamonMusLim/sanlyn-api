import fs from "fs";
import pg from "pg";
import { matchFreight } from "../api/db/lib/freight-match.js";
import { columns, loadFreightMatchInput } from "../api/db/lib/freight-match-sources.js";

const { Pool } = pg;
const ENV_PATH = "/opt/sanlyn-api-test/.env";
const STATUS_KEYS = ["settled", "unpaid", "pending_split", "no_invoice", "cif"];
const ACCEPTANCE = { maxNoInvoice: 68, cif: 3, minSettled: 21, migratedInvoiceCount: 94 };

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = fs.readFileSync(ENV_PATH, "utf8");
  const line = text.split(/\r?\n/).find((x) => /^\s*DATABASE_URL\s*=/.test(x));
  if (!line) throw new Error(`${ENV_PATH} 缺 DATABASE_URL`);
  const raw = line.replace(/^\s*DATABASE_URL\s*=\s*/, "").trim();
  return raw.replace(/^['"]|['"]$/g, "");
}

function countStatuses(rows) {
  const out = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
  for (const row of rows) {
    const code = row.settle_status?.code;
    if (Object.hasOwn(out, code)) out[code] += 1;
  }
  return out;
}

function keyOf(row) {
  return row.cy_no || row.bl_no;
}

function invoiceBasis(row) {
  return (row.invoices || []).map((x) => [
    x.invoice_no,
    x.source,
    x.source_bill_no || x.source_id || x.source_file || "",
    x.currency || "",
    x.amount_usd ? `USD ${Number(x.amount_usd).toFixed(2)}` : "",
    x.amount_cny ? `CNY ${Number(x.amount_cny).toFixed(2)}` : "",
  ].filter(Boolean).join(" ")).join("; ");
}

function receiptBasis(row) {
  return (row.receipts || []).map((x) => [
    `${x.type}#${x.id}`,
    x.status,
    x.currency,
    Number(x.amount || 0).toFixed(2),
    x.group_note || x.memo_ref || "",
  ].filter(Boolean).join(" ")).join("; ");
}

function diffRows(oldRows, newRows) {
  const oldMap = new Map(oldRows.map((r) => [keyOf(r), r]));
  const newMap = new Map(newRows.map((r) => [keyOf(r), r]));
  const keys = Array.from(new Set([...oldMap.keys(), ...newMap.keys()])).sort();
  return keys.flatMap((key) => {
    const oldRow = oldMap.get(key);
    const newRow = newMap.get(key);
    const oldStatus = oldRow?.settle_status?.code || "missing";
    const newStatus = newRow?.settle_status?.code || "missing";
    if (oldStatus === newStatus && invoiceBasis(oldRow || {}) === invoiceBasis(newRow || {})) return [];
    return [{
      ticket: key,
      bl_no: newRow?.bl_no || oldRow?.bl_no || "",
      old_status: oldStatus,
      new_status: newStatus,
      old_basis: invoiceBasis(oldRow || {}) || receiptBasis(oldRow || {}),
      new_basis: invoiceBasis(newRow || {}) || receiptBasis(newRow || {}),
    }];
  });
}

const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const upper = (v) => String(v ?? "").trim().toUpperCase();

function dueTotal(row) {
  const invoices = row?.invoices || [];
  return {
    usd: num(invoices.reduce((a, x) => a + num(x.amount_usd), 0)),
    cny: num(invoices.reduce((a, x) => a + num(x.amount_cny), 0)),
  };
}

function sameMoney(a, b) {
  return Math.abs(num(a) - num(b)) <= 0.01;
}

async function loadMigratedInvoiceNos(client) {
  const billCols = await columns(client, "freight_bills");
  if (!billCols.has("invoice_no") || !billCols.has("bill_source")) return [];
  const r = await client.query(
    `SELECT DISTINCT BTRIM(invoice_no) AS invoice_no
       FROM freight_bills
      WHERE bill_source = 'fir_migrate_0920_v6'
        AND NULLIF(BTRIM(invoice_no), '') IS NOT NULL
      ORDER BY BTRIM(invoice_no)`
  );
  return r.rows.map((x) => x.invoice_no);
}

function migratedAmountDiffs(oldRows, newRows, migratedInvoiceNos) {
  const migrated = new Set(migratedInvoiceNos.map(upper));
  const newMap = new Map(newRows.map((r) => [keyOf(r), r]));
  return oldRows.flatMap((oldRow) => {
    const touched = (oldRow.invoices || []).some((x) => migrated.has(upper(x.invoice_no)));
    if (!touched) return [];
    const newRow = newMap.get(keyOf(oldRow));
    const oldDue = dueTotal(oldRow);
    const newDue = dueTotal(newRow || {});
    if (sameMoney(oldDue.usd, newDue.usd) && sameMoney(oldDue.cny, newDue.cny)) return [];
    return [{
      ticket: keyOf(oldRow),
      bl_no: oldRow.bl_no || newRow?.bl_no || "",
      old_due_usd: oldDue.usd,
      new_due_usd: newDue.usd,
      old_due_cny: oldDue.cny,
      new_due_cny: newDue.cny,
      old_invoices: invoiceBasis(oldRow),
      new_invoices: invoiceBasis(newRow || {}),
    }];
  });
}

function acceptanceFailures({ newCounts, migratedInvoiceNos, amountDiffs }) {
  const failures = [];
  if (newCounts.no_invoice > ACCEPTANCE.maxNoInvoice) failures.push(`no_invoice=${newCounts.no_invoice} > ${ACCEPTANCE.maxNoInvoice}`);
  if (newCounts.cif !== ACCEPTANCE.cif) failures.push(`cif=${newCounts.cif} != ${ACCEPTANCE.cif}`);
  if (newCounts.settled < ACCEPTANCE.minSettled) failures.push(`settled=${newCounts.settled} < ${ACCEPTANCE.minSettled}`);
  if (migratedInvoiceNos.length !== ACCEPTANCE.migratedInvoiceCount) failures.push(`migrated_invoice_count=${migratedInvoiceNos.length} != ${ACCEPTANCE.migratedInvoiceCount}`);
  if (amountDiffs.length) failures.push(`migrated_amount_diff_tickets=${amountDiffs.length}`);
  return failures;
}

async function run() {
  const pool = new Pool({ connectionString: loadDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const oldInput = await loadFreightMatchInput(client, { receivableSource: "registry" });
    const newInput = await loadFreightMatchInput(client, { receivableSource: "bills" });
    const oldRows = matchFreight(oldInput);
    const newRows = matchFreight(newInput);
    const oldCounts = countStatuses(oldRows);
    const newCounts = countStatuses(newRows);
    const diffs = diffRows(oldRows, newRows);
    const migratedInvoiceNos = await loadMigratedInvoiceNos(client);
    const amountDiffs = migratedAmountDiffs(oldRows, newRows, migratedInvoiceNos);
    const failures = acceptanceFailures({ newCounts, migratedInvoiceNos, amountDiffs });

    console.log("① 状态汇总");
    console.table(STATUS_KEYS.map((status) => ({
      status,
      old_registry: oldCounts[status],
      new_freight_bills: newCounts[status],
    })));
    console.log(`票数: old=${oldRows.length} new=${newRows.length} expected_total_note=brief写179`);
    console.log(`迁移批次发票数: ${migratedInvoiceNos.length} expected=${ACCEPTANCE.migratedInvoiceCount}`);

    console.log("\n② 验收断言");
    console.table([
      { check: "no_invoice <= 68", actual: newCounts.no_invoice, pass: newCounts.no_invoice <= ACCEPTANCE.maxNoInvoice },
      { check: "cif = 3", actual: newCounts.cif, pass: newCounts.cif === ACCEPTANCE.cif },
      { check: "settled >= 21", actual: newCounts.settled, pass: newCounts.settled >= ACCEPTANCE.minSettled },
      { check: "migrated invoice count = 94", actual: migratedInvoiceNos.length, pass: migratedInvoiceNos.length === ACCEPTANCE.migratedInvoiceCount },
      { check: "migrated ticket receivable equals registry", actual: amountDiffs.length, pass: amountDiffs.length === 0 },
    ]);

    if (amountDiffs.length) {
      console.log("\n③ 迁移票应收金额不等");
      console.table(amountDiffs);
    }

    console.log("\n④ 逐票差异清单");
    if (!diffs.length) {
      console.log("无差异");
    } else {
      console.table(diffs);
    }
    if (failures.length) {
      console.error(`\n验收: FAIL ${failures.join("; ")}`);
      process.exitCode = 1;
    } else {
      console.log("\n验收: PASS");
    }
    await client.query("ROLLBACK");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
