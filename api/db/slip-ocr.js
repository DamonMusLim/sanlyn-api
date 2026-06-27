// api/db/slip-ocr.js
// Water slip: slip_uploads → MiniMax M3 OCR → bank_slips + bank_slip_links → reconcile
// 2026-06-13
import { getPool } from "../db.js";
import { reconcile } from "./freight-recon.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, "..", "..");

function mimeOf(filename) {
  const ext = String(filename).toLowerCase().replace(/.*\./, "");
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

// Convert first page of PDF to JPEG bytes via pdftoppm
function pdfToJpeg(pdfPath) {
  return new Promise((resolve, reject) => {
    const tmpBase = path.join(os.tmpdir(), "slip_" + Date.now());
    execFile("pdftoppm", ["-jpeg", "-r", "150", "-f", "1", "-l", "1", pdfPath, tmpBase], (err) => {
      if (err) return reject(new Error("pdftoppm failed: " + err.message));
      // pdftoppm writes tmpBase-1.jpg (or tmpBase-01.jpg)
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

function num2(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return null;
  return parseFloat(n.toFixed(2));
}

function safeDate(v) {
  if (!v || typeof v !== "string") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : v.slice(0, 10);
}

const OCR_PROMPT = `Extract all fields from this bank payment advice document. Reply with ONLY valid JSON, no markdown:
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

async function ocrSlip(fileBytes, filename, absPath) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");
  let imgBytes = fileBytes;
  let media_type = mimeOf(filename);
  // PDF: convert first page to JPEG
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
      "x-api-key": key,
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
  // strip markdown fences if any
  const clean = raw.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
  return { rawText: raw, parsed: JSON.parse(clean) };
}

export async function processSlipUpload(pool, uploadRow) {
  const absPath = path.join(BASE_DIR, uploadRow.stored_path);
  if (!fs.existsSync(absPath)) throw new Error(`slip file not found: ${absPath}`);

  const fileBytes = fs.readFileSync(absPath);
  let parsed, rawText;
  try {
    ({ parsed, rawText } = await ocrSlip(fileBytes, uploadRow.filename || uploadRow.stored_path, absPath));
  } catch (ocrErr) {
    await pool.query(
      `UPDATE slip_uploads SET note = COALESCE(note,'') || $1 WHERE id=$2`,
      [` OCR_FAIL: ${ocrErr.message}`.slice(0, 300), uploadRow.id]
    );
    throw ocrErr;
  }

  // validate required fields
  const amountNum = num2(parsed.amount);
  const paymentDate = safeDate(parsed.payment_date);
  if (amountNum === null) throw new Error("OCR: amount missing or invalid");
  if (!paymentDate) throw new Error("OCR: payment_date missing or invalid");

  // deduplicate on bank_reference_no
  const bankRef = String(parsed.bank_reference_no || "").trim();
  if (bankRef) {
    const existing = await pool.query("SELECT id FROM bank_slips WHERE bank_reference_no=$1 LIMIT 1", [bankRef]);
    if (existing.rows.length) {
      await pool.query(
        "UPDATE slip_uploads SET processed=TRUE, slip_id=$1 WHERE id=$2",
        [existing.rows[0].id, uploadRow.id]
      );
      return { slip_id: existing.rows[0].id, skipped: true, reason: "duplicate bank_reference_no" };
    }
  }

  const slipRes = await pool.query(
    `INSERT INTO bank_slips (
       bank_source, bank_reference_no, txn_ref,
       sender_name, sender_bank, sender_country,
       beneficiary_name, beneficiary_bank, beneficiary_account_masked,
       amount, currency, indicative_amount, indicative_currency, exchange_rate,
       cable_charge, commission_charge, sst_charge, charge_currency,
       purpose_code, remark_details, beneficiary_reference,
       payment_date, bank_processing_date,
       file_url, status, raw, created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,
       $10,$11,$12,$13,$14,
       $15,$16,$17,$18,
       $19,$20,$21,
       $22,$23,
       $24,$25,$26,$27
     ) RETURNING id`,
    [
      String(parsed.bank_source || "").slice(0, 20) || null,
      bankRef || null,
      String(parsed.txn_ref || "").trim() || null,
      String(parsed.sender_name || "").trim() || null,
      String(parsed.sender_bank || "").trim() || null,
      String(parsed.sender_country || "").slice(0, 50) || null,
      String(parsed.beneficiary_name || "").trim() || null,
      String(parsed.beneficiary_bank || "").trim() || null,
      String(parsed.beneficiary_account_masked || "").trim() || null,
      amountNum,
      String(parsed.currency || "").slice(0, 3).toUpperCase() || null,
      num2(parsed.indicative_amount),
      String(parsed.indicative_currency || "").slice(0, 3).toUpperCase() || null,
      num2(parsed.exchange_rate),
      num2(parsed.cable_charge),
      num2(parsed.commission_charge),
      num2(parsed.sst_charge),
      String(parsed.charge_currency || "").slice(0, 3).toUpperCase() || null,
      String(parsed.purpose_code || "").trim() || null,
      String(parsed.remark_details || "").trim() || null,
      String(parsed.beneficiary_reference || "").trim() || null,
      paymentDate,
      safeDate(parsed.bank_processing_date),
      uploadRow.stored_path,
      "new",
      JSON.stringify({ ocr_raw: rawText, ocr_model: "MiniMax-M3", upload_id: uploadRow.id }),
      "slip_ocr_auto"
    ]
  );
  const slipId = slipRes.rows[0].id;

  // insert allocations → bank_slip_links
  const allocs = Array.isArray(parsed.allocations) ? parsed.allocations : [];
  if (allocs.length === 1 && allocs[0].amount_alloc == null) {
    allocs[0].amount_alloc = String(amountNum);
  }
  for (const a of allocs) {
    if (!a.note && !a.contract_no && !a.bl_no && !a.order_no) continue;
    await pool.query(
      `INSERT INTO bank_slip_links (slip_id, contract_no, order_no, bl_no, amount_alloc, alloc_currency, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        slipId,
        String(a.contract_no || "").trim() || null,
        String(a.order_no || "").trim() || null,
        String(a.bl_no || "").trim() || null,
        num2(a.amount_alloc),
        String(parsed.currency || "").slice(0, 3).toUpperCase() || null,
        String(a.note || "").trim().slice(0, 500) || null
      ]
    );
  }

  // ensure updated_at column exists
  await pool.query(
    `ALTER TABLE slip_uploads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`
  );
  await pool.query(
    "UPDATE slip_uploads SET processed=TRUE, slip_id=$1, updated_at=now() WHERE id=$2",
    [slipId, uploadRow.id]
  );

  // trigger reconcile (non-fatal)
  let reconResult = null;
  try {
    const results = await reconcile(pool, false);
    const matched = results.filter(r => r.status === "matched").length;
    const exceptions = results.filter(r => r.status === "exception").length;
    reconResult = { matched, exceptions };
  } catch (rErr) {
    console.warn("[slip-ocr] reconcile error (non-fatal):", rErr.message);
  }

  return { slip_id: slipId, links_inserted: allocs.length, recon: reconResult };
}
