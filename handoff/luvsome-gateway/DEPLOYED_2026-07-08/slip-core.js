// Copied from sanlyn-api/api/db/slip-core.js; keep changes synchronized.
// Shared payment-advice OCR, dedupe, and audit helpers.
// Domain-specific candidate matching and business-table checks stay outside.
import {
  findCanonicalDocumentByHash,
  registerCanonicalDocument,
  sha256Hex
} from "./canonical-document-registry.js";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import os from "os";

const ALLOWED_LINKS_TABLES = new Set(["bank_slip_links", "pet_slip_links"]);
const RANK = { low: 0, medium: 1, high: 2 };

function mimeOf(filename) {
  const ext = String(filename).toLowerCase().replace(/.*\./, "");
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function pdfToJpeg(pdfPath) {
  return new Promise((resolve, reject) => {
    const tmpBase = path.join(os.tmpdir(), "slip_" + Date.now());
    execFile("pdftoppm", ["-jpeg", "-r", "150", "-f", "1", "-l", "1", pdfPath, tmpBase], (err) => {
      if (err) return reject(new Error("pdftoppm failed: " + err.message));
      const candidates = [tmpBase + "-1.jpg", tmpBase + "-01.jpg", tmpBase + "-001.jpg"];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          const data = fs.readFileSync(c);
          fs.unlinkSync(c);
          return resolve(data);
        }
      }
      reject(new Error("pdftoppm: output file not found"));
    });
  });
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function hasCandidates(raw) {
  return Array.isArray(raw?.match_candidates) && raw.match_candidates.length > 0;
}

function safeLinksTable(linksTable) {
  if (!ALLOWED_LINKS_TABLES.has(linksTable)) {
    throw new Error(`unsupported slip links table: ${linksTable}`);
  }
  return linksTable;
}

export function riskMax(a, b) {
  return RANK[b] > RANK[a] ? b : a;
}

export const OCR_PROMPT = `Extract all fields from this bank payment advice document. Reply with ONLY valid JSON, no markdown:
{
  "bank_source": "bank abbreviation (FTT/CIMB/HLB etc), empty if unknown",
  "bank_reference_no": "bank-assigned reference/transaction number",
  "txn_ref": "transaction reference shown to remitter",
  "sender_name": "remitter/payer full name",
  "sender_bank": "payer bank name",
  "sender_country": "2-letter country code or full name",
  "beneficiary_name": "receiver full name",
  "beneficiary_bank": "receiver bank name",
  "beneficiary_account_masked": "last 4 digits of account or masked number",
  "amount": "numeric string, original currency amount",
  "currency": "3-letter currency code",
  "indicative_amount": "numeric string, CNY equivalent if shown",
  "indicative_currency": "CNY or empty",
  "exchange_rate": "numeric string, FX rate if shown",
  "cable_charge": "numeric string or null",
  "commission_charge": "numeric string or null",
  "sst_charge": "numeric string or null",
  "charge_currency": "3-letter code or empty",
  "purpose_code": "purpose code if shown",
  "remark_details": "full remark/purpose text verbatim",
  "beneficiary_reference": "reference field sent to beneficiary (often contains FI numbers like FI-CY00359)",
  "payment_date": "YYYY-MM-DD",
  "bank_processing_date": "YYYY-MM-DD or empty",
  "allocations": [
    {
      "contract_no": "contract number or empty",
      "order_no": "order number or empty",
      "bl_no": "BL number or empty",
      "amount_alloc": "numeric string or null if merged payment",
      "note": "line description verbatim"
    }
  ]
}
Do not invent data. Use empty string for unknown text fields, null for unknown numeric fields.`;

export async function ocrPaymentAdvice(fileBytes, filename, absPath, minimaxApiKey) {
  if (!minimaxApiKey) throw new Error("MINIMAX_API_KEY not set");
  let imgBytes = fileBytes;
  let media_type = mimeOf(filename);
  if (String(filename).toLowerCase().endsWith(".pdf") && absPath) {
    try {
      imgBytes = await pdfToJpeg(absPath);
      media_type = "image/jpeg";
    } catch (convErr) {
      throw new Error("PDF→JPEG conversion failed: " + convErr.message);
    }
  }
  const b64 = imgBytes.toString("base64");
  const resp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": minimaxApiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "MiniMax-M3",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type, data: b64 } },
          { type: "text", text: OCR_PROMPT }
        ]
      }]
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`MiniMax OCR HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const j = await resp.json();
  const raw = j.content?.[0]?.text || "";
  const clean = raw.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
  return { rawText: raw, parsed: JSON.parse(clean) };
}

export async function dedupeAndRegisterUpload(pool, { domain, fileBytes, filename, storedPath, uploader }) {
  const fileSha256 = sha256Hex(fileBytes);
  const existingDoc = await findCanonicalDocumentByHash(pool, domain, fileSha256);
  if (existingDoc) return { isDuplicate: true, existingDoc, fileSha256 };

  const canonicalDoc = await registerCanonicalDocument(pool, {
    domain,
    doc_type: "payment_advice",
    file_sha256: fileSha256,
    source_path: storedPath || null,
    original_filename: filename || null,
    uploader: uploader || null,
    processing_status: "pending"
  });
  if (canonicalDoc) return { isDuplicate: false, existingDoc: null, fileSha256, canonicalDoc };

  const racedDoc = await findCanonicalDocumentByHash(pool, domain, fileSha256);
  return { isDuplicate: true, existingDoc: racedDoc || null, fileSha256 };
}

export async function auditAmountAllocation(pool, { linksTable, slipId, slipAmount }) {
  const table = safeLinksTable(linksTable);
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount_alloc),0) AS allocated FROM ${table} WHERE slip_id=$1`,
    [slipId]
  );
  const amount = money(slipAmount);
  const allocated = money(r.rows[0]?.allocated);
  const diff = money(Math.abs(amount - allocated));
  const threshold = money(Math.max(10, Math.abs(amount) * 0.005));
  let severity = "low";
  if (diff >= 0.01 && diff > threshold) severity = "high";
  else if (diff >= 0.01) severity = "medium";
  return {
    rule: "amount_allocation_mismatch",
    severity,
    message: severity === "low" ? "分摊金额合计与银行实收金额一致" : "分摊金额合计与银行实收金额存在差异",
    slip_amount: amount,
    allocated_amount: allocated,
    diff,
    threshold
  };
}

export async function auditSelectionSource(pool, { linksTable, slipId, raw }) {
  const table = safeLinksTable(linksTable);
  const r = await pool.query(
    `SELECT selection_source, COUNT(*)::int AS count FROM ${table} WHERE slip_id=$1 GROUP BY selection_source`,
    [slipId]
  );
  const total = r.rows.reduce((n, row) => n + Number(row.count || 0), 0);
  const manual = r.rows.filter(row => row.selection_source === "manual_input").reduce((n, row) => n + Number(row.count || 0), 0);
  let severity = "low";
  if (manual > 0) severity = "medium";
  if (total > 0 && manual === total && hasCandidates(raw)) severity = "high";
  return {
    rule: "selection_source",
    severity,
    message: severity === "low" ? "确认分摊来自 OCR 候选" : "确认分摊包含人工手动输入",
    total_allocations: total,
    manual_allocations: manual,
    had_ocr_candidates: hasCandidates(raw)
  };
}
