// api/db/customs-collab-upload.js — factory-side invoice + slip upload handlers
// split out of customs-collab.js (2026-07-14, ≤500-line rule).
import { getPool } from "../db.js";
import { cleanString } from "./factory-portal-utils.js";
import { readUploadPayload, validateFile, uploadToOss, insertFinanceInvoice } from "./factory-invoice-upload.js";
import crypto from "crypto";
import { ocrInvoice, stripGoodsPrefix } from "./factory-invoice-ocr.js";
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

    /* 0817 OCR bug: buyer/seller got swapped (real case: seller read as our own company).
       Prompt now states left=buyer right=seller; this is the fallback: if seller side matches
       US and buyer side does not, swap them. Name is unreliable, prefer tax id. */
    const OUR_TAX_IDS = new Set(["91350206MA34RW3852"]);
    let sellerOcr = cleanString(parsed.seller_name);
    let buyerOcr = cleanString(parsed.buyer_name);
    let sellerTaxOcr = cleanString(parsed.seller_tax_id);
    let buyerTaxOcr = cleanString(parsed.buyer_tax_id);
    let swapped = false;
    const looksOurs = (tax, nm) => OUR_TAX_IDS.has(tax) || /巴匕|巴比/.test(nm || "");
    if (looksOurs(sellerTaxOcr, sellerOcr) && !looksOurs(buyerTaxOcr, buyerOcr)) {
      [sellerOcr, buyerOcr] = [buyerOcr, sellerOcr];
      [sellerTaxOcr, buyerTaxOcr] = [buyerTaxOcr, sellerTaxOcr];
      parsed.seller_name = sellerOcr; parsed.buyer_name = buyerOcr;
      parsed.seller_tax_id = sellerTaxOcr; parsed.buyer_tax_id = buyerTaxOcr;
      swapped = true;
    }
    const sellerMismatch = !!sellerOcr && !sellerNameMatches(scope.factory.name, sellerOcr);

    /* 0817 new: goods-name check. Invoice item names carry a tax-bureau category prefix
       like *宠物用品*猫砂 -> strip it before comparing with declaration item names.
       Report only, never modify invoice or declaration. */
    const lineItems = Array.isArray(parsed.line_items) ? parsed.line_items : [];
    let goodsCheck = null;
    if (lineItems.length) {
      const dq = await pool.query(
        `SELECT ci.declaration_name_cn nm, ci.qty, ci.unit, ci.declaration_amount amt
           FROM customs_declaration_items ci
           JOIN customs_declarations cd ON cd.id = ci.declaration_id
           JOIN companies co ON co.id = ci.factory_company_id
          WHERE cd.declaration_no = $1 AND ci.deleted_at IS NULL AND co.code = $2
          ORDER BY ci.sort_order`,
        [customsNo, scope.factory.code]
      );
      const decl = dq.rows;
      if (decl.length) {
        const dnames = decl.map((d) => String(d.nm || "").trim());
        const inames = lineItems.map((l) => stripGoodsPrefix(l.name));
        const missing = dnames.filter((n) => n && !inames.includes(n));
        const extra = inames.filter((n) => n && !dnames.includes(n));
        const qtyDiff = [];
        const unitNotes = [];
        for (const d of decl) {
          const hit = lineItems.find((l) => stripGoodsPrefix(l.name) === String(d.nm || "").trim());
          if (hit && hit.qty !== null && Math.abs(Number(hit.qty) - Number(d.qty)) > 0.01)
            qtyDiff.push({ name: d.nm, declared: Number(d.qty), invoiced: Number(hit.qty) });
          /* 0817 Damon 核对后纠正：单位不一致【不是】问题，不要报警。
             退税申报表的单位取自海关计量单位(hgjldwmc)，来自报关单，进项发票的单位根本不进那张表。
             实证：猫砂报关按千克、发票按箱开，已成功退税十几批；税局侧 313 行里 台/件/条/个 都收。
             我先前把它判成 goods_mismatch 是自造假警报，现降级为 note，只记录不拦。 */
          if (hit && hit.unit && String(d.unit || "") && hit.unit !== String(d.unit))
            unitNotes.push({ name: d.nm, unit_declared: d.unit, unit_invoiced: hit.unit });
        }
        goodsCheck = {
          declared_lines: decl.length, invoiced_lines: lineItems.length,
          missing_in_invoice: missing, extra_in_invoice: extra, qty_diff: qtyDiff,
          unit_notes: unitNotes,
          ok: missing.length === 0 && extra.length === 0 && qtyDiff.length === 0,
        };
      }
    }

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
    if (goodsCheck && !goodsCheck.ok) {
      if (reviewStatus === "pending") reviewStatus = "goods_mismatch";
      needsManualReview = true;
      const bits = [];
      if (goodsCheck.missing_in_invoice.length) bits.push(`报关有发票没开：${goodsCheck.missing_in_invoice.join("、")}`);
      if (goodsCheck.extra_in_invoice.length) bits.push(`发票多开：${goodsCheck.extra_in_invoice.join("、")}`);
      if (goodsCheck.qty_diff.length) bits.push(`数量不符 ${goodsCheck.qty_diff.length} 行`);
      const msg = `品名与报关单不一致（${bits.join("；")}）`;
      warning = warning ? `${warning}；${msg}` : msg;
    }

    /* 0817 forge #3 二修：按 OSS key 去重是无效的 —— 每次上传都生成新的随机 key
       （f4039a1b… / 79da7eed… / 3fdc6c9e…），永远不命中，实测重传 3 次附件堆到 4 条。
       改按【文件内容 sha256】去重：同一份 PDF 不管传几次都只留一条。 */
    const fileHash = crypto.createHash("sha256").update(file.buffer || file.data || Buffer.alloc(0)).digest("hex");
    const attachments = [{ url: oss.url, key: oss.key, name: file.fileName, mime: file.mime,
                           size: file.size, sha256: fileHash, uploaded_at: new Date().toISOString() }];
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
      lineItems,
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
        goods_check: goodsCheck,
        buyer_seller_swapped: swapped,
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
