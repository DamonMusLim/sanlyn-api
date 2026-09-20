const norm = (v) => String(v ?? "").trim();
const upper = (v) => norm(v).toUpperCase();
const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const date10 = (v) => (v ? String(v).slice(0, 10) : null);
const ccy = (v) => {
  const s = upper(v);
  return s === "RMB" || s === "人民币" ? "CNY" : s;
};

export const ticketKey = (t) => norm(t.cy_no || t.shipment_no) || norm(t.bl_no);

function normalizeBlNo(v) {
  return upper(v).replace(/[^A-Z0-9]/g, "");
}

function blTail(v) {
  const s = normalizeBlNo(v);
  return s.length >= 8 ? s.slice(-8) : "";
}

function uniqueIndex(rows, keyFn) {
  const map = new Map();
  const dup = new Set();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!key) continue;
    if (map.has(key)) dup.add(key);
    else map.set(key, row);
  }
  for (const key of dup) map.delete(key);
  return map;
}

function invoiceDateFromNo(v) {
  return upper(v).match(/-(\d{8})(?:-\d+)?$/)?.[1]?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") || null;
}

async function relationExists(pool, name) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.views WHERE table_schema = current_schema() AND table_name = $1
      UNION ALL
     SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1
      LIMIT 1`,
    [name]
  );
  return r.rowCount > 0;
}

export async function columns(pool, name) {
  if (!(await relationExists(pool, name))) return new Set();
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [name]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

export async function rowsOrEmpty(pool, table, sql) {
  if (!(await relationExists(pool, table))) return [];
  return (await pool.query(sql)).rows;
}

function parseJsonish(raw) {
  const text = norm(raw);
  if (!text) return null;
  try {
    let data = JSON.parse(text);
    if (typeof data === "string") data = JSON.parse(data);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function parseFreightRefs(raw, blNo) {
  const data = parseJsonish(raw);
  if (!data?.freight_invoice) return null;
  const amountText = norm(data.freight_amount);
  const usd = amountText.match(/USD\s*([\d,]+(?:\.\d+)?)/i)?.[1];
  const cnyAmount = amountText.match(/(?:CNY|RMB|人民币|¥)\s*([\d,]+(?:\.\d+)?)/i)?.[1];
  return {
    bl_no: blNo || data.bl || null,
    invoice_no: norm(data.freight_invoice),
    currency: usd ? "USD" : cnyAmount ? "CNY" : "",
    amount_usd: usd ? num(usd) : 0,
    amount_cny: cnyAmount ? num(cnyAmount) : 0,
    invoice_date: invoiceDateFromNo(data.freight_invoice),
    is_cif: false,
    source: "shipping_plans.freight_refs",
    source_id: null,
    source_file: null,
    note: amountText || "amount unavailable",
  };
}

function applyFx(invoices, fxRows) {
  const rates = (fxRows || [])
    .filter((x) => upper(x.currency_pair) === "USD_CNY" && num(x.rate))
    .map((x) => ({ date: date10(x.fetched_at), rate: num(x.rate) }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const inv of invoices) {
    if (ccy(inv.currency) !== "USD" || !num(inv.amount_usd) || num(inv.amount_cny)) continue;
    const d = invoiceDateFromNo(inv.invoice_no) || date10(inv.invoice_date);
    const rate = [...rates].reverse().find((x) => !d || x.date <= d)?.rate || rates.at(-1)?.rate || 0;
    if (!rate) continue;
    inv.fx_rate = Math.round((rate + 0.1) * 10000) / 10000;
    inv.amount_cny = num(inv.amount_usd * inv.fx_rate);
    inv.note = `${inv.note ? `${inv.note}; ` : ""}按 ${inv.fx_rate.toFixed(4)} 折 ¥${inv.amount_cny.toFixed(2)}`;
  }
}

function addInvoice(byKey, key, inv) {
  if (!key || !byKey.has(key) || !norm(inv.invoice_no)) return;
  const list = byKey.get(key);
  if (list.some((x) => upper(x.invoice_no) === upper(inv.invoice_no))) return;
  list.push({
    invoice_no: norm(inv.invoice_no),
    currency: ccy(inv.currency),
    amount_usd: num(inv.amount_usd),
    amount_cny: num(inv.amount_cny),
    invoice_date: date10(inv.invoice_date || inv.issue_date || inv.bill_date),
    is_cif: ["t", "true", true].includes(inv.is_cif),
    source: inv.source || "registry",
    source_id: inv.source_id || null,
    source_bill_no: inv.source_bill_no || null,
    source_file: inv.source_file || null,
    note: inv.note || null,
  });
}

export function buildInvoiceByTicket({ tickets = [], plans = [], registry = [], bills = [], fio = [], fx = [] }) {
  const byKey = new Map(tickets.map((t) => [ticketKey(t), []]));
  const ticketsByBl = uniqueIndex(tickets, (t) => normalizeBlNo(t.bl_no));
  const ticketsByBlTail = uniqueIndex(tickets, (t) => blTail(t.bl_no));
  const ticketForBl = (blNo) => ticketsByBl.get(normalizeBlNo(blNo)) || ticketsByBlTail.get(blTail(blNo));
  for (const inv of registry || []) addInvoice(byKey, ticketKey(ticketForBl(inv.bl_no) || {}), inv);
  for (const inv of bills || []) addInvoice(byKey, ticketKey(ticketForBl(inv.bl_no) || {}), inv);
  for (const p of plans || []) {
    const t = ticketForBl(p.bl_no) || tickets.find((x) => upper(x.cy_no) === upper(p.shipment_no));
    const inv = parseFreightRefs(p.freight_refs || p.freight_refs_0918, p.bl_no);
    if (t && inv) addInvoice(byKey, ticketKey(t), inv);
  }
  for (const inv of fio || []) {
    if (!norm(inv.invoice_no)) continue;
    const refs = upper([inv.contract_nos, inv.invoice_no].join(" "));
    const t = tickets.find((x) => refs.includes(upper(x.bl_no)) || refs.includes(upper(x.cy_no)));
    if (t) addInvoice(byKey, ticketKey(t), { ...inv, source: "finance_invoices_out", amount_cny: ccy(inv.currency) === "CNY" ? inv.amount_incl_tax : 0, amount_usd: ccy(inv.currency) === "USD" ? inv.amount_incl_tax : 0 });
  }
  for (const list of byKey.values()) applyFx(list, fx);
  return byKey;
}

async function loadTickets(pool) {
  const view = "v_hy_freight_ticket_overview";
  if (!(await relationExists(pool, view))) throw new Error(`${view} 不存在`);
  return (await pool.query(
    `SELECT cy_no, bl_no, consignee, freight_usd, port_charge_sale_cny, etd
       FROM ${view}
      ORDER BY etd DESC NULLS LAST, bl_no NULLS LAST`
  )).rows;
}

async function loadPlans(pool) {
  const cols = await columns(pool, "shipping_plans");
  if (!cols.size) return [];
  const freightRefs = cols.has("freight_refs") ? "freight_refs" : cols.has("raw") ? "raw->>'freight_refs_0918'" : "NULL";
  return (await pool.query(
    `SELECT id, bl_no, shipment_no, contract_no, ${freightRefs} AS freight_refs, etd, so_date
       FROM shipping_plans`
  )).rows;
}

async function loadFinanceInvoices(pool) {
  const cols = await columns(pool, "finance_invoices_out");
  if (!cols.has("invoice_no")) return [];
  const amount = cols.has("amount_incl_tax") ? "amount_incl_tax" : cols.has("amount") ? "amount" : cols.has("total_amount") ? "total_amount" : "NULL";
  const date = cols.has("issue_date") ? "issue_date" : cols.has("invoice_date") ? "invoice_date" : cols.has("issued_at") ? "issued_at" : "NULL";
  const currency = cols.has("currency") ? "currency" : "NULL";
  const contracts = cols.has("contract_nos") ? "contract_nos" : cols.has("contract_no") ? "contract_no" : "NULL";
  return (await pool.query(
    `SELECT invoice_no, ${date} AS issue_date, ${amount} AS amount_incl_tax,
            ${currency} AS currency, ${contracts} AS contract_nos
       FROM finance_invoices_out
      WHERE UPPER(BTRIM(invoice_no)) ~ '^(FI|OF|PC|EXW|PB)'`
  )).rows;
}

async function loadRegistry(pool, mode) {
  const cols = await columns(pool, "freight_invoice_registry");
  if (!cols.size) return [];
  if (mode === "fallback" && !cols.has("migrated_to_freight_bills_at")) return [];
  const fallbackOnly = mode === "fallback" ? "WHERE migrated_to_freight_bills_at IS NULL" : "";
  return (await pool.query(
    `SELECT bl_no, invoice_no, currency, amount_usd, amount_cny, invoice_date,
            is_cif, source_file, note, 'freight_invoice_registry' AS source,
            invoice_no AS source_id
       FROM freight_invoice_registry
       ${fallbackOnly}`
  )).rows;
}

async function loadBillInvoices(pool) {
  const billCols = await columns(pool, "freight_bills");
  const itemCols = await columns(pool, "freight_bill_items");
  const feeCols = await columns(pool, "freight_supplier_bills");
  const registryCols = await columns(pool, "freight_invoice_registry");
  if (!billCols.has("invoice_no") || !itemCols.has("bill_id") || !itemCols.has("fee_id") || !feeCols.has("bl_no")) return [];
  const itemAmount = itemCols.has("amount") ? "NULLIF(i.amount, 0)" : "NULL";
  const saleAmount = feeCols.has("sale_amount") ? "fsb.sale_amount" : "NULL";
  const lineAmount = `SUM(COALESCE(${itemAmount}, ${saleAmount}, 0))`;
  const invoiceDate = billCols.has("invoice_date") ? "b.invoice_date" : billCols.has("bill_date") ? "b.bill_date" : "NULL";
  const hasRegistry = registryCols.has("invoice_no");
  const registryIsCifCol = registryCols.has("is_cif") ? "BOOL_OR(COALESCE(is_cif, false))" : "false";
  const registryCurrencyCol = registryCols.has("currency") ? "MAX(NULLIF(currency, ''))" : "NULL";
  const registryAmountUsdCol = registryCols.has("amount_usd") ? "MAX(amount_usd)" : "NULL";
  const registryAmountCnyCol = registryCols.has("amount_cny") ? "MAX(amount_cny)" : "NULL";
  const registryDateCol = registryCols.has("invoice_date") ? "MAX(invoice_date)" : "NULL";
  const registrySourceFileCol = registryCols.has("source_file") ? "MAX(source_file)" : "NULL";
  const registryNoteCol = registryCols.has("note") ? "MAX(note)" : "NULL";
  const registryCte = hasRegistry
    ? `registry_invoice AS (
         SELECT invoice_no,
                ${registryIsCifCol} AS is_cif,
                ${registryCurrencyCol} AS currency,
                ${registryAmountUsdCol} AS amount_usd,
                ${registryAmountCnyCol} AS amount_cny,
                ${registryDateCol} AS invoice_date,
                ${registrySourceFileCol} AS source_file,
                ${registryNoteCol} AS note
           FROM freight_invoice_registry
          WHERE NULLIF(BTRIM(invoice_no), '') IS NOT NULL
          GROUP BY invoice_no
       ),`
    : "";
  const registryJoin = hasRegistry ? "LEFT JOIN registry_invoice r ON UPPER(BTRIM(r.invoice_no)) = UPPER(BTRIM(b.invoice_no))" : "";
  const registryCurrency = hasRegistry ? "COALESCE(NULLIF(r.currency, ''), b.currency)" : "b.currency";
  const registryAmountUsd = hasRegistry ? `COALESCE(r.amount_usd, CASE WHEN UPPER(COALESCE(b.currency,'')) = 'USD' THEN ${lineAmount} ELSE 0 END)` : `CASE WHEN UPPER(COALESCE(b.currency,'')) = 'USD' THEN ${lineAmount} ELSE 0 END`;
  const registryAmountCny = hasRegistry ? `COALESCE(r.amount_cny, CASE WHEN UPPER(COALESCE(b.currency,'')) IN ('CNY','RMB','人民币') THEN ${lineAmount} ELSE 0 END)` : `CASE WHEN UPPER(COALESCE(b.currency,'')) IN ('CNY','RMB','人民币') THEN ${lineAmount} ELSE 0 END`;
  const registryDate = hasRegistry ? `COALESCE(r.invoice_date, ${invoiceDate})` : invoiceDate;
  const registryIsCif = hasRegistry ? "COALESCE(r.is_cif, false)" : "false";
  const registrySourceFile = hasRegistry ? "r.source_file" : "NULL";
  const registryNote = hasRegistry ? "r.note" : "NULL";
  const registryGroupBy = hasRegistry ? ", r.currency, r.amount_usd, r.amount_cny, r.invoice_date, r.is_cif, r.source_file, r.note" : "";
  return (await pool.query(
    `WITH ${registryCte}
    bill_lines AS (
       SELECT fsb.bl_no,
            b.invoice_no,
            ${registryCurrency} AS currency,
            ${registryAmountUsd} AS amount_usd,
            ${registryAmountCny} AS amount_cny,
            ${registryDate} AS invoice_date,
            ${registryIsCif} AS is_cif,
            'freight_bills' AS source,
            b.id::text AS source_id,
            b.bill_no AS source_bill_no,
            ${registrySourceFile} AS source_file,
            concat('bill_no=', b.bill_no, '; bill_id=', b.id, '; bl=', fsb.bl_no, COALESCE('; registry_note=' || ${registryNote}, '')) AS note
       FROM freight_bills b
       JOIN freight_bill_items i ON i.bill_id = b.id
       JOIN freight_supplier_bills fsb ON fsb.id = i.fee_id
       ${registryJoin}
      WHERE UPPER(COALESCE(b.direction, '')) = 'AR'
        AND LOWER(COALESCE(b.status, '')) <> 'void'
        AND NULLIF(BTRIM(b.invoice_no), '') IS NOT NULL
        AND NULLIF(BTRIM(fsb.bl_no), '') IS NOT NULL
      GROUP BY fsb.bl_no, b.id, b.bill_no, b.invoice_no, b.currency, ${invoiceDate}${registryGroupBy}
    )
    SELECT *
      FROM bill_lines
     ORDER BY source_id, bl_no`
  )).rows;
}

export async function loadFreightMatchInput(pool, { receivableSource = "bills" } = {}) {
  const registryMode = receivableSource === "registry" ? "all" : "fallback";
  return {
    tickets: await loadTickets(pool),
    plans: await loadPlans(pool),
    flows: await rowsOrEmpty(pool, "bank_flows",
      `SELECT id, entity_code, account_no, currency, direction, tx_date, amount,
              counterparty_name, memo, purpose, source_file
         FROM bank_flows
        WHERE entity_code IN ('oceanbaby','babi')
          AND COALESCE(direction,'') NOT IN ('out','refund')`),
    slips: await rowsOrEmpty(pool, "bank_slips",
      `SELECT id, sender_name, amount, currency, payment_date, beneficiary_reference,
              remark_details, beneficiary_company_code, matched_flow_id, status, cash_direction
         FROM bank_slips`),
    links: await rowsOrEmpty(pool, "bank_slip_links",
      `SELECT id, slip_id, contract_no, order_no, bl_no, payment_id, amount_alloc,
              alloc_currency, note, created_at, shipment_no, selection_source,
              alloc_status, alloc_note
         FROM bank_slip_links`),
    registry: await loadRegistry(pool, registryMode),
    bills: receivableSource === "registry" ? [] : await loadBillInvoices(pool),
    fio: await loadFinanceInvoices(pool),
    fx: await rowsOrEmpty(pool, "exchange_rates",
      `SELECT currency_pair, rate, fetched_at
         FROM exchange_rates
        WHERE currency_pair='USD_CNY'`),
  };
}

export const __test = { buildInvoiceByTicket, loadBillInvoices, loadRegistry };
