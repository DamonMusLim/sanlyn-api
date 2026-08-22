import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function clean(v) {
  return String(v == null ? "" : v).trim();
}

function moneyOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeAttachments(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      return normalizeAttachments(parsed);
    } catch {
      return [s];
    }
  }
  if (typeof v === "object") return [v];
  return [];
}

function attachmentPath(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return clean(
    item.pdf_path ||
    item.oss_url ||
    item.url ||
    item.path ||
    item.file_path ||
    item.key ||
    item.name
  );
}

function firstPdfPath(attachments) {
  const items = normalizeAttachments(attachments);
  const paths = items.map(attachmentPath).filter(Boolean);
  return paths.find((p) => /\.pdf(?:$|[?#])/i.test(p)) || null;
}

function invoiceGroup(row) {
  const text = `${clean(row.remark)} ${clean(row.invoice_type)}`.toLowerCase();
  if (/港杂|local|thc/.test(text)) return "local";
  if (/海运|ocean|freight/.test(text)) return "ocean";
  return "ocean";
}

function toInvoice(row) {
  return {
    id: row.id,
    invoice_no: row.invoice_no || null,
    invoice_code: row.invoice_code || null,
    invoice_type: row.invoice_type || null,
    issue_date: row.issue_date || null,
    seller_name: row.seller_name || null,
    buyer_name: row.buyer_name || null,
    amount_ex_tax: moneyOrNull(row.amount_ex_tax),
    total_tax: moneyOrNull(row.total_tax),
    amount_incl_tax: moneyOrNull(row.amount_incl_tax),
    amount: moneyOrNull(row.amount_incl_tax),
    tax_rate: moneyOrNull(row.tax_rate),
    currency: row.currency || null,
    pdf_path: firstPdfPath(row.attachments),
    remark: row.remark || null,
    source: row.source || null,
  };
}

function emptyGroups() {
  return { ocean: [], local: [] };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed", allowed: ["GET"] });
  }
  if (!requireAuth(req, res)) return;

  const contract = clean(req.query.contract || req.query.contract_no);
  if (!contract) return res.status(200).json({ groups: emptyGroups() });

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, invoice_no, invoice_code, invoice_type, issue_date,
              seller_name, buyer_name, amount_ex_tax, total_tax,
              amount_incl_tax, tax_rate, currency, contract_nos,
              customs_nos, remark, source, attachments, void_status
         FROM finance_invoices_out
        WHERE $1 = ANY(COALESCE(contract_nos::text[], ARRAY[]::text[]))
          AND COALESCE(void_status, '') NOT IN ('voided', 'red')
        ORDER BY issue_date DESC NULLS LAST, id DESC`,
      [contract]
    );

    const groups = emptyGroups();
    for (const row of result.rows) {
      groups[invoiceGroup(row)].push(toInvoice(row));
    }
    return res.status(200).json({ groups });
  } catch (err) {
    console.error("[plan-invoices] GET error:", err);
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
}
