'use strict';

import XLSX from 'xlsx';
import { normalizeBlNo, normalizeCostLine, normalizeCurrency } from './normalize.js';

const DEFAULT_PROFILE = {
  forwarder: 'zhongyuan',
  header_row_index: 13,
  ticket_split_regex: '^\\s*\\d+\\s*[/／]\\s*\\S',
  columns: {
    sailing_date: 0,
    bl_or_bill_to: 1,
    name_raw: 2,
    currency: 3,
    unit_price: 4,
    qty: 5,
    amount: 6,
    invoice_type: 7,
    total_cny_0: 8,
    total_cny_6: 9,
    total_cny_9: 10,
    total_usd: 11,
    destination_port: 12,
    carrier: 13,
    container_type: 14,
    container_no: 15,
    transport_mode: 16
  }
};

function parse(buffer, mime, profileHint) {
  const profile = resolveProfile(profileHint);
  const columns = profile.columns;
  const splitRe = new RegExp(profile.ticket_split_regex || DEFAULT_PROFILE.ticket_split_regex);

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: '',
    raw: false,
    blankrows: true
  });

  const result = {
    forwarder: profile.forwarder || 'zhongyuan',
    bill_month: detectBillMonth(rows),
    bills: [],
    totals: { cny_0: 0, cny_6: 0, cny_9: 0, usd: 0 },
    checksum: { ok: true, detail: [] }
  };

  let current = null;
  const startRow = Number.isInteger(profile.header_row_index) ? profile.header_row_index + 1 : 14;

  for (let r = startRow; r < rows.length; r += 1) {
    const row = rows[r] || [];

    if (String(cell(row, columns.invoice_type)).includes('合计')) {
      result.totals = {
        cny_0: round2(num(cell(row, columns.total_cny_0))),
        cny_6: round2(num(cell(row, columns.total_cny_6))),
        cny_9: round2(num(cell(row, columns.total_cny_9))),
        usd: round2(num(cell(row, columns.total_usd)))
      };
      continue;
    }

    const marker = cell(row, columns.bl_or_bill_to);
    if (splitRe.test(marker)) {
      current = startBill(marker, result.bills.length + 1);
      result.bills.push(current);
      continue;
    }

    const nameRaw = cell(row, columns.name_raw);
    if (!current || !nameRaw || isMetaName(nameRaw)) continue;

    mergeBillFields(current, row, columns);

    const currency = normalizeCurrency(cell(row, columns.currency));
    const line = normalizeCostLine({
      name_raw: nameRaw,
      currency,
      unit_price: num(cell(row, columns.unit_price)),
      qty: num(cell(row, columns.qty)),
      amount: num(cell(row, columns.amount)),
      invoice_type: normalizeInvoiceType(cell(row, columns.invoice_type)),
      bill_to_raw: cell(row, columns.bl_or_bill_to)
    });

    if (line.amount !== 0) current.cost_lines.push(line);

    if (compact(nameRaw) === '海运费') {
      current.declared_totals = {
        cny_0: num(cell(row, columns.total_cny_0)),
        cny_6: num(cell(row, columns.total_cny_6)),
        cny_9: num(cell(row, columns.total_cny_9)),
        usd: num(cell(row, columns.total_usd))
      };
    }
  }

  for (const bill of result.bills) finalizeBill(bill, result.checksum.detail);

  const computedTotals = computeTotals(result.bills);
  if (isEmptyTotals(result.totals)) result.totals = computedTotals;
  addTotalsCheck(result.checksum.detail, computedTotals, result.totals);
  result.checksum.ok = result.checksum.detail.every((d) => d.ok);
  roundTotals(result.totals);

  return result;
}

function resolveProfile(profileHint) {
  if (!profileHint || typeof profileHint !== 'object') return DEFAULT_PROFILE;
  return Object.assign({}, DEFAULT_PROFILE, profileHint, {
    columns: Object.assign({}, DEFAULT_PROFILE.columns, profileHint.columns || {})
  });
}

function startBill(marker, fallbackSeq) {
  const raw = stripTicketPrefix(marker);
  const bl = normalizeBlNo(raw);
  return {
    seq: parseSeq(marker) || fallbackSeq,
    bl_raw: raw,
    bl_no: bl.bl_no,
    is_booking_no: bl.is_booking_no,
    destination_port: '',
    carrier: '',
    container_type: '',
    container_qty: 0,
    container_no: '',
    transport_mode: '',
    cost_lines: [],
    subtotal_cny: 0,
    subtotal_usd: 0,
    declared_totals: { cny_0: 0, cny_6: 0, cny_9: 0, usd: 0 }
  };
}

