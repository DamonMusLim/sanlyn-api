// GET /api/db/freight-receipts - freight invoice and receipt evidence by ticket.
import { requireAuth } from "../auth.js";
import { getPool, setCors } from "../db.js";
import { matchFreight } from "./lib/freight-match.js";

const VERSION = "v2026.09.18-4";
const VIEW = "v_hy_freight_ticket_overview";

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

async function columns(pool, name) {
  if (!(await relationExists(pool, name))) return new Set();
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [name]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

async function rowsOrEmpty(pool, table, sql) {
  if (!(await relationExists(pool, table))) return [];
  return (await pool.query(sql)).rows;
}

async function loadTickets(pool) {
  if (!(await relationExists(pool, VIEW))) throw new Error(`${VIEW} 不存在`);
  return (await pool.query(
    `SELECT cy_no, bl_no, consignee, freight_usd, port_charge_sale_cny, etd
       FROM ${VIEW}
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

async function loadInput(pool) {
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
    registry: await rowsOrEmpty(pool, "freight_invoice_registry",
      `SELECT bl_no, invoice_no, currency, amount_usd, amount_cny, invoice_date,
              is_cif, source_file, note
         FROM freight_invoice_registry`),
    fio: await loadFinanceInvoices(pool),
    fx: await rowsOrEmpty(pool, "exchange_rates",
      `SELECT currency_pair, rate, fetched_at
         FROM exchange_rates
        WHERE currency_pair='USD_CNY'`),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const rows = matchFreight(await loadInput(getPool()));
    return res.status(200).json({ success: true, version: VERSION, generated_at: new Date().toISOString(), rows });
  } catch (err) {
    console.error("[freight-receipts]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export const __selftest = { loadInput };
