// Read-only customer e-invoices for a shipping plan contract.
// GET /api/db/plan-invoices?contract=<contract_no>
import { getPool } from "../db.js";

const clean = (v) => String(v ?? "").trim();

function splitTokens(v) {
  if (Array.isArray(v)) return v.flatMap(splitTokens);
  return clean(v)
    .split(/[,，|;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniq(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function normalizeAttachments(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "object") return [value];
  return [];
}

function firstPdfAttachment(attachments) {
  return normalizeAttachments(attachments).find((a) => {
    const name = clean(a.name || a.filename || a.file_name || a.path || a.url || a.oss_url);
    const mime = clean(a.mime || a.mimetype || a.content_type).toLowerCase();
    return mime.includes("pdf") || /\.pdf($|\?)/i.test(name);
  }) || null;
}

function attachmentPath(att) {
  if (!att) return null;
  return clean(att.path || att.url || att.oss_url || att.file_url) || null;
}

function invoiceGroup(currency) {
  return clean(currency).toUpperCase() === "CNY" ? "local" : "ocean";
}

async function resolveContracts(pool, req) {
  const explicit = uniq(splitTokens(req.query?.contract || req.query?.contract_no || req.query?.contractNo));
  if (explicit.length) return explicit;

  const ref = clean(req.query?.shipment || req.query?.shipment_no || req.query?.shipmentNo || req.query?.bl || req.query?.bl_no || req.query?.blNo);
  if (!ref) return [];

  const r = await pool.query(
    `SELECT contract_no, order_contract_nos, contract_nos, order_nos
       FROM shipping_plans
      WHERE id::text = $1 OR _id = $1 OR shipment_no = $1 OR bl_no = $1
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [ref]
  );
  const row = r.rows[0];
  if (!row) return [];
  return uniq(
    splitTokens(row.contract_no)
      .concat(splitTokens(row.contract_nos))
      .concat(splitTokens(row.order_contract_nos))
      .concat(splitTokens(row.order_nos))
  );
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const pool = getPool();
    const contracts = await resolveContracts(pool, req);
    if (!contracts.length) {
      return res.status(400).json({ success: false, error: "contract or shipment/bl required" });
    }

    const r = await pool.query(
      `SELECT id, invoice_no, currency, tax_rate, amount_incl_tax, attachments,
              issue_date, invoice_format, contract_nos
         FROM finance_invoices_out
        WHERE COALESCE(void_status, 'normal') = 'normal'
          AND COALESCE(invoice_no, '') <> ''
          AND COALESCE(invoice_no, '') NOT LIKE 'CI-DRAFT%'
          AND COALESCE(contract_nos::text[], '{}'::text[]) && $1::text[]
        ORDER BY issue_date DESC NULLS LAST, id DESC`,
      [contracts]
    );

    const invoices = r.rows.map((row) => {
      const pdf = firstPdfAttachment(row.attachments);
      const pdfPath = attachmentPath(pdf);
      return {
        id: row.id,
        invoice_no: row.invoice_no,
        currency: row.currency || null,
        group: invoiceGroup(row.currency),
        tax_rate: row.tax_rate == null ? null : Number(row.tax_rate),
        amount_incl_tax: row.amount_incl_tax == null ? null : Number(row.amount_incl_tax),
        issue_date: row.issue_date ? String(row.issue_date).slice(0, 10) : null,
        invoice_format: row.invoice_format || null,
        contract_nos: row.contract_nos || [],
        pdf_path: pdfPath,
        pdf_name: pdf ? clean(pdf.name || pdf.filename || row.invoice_no + ".pdf") : null,
        attachments: row.attachments || [],
      };
    });

    return res.json({
      success: true,
      contracts,
      invoices,
      groups: {
        ocean: invoices.filter((i) => i.group === "ocean"),
        local: invoices.filter((i) => i.group === "local"),
      },
    });
  } catch (err) {
    console.error("[plan-invoices]", err);
    return res.status(500).json({ success: false, error: err.message || "plan invoices failed" });
  }
}