function mergeBillFields(bill, row, columns) {
  bill.destination_port = bill.destination_port || cell(row, columns.destination_port);
  bill.carrier = bill.carrier || cell(row, columns.carrier);
  bill.container_type = bill.container_type || cell(row, columns.container_type);
  bill.container_qty = bill.container_qty || parseContainerQty(cell(row, columns.container_type));
  bill.container_no = bill.container_no || cell(row, columns.container_no);
  bill.transport_mode = bill.transport_mode || cell(row, columns.transport_mode);
}

function finalizeBill(bill, detail) {
  const sums = sumBillLines(bill);
  bill.subtotal_cny = round2(sums.cny);
  bill.subtotal_usd = round2(sums.usd);

  const declaredCny = round2(
    num(bill.declared_totals.cny_0) +
    num(bill.declared_totals.cny_6) +
    num(bill.declared_totals.cny_9)
  );
  const declaredUsd = round2(num(bill.declared_totals.usd));

  detail.push({
    scope: 'bill',
    seq: bill.seq,
    bl_no: bill.bl_no,
    ok: moneyEq(bill.subtotal_cny, declaredCny) && moneyEq(bill.subtotal_usd, declaredUsd),
    computed: { cny: bill.subtotal_cny, usd: bill.subtotal_usd },
    declared: { cny: declaredCny, usd: declaredUsd }
  });
}

function computeTotals(bills) {
  const totals = { cny_0: 0, cny_6: 0, cny_9: 0, usd: 0 };

  for (const bill of bills) {
    for (const line of bill.cost_lines) {
      const amount = num(line.amount);
      if (line.currency === 'USD') totals.usd += amount;
      else if (line.invoice_type === '6%专票') totals.cny_6 += amount;
      else if (line.invoice_type === '9%专票') totals.cny_9 += amount;
      else totals.cny_0 += amount;
    }
  }

  roundTotals(totals);
  return totals;
}

function addTotalsCheck(detail, computed, declared) {
  detail.push({
    scope: 'totals',
    ok: moneyEq(computed.cny_0, declared.cny_0) &&
      moneyEq(computed.cny_6, declared.cny_6) &&
      moneyEq(computed.cny_9, declared.cny_9) &&
      moneyEq(computed.usd, declared.usd),
    computed,
    declared: Object.assign({}, declared)
  });
}

function sumBillLines(bill) {
  return bill.cost_lines.reduce((acc, line) => {
    if (line.currency === 'USD') acc.usd += num(line.amount);
    else acc.cny += num(line.amount);
    return acc;
  }, { cny: 0, usd: 0 });
}

function stripTicketPrefix(value) {
  return String(value || '').replace(/^\s*\d+\s*[/／]\s*/, '').trim();
}

function normalizeInvoiceType(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/6/.test(text)) return '6%专票';
  if (/9/.test(text)) return '9%专票';
  if (/0|普票|免税/.test(text)) return '0%普票';
  return text;
}

function detectBillMonth(rows) {
  const text = rows.slice(0, 20).map((r) => r.join(' ')).join(' ');
  const m1 = text.match(/(20\d{2})[-/.年]\s*(\d{1,2})\s*月?/);
  if (m1) return `${m1[1]}-${String(m1[2]).padStart(2, '0')}`;
  const m2 = text.match(/(\d{1,2})\s*月/);
  return m2 ? String(m2[1]).padStart(2, '0') : '';
}

function isMetaName(name) {
  return /费用名称|费目|小计|合计|总计/.test(String(name || ''));
}

function parseSeq(value) {
  const m = String(value || '').match(/^\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

function parseContainerQty(value) {
  const text = String(value || '');
  const m = text.match(/^\s*(\d+)\s*[xX*×]/);
  if (m) return Number(m[1]);
  const nums = text.match(/\d+/g);
  if (!nums) return 0;
  return Number(nums[0]) || 0;
}

function cell(row, index) {
  if (index === undefined || index < 0) return '';
  return String(row[index] === undefined || row[index] === null ? '' : row[index]).trim();
}

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value || '').replace(/,/g, '').replace(/[￥$¥\s]/g, '');
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

function compact(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function roundTotals(totals) {
  Object.keys(totals).forEach((key) => {
    totals[key] = round2(totals[key]);
  });
}

function moneyEq(a, b) {
  return Math.abs(round2(a) - round2(b)) < 0.01;
}

function isEmptyTotals(totals) {
  return !totals.cny_0 && !totals.cny_6 && !totals.cny_9 && !totals.usd;
}

export default parse;
export { parse };
