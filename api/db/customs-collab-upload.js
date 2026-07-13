// api/db/customs-collab-upload.js — factory-side invoice + slip upload handlers
// split out of customs-collab.js (2026-07-14, ≤500-line rule).
import { getPool } from "../db.js";
import { cleanString } from "./factory-portal-utils.js";
import { readUploadPayload, validateFile, uploadToOss, insertFinanceInvoice } from "./factory-invoice-upload.js";
import { ocrInvoice } from "./factory-invoice-ocr.js";
import { money, uploadedForCustoms, reconcileStatus, writeInvoiceEvent } from "./customs-collab-status.js";
import { resolveFactory, rateLimit, failClosed, assertFactoryCustoms, sellerNameMatches, json } from "./customs-collab-shared.js";

async function handleUpload(req, res) {
  const pool = getPool();
  const scope = await resolveFactory(req, pool);
  if (!scope) return failClosed(res);
  if (!rateLimit(req, scope.factory.code)) return json(res, 429, { error: "请求过于频繁，请稍后再试" });

  const { fields, file } = await readUploadPayload(req);
  const err = validateFile(file);
  if (err) return json(res, 400, { error: err });

  const customsNo = cleanString(fields.customs_no || fields.customsNo);
  if (!customsNo) return json(res, 400, { error: "customs_no required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const st = await assertFactoryCustoms(client, scope.factory.code, customsNo);
    const upload = await uploadedForCustoms(client, customsNo, scope.factory.code);
    const expected = money(st.manual_expected_amount) ?? money(st.system_expected_amount);
    await client.query("COMMIT");

    const oss = await uploadToOss(scope.factory.code, "OCR_UPLOAD", file);
    let ocr = null, ocrError = null;
    try { ocr = await ocrInvoice(file); } catch (e) { ocrError = e; }

    const parsed = ocr?.parsed || {};
    const amountInclTax = money(parsed.amount_incl_tax);
    const sellerOcr = cleanString(parsed.seller_name);
    const sellerMismatch = !!sellerOcr && !sellerNameMatches(scope.factory.name, sellerOcr);

    let reviewStatus = "pending";
    let warning = "";
    let needsManualReview = false;
    if (!ocr || !parsed.invoice_no || amountInclTax === null) {
      reviewStatus = "ocr_failed"; needsManualReview = true; warning = "识别失败，已存档待人工录入";
    } else if (expected !== null && amountInclTax > expected + 1) {
      reviewStatus = "over_issued"; needsManualReview = true; warning = "金额超应开金额，请核实";
    } else if (expected !== null && amountInclTax + upload.uploaded_amount < expected - 1) {
      reviewStatus = "under_issued"; needsManualReview = true; warning = "金额低于应开金额，请核实";
    }
    if (sellerMismatch) {
      if (reviewStatus === "pending") reviewStatus = "seller_mismatch";
      needsManualReview = true;
      warning = warning ? `${warning}；卖方与工厂不一致，请核实` : "卖方与工厂不一致，请核实";
    }

    const attachments = [{ url: oss.url, key: oss.key, name: file.fileName, mime: file.mime, size: file.size, uploaded_at: new Date().toISOString() }];
    const invoiceNo = cleanString(parsed.invoice_no) || `OCR_PENDING_${Date.now()}`;

    await client.query("BEGIN");
    const invoiceId = await insertFinanceInvoice(client, {
      invoiceNo,
      invoiceCode: parsed.invoice_code,
      issueDate: parsed.issue_date,
      sellerName: parsed.seller_name || scope.factory.name,
      sellerTaxId: parsed.seller_tax_id || null,
      buyerName: parsed.buyer_name || null,
      buyerTaxId: parsed.buyer_tax_id || null,
      factoryCode: scope.factory.code,
      amountExTax: parsed.amount_ex_tax,
      totalTax: parsed.total_tax,
      amountInclTax,
      taxRate: Number.isFinite(parsed.tax_rate) ? parsed.tax_rate : null,
      contractNos: st.contract_no ? [st.contract_no] : [],
      customsNos: [customsNo],
      reviewStatus,
      attachments,
      lineItems: [],
      raw: {
        uploaded_from: "customs_collab",
        customs_no: customsNo,
        oss,
        file_name: file.fileName,
        ocr_model: "MiniMax-M3",
        ocr_raw: ocr?.rawText || null,
        ocr_parsed: sellerMismatch ? { ...parsed, seller_expected: scope.factory.name, seller_ocr: sellerOcr } : parsed,
        ocr_error: ocrError ? ocrError.message : null,
        target_amount_incl_tax: expected,
        needs_manual_review: needsManualReview,
        seller_mismatch: sellerMismatch,
      },
    });

    await client.query(
      `INSERT INTO invoice_customs_links
         (invoice_id, invoice_no, customs_no, factory_code, allocated_amount, link_status, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7)
       ON CONFLICT (invoice_id, customs_no) DO UPDATE SET
         invoice_no=EXCLUDED.invoice_no,
         factory_code=EXCLUDED.factory_code,
         allocated_amount=EXCLUDED.allocated_amount,
         link_status='active',
         reason=EXCLUDED.reason`,
      [invoiceId, invoiceNo, customsNo, scope.factory.code, amountInclTax, "factory_upload", scope.factory.code]
    );

    const ev = await writeInvoiceEvent(client, {
      invoice_id: invoiceId,
      invoice_no: invoiceNo,
      customs_no: customsNo,
      factory_code: scope.factory.code,
      event_type: "upload_invoice",
      new_status: reviewStatus,
      amount_incl_tax: amountInclTax,
      payload: { oss_url: oss.url, needs_manual_review: needsManualReview },
      created_by: scope.factory.code,
      actor_role: "factory",
    });
    const rec = await reconcileStatus(client, customsNo, { force: true }, scope.factory.code);
    await client.query("COMMIT");

    return res.json({
      success: true,
      invoice_id: invoiceId,
      invoice_no: invoiceNo,
      review_status: reviewStatus,
      amount_incl_tax: amountInclTax,
      warning,
      needs_manual_review: needsManualReview,
      oss_url: oss.url,
      status: rec.status,
      event_id: ev.id,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return json(res, e.status || 500, { error: e.message });
  } finally {
    client.release();
  }
}

async function handleUploadSlip(req, res) {
  const pool = getPool();
  const scope = await resolveFactory(req, pool);
  if (!scope) return failClosed(res);
  if (!rateLimit(req, scope.factory.code)) return json(res, 429, { error: "请求过于频繁，请稍后再试" });

  const { fields, file } = await readUploadPayload(req);
  const err = validateFile(file);
  if (err) return json(res, 400, { error: err });
  const customsNo = cleanString(fields.customs_no || fields.customsNo);
  if (!customsNo) return json(res, 400, { error: "customs_no required" });
  const amount = money(fields.amount);

  const client = await pool.connect();
  try {
    const st = await assertFactoryCustoms(client, scope.factory.code, customsNo);
    const oss = await uploadToOss(scope.factory.code, "SLIP_UPLOAD", file);
    await client.query("BEGIN");
    const slip = await client.query(
      `INSERT INTO bank_slips
         (beneficiary_name, beneficiary_company_code, amount, currency, file_url, status, raw, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,'CNY',$4,'recorded',$5::jsonb,$6,NOW(),NOW())
       RETURNING id`,
      [scope.factory.name, scope.factory.code, amount, oss.url,
       JSON.stringify({ source: "factory-collab-slip", customs_no: customsNo, file_name: file.fileName }),
       "factory:" + scope.factory.code]
    );
    const slipId = slip.rows[0].id;
    await client.query(
      `INSERT INTO bank_slip_links (slip_id, contract_no, bl_no, amount_alloc, note, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [slipId, st.contract_no || null, customsNo, amount, "工厂协同上传水单"]
    );
    await client.query("COMMIT");
    return res.json({ success: true, slip_id: slipId, customs_no: customsNo, amount, file_url: oss.url });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return json(res, e.status || 500, { error: e.message });
  } finally {
    client.release();
  }
}

export { handleUpload, handleUploadSlip };
