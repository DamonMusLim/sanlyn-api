import { getPool } from "../../db.js";

function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function sumMoney(a, b) {
  return money((money(a) || 0) + (money(b) || 0)) || 0;
}

function keyOf(row, key) {
  const value = row?.[key];
  return value === null || value === undefined ? "" : String(value);
}

function amount(row, field) {
  return money(row?.[field]);
}

function resolveStatus({ expectedAmount, uploadedAmount, diffAmount, invoiceCount, confirmedAt, tolerance }) {
  if (expectedAmount === null) return "need_amount";
  if ((!invoiceCount || uploadedAmount <= 0) && !confirmedAt) return "pending_confirm";
  if ((!invoiceCount || uploadedAmount <= 0) && confirmedAt) return "confirmed_wait_invoice";
  if (Math.abs(diffAmount || 0) <= tolerance) return "matched";
  if (uploadedAmount < expectedAmount - tolerance) return "partial_uploaded";
  if (uploadedAmount > expectedAmount + tolerance) return "over_issued";
  return "pending_confirm";
}

function buildActualMap(actualRows, matchKey, actualField) {
  const map = new Map();

  for (const row of actualRows) {
    const key = keyOf(row, matchKey);
    if (!key) continue;

    const cur = map.get(key) || {
      actual_amount: 0,
      invoice_count: 0,
      invoices: [],
    };

    cur.actual_amount = sumMoney(cur.actual_amount, amount(row, actualField) || 0);
    cur.invoice_count += 1;
    cur.invoices.push(row);
    map.set(key, cur);
  }

  return map;
}

function summarize(rows) {
  const statusCounts = {};
  let expected = 0;
  let uploaded = 0;
  let diff = 0;

  for (const row of rows) {
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
    expected = sumMoney(expected, row.expected_amount || 0);
    uploaded = sumMoney(uploaded, row.uploaded_amount || 0);
    diff = sumMoney(diff, row.diff_amount || 0);
  }

  return {
    customs_count: rows.length,
    ...statusCounts,
    status_counts: statusCounts,
    expected_amount: money(expected) || 0,
    uploaded_amount: money(uploaded) || 0,
    diff_amount: money(diff) || 0,
  };
}

export async function runReadonly(pool = getPool(), config, { start, end }) {
  if (!config?.expected?.sql || !config?.actual?.sql) {
    throw new Error("Invalid recon config: expected.sql and actual.sql are required");
  }

  const matchKey = config.match_keys?.[0];
  if (!matchKey) throw new Error("Invalid recon config: match_keys[0] is required");

  const expectedField = config.amount_fields?.expected || "expected_amount";
  const actualField = config.amount_fields?.actual || "actual_amount";
  const tolerance = money(config.amount_fields?.tolerance ?? config.tolerance?.amount ?? 1) ?? 1;

  const expected = (await pool.query(config.expected.sql, [start, end])).rows;
  const actual = (await pool.query(config.actual.sql, [])).rows;
  const actualMap = buildActualMap(actual, matchKey, actualField);

  const rows = expected.map((row) => {
    const key = keyOf(row, matchKey);
    const matched = actualMap.get(key) || { actual_amount: 0, invoice_count: 0, invoices: [] };
    const expectedAmount = amount(row, expectedField);
    const uploadedAmount = money(matched.actual_amount) || 0;
    const diffAmount = expectedAmount === null ? null : money(expectedAmount - uploadedAmount);
    const status = resolveStatus({
      expectedAmount,
      uploadedAmount,
      diffAmount,
      invoiceCount: matched.invoice_count,
      confirmedAt: row.confirmed_at || row.expected_amount_confirmed_at || null,
      tolerance,
    });

    return {
      customs_no: row.customs_no || null,
      contract_no: row.contract_no || null,
      factory_code: row.factory_code || null,
      factory_name: row.factory_name || null,
      status,
      expected_amount: expectedAmount,
      uploaded_amount: uploadedAmount,
      diff_amount: diffAmount,
      valid_invoice_count: matched.invoice_count,
    };
  });

  return {
    summary: summarize(rows),
    rows,
  };
}
