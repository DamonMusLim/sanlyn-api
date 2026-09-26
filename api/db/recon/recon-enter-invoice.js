// line_count: 126
import { getPool } from "../../db.js";

const CONFIGS = {
  ap_forwarder: { table: "finance_invoices_in", backField: "customs_nos" },
  ar_customer: { table: "finance_invoices_out", backField: "contract_nos" },
};

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function actor(req) {
  return String(req.user?.username || req.user?.email || req.user?.uid || req.user?.id || "unknown");
}

function clean(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function splitRefs(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value).split(",").map(clean).filter(Boolean);
}

function mergeRefs(value, ref) {
  const out = [];
  const seen = new Set();
  for (const item of [...splitRefs(value), clean(ref)]) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function parseBackRef(templateKey, lineKey) {
  const key = clean(lineKey);
  if (templateKey === "ap_forwarder") return clean(key.split("|")[1]);
  if (templateKey === "ar_customer") return key;
  return "";
}

async function loadLine(db, id) {
  const r = await db.query(
    `SELECT * FROM recon_lines WHERE id=$1 FOR UPDATE`,
    [id]
  );
  return r.rows[0] || null;
}

async function loadInvoice(db, cfg, invoiceNo) {
  const r = await db.query(
    `SELECT id, invoice_no, ${cfg.backField} FROM ${cfg.table} WHERE invoice_no=$1 LIMIT 1`,
    [invoiceNo]
  );
  return r.rows[0] || null;
}

async function updateLine(db, line, invoiceNo) {
  const refs = mergeRefs(line.actual_source_ref, invoiceNo);
  const r = await db.query(
    `UPDATE recon_lines SET actual_source_type='invoice', actual_source_ref=$2, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [line.id, refs.join(",")]
  );
  return r.rows[0];
}

async function updateInvoice(db, cfg, invoice, parsedRef) {
  if (!parsedRef) return false;
  const current = Array.isArray(invoice[cfg.backField]) ? invoice[cfg.backField].map(clean).filter(Boolean) : [];
  const refs = [];
  const seen = new Set();
  for (const item of [...current, clean(parsedRef)]) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    refs.push(item);
  }
  if (refs.length === current.length && refs.every((ref, i) => ref === current[i])) return false;
  await db.query(
    `UPDATE ${cfg.table} SET ${cfg.backField}=$2 WHERE id=$1`,
    [invoice.id, refs]
  );
  return true;
}

async function writeEvent(db, req, line, invoiceNo, parsedRef, invoiceUpdated, note) {
  await db.query(
    `INSERT INTO recon_events
     (template_key, sheet_id, line_id, event_type, old_status, new_status, amount, currency, reason, payload, created_by, actor_role)
     VALUES ($1,$2,$3,'enter_invoice_no',$4,$4,NULL,$5,$6,$7::jsonb,$8,$9)`,
    [
      line.template_key,
      line.sheet_id || null,
      line.id,
      line.status || null,
      line.currency || null,
      note || null,
      JSON.stringify({ invoice_no: invoiceNo, parsed_ref: parsedRef || null, invoice_updated: invoiceUpdated }),
      actor(req),
      req.user?.role || null,
    ]
  );
}

export async function handleEnterInvoiceNo(req, res) {
  const lineId = req.query?.id || req.body?.id;
  const invoiceNo = clean(req.body?.invoice_no);
  const note = clean(req.body?.note);
  if (!lineId) return json(res, 400, { error: "id required", message: "id required" });
  if (!invoiceNo) return json(res, 400, { error: "invoice_no required", message: "invoice_no required" });

  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const line = await loadLine(db, lineId);
    if (!line) {
      await db.query("ROLLBACK");
      return json(res, 404, { error: "line_not_found", message: "line_not_found" });
    }

    const cfg = CONFIGS[line.template_key];
    if (!cfg) {
      await db.query("ROLLBACK");
      return json(res, 400, { error: "unsupported template_key", message: "unsupported_template_key" });
    }

    const invoice = await loadInvoice(db, cfg, invoiceNo);
    if (!invoice) {
      await db.query("ROLLBACK");
      return json(res, 404, { error: "invoice_not_found", message: "invoice_not_found" });
    }

    const parsedRef = parseBackRef(line.template_key, line.line_key);
    const updatedLine = await updateLine(db, line, invoiceNo);
    const invoiceUpdated = await updateInvoice(db, cfg, invoice, parsedRef);
    await writeEvent(db, req, line, invoiceNo, parsedRef, invoiceUpdated, note);

    await db.query("COMMIT");
    return res.json({
      success: true,
      line: updatedLine,
      invoice_no: invoiceNo,
      parsed_ref: parsedRef || null,
      invoice_updated: invoiceUpdated,
      message: parsedRef ? "invoice_no_entered" : "invoice_no_entered; back_ref_not_parsed",
    });
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}
