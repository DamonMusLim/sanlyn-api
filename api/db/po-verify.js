// api/db/po-verify.js — PO signed contract OCR gate
import OSS from "ali-oss";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";

function ossClient() {
  return new OSS({
    region: process.env.OSS_REGION || "oss-cn-hongkong",
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || "sanlyn-files",
  });
}

function num(v) {
  const n = parseFloat(String(v ?? "").replace(/[,，\s￥¥]/g, ""));
  return isFinite(n) ? n : null;
}

function s(v) {
  return (v == null ? "" : String(v)).trim();
}

export async function expectedPoBaseline(pool, contractNo) {
  const r = await pool.query(
    `SELECT
       ROUND(COALESCE(SUM(COALESCE(oli.factory_subtotal, COALESCE(oli.qty_ctn,0)*COALESCE(oli.factory_price,0))),0)::numeric, 2) AS expected_amount,
       COALESCE(SUM(COALESCE(oli.qty_ctn,0)),0)::numeric AS expected_ctns
     FROM orders o
     JOIN order_line_items oli ON oli.order_id=o.id
     WHERE o.contract_no=$1
       AND COALESCE(o.status,'') <> 'cancelled'`,
    [contractNo]
  );
  return {
    expected_amount: num(r.rows[0]?.expected_amount) || 0,
    expected_ctns: num(r.rows[0]?.expected_ctns) || 0,
  };
}

function pdfToJpeg(pdfPath) {
  return new Promise((resolve, reject) => {
    const base = path.join(os.tmpdir(), `po_${process.pid}_${Date.now()}`);
    execFile("pdftoppm", ["-jpeg", "-r", "170", "-f", "1", "-l", "2", pdfPath, base], (err) => {
      if (err) return reject(new Error("pdftoppm failed: " + err.message));
      const out = [];
      for (const suffix of ["-1.jpg", "-01.jpg", "-001.jpg", "-2.jpg", "-02.jpg", "-002.jpg"]) {
        const f = base + suffix;
        if (fs.existsSync(f)) {
          out.push(fs.readFileSync(f));
          try { fs.unlinkSync(f); } catch {}
        }
      }
      if (!out.length) return reject(new Error("pdftoppm: output not found"));
      resolve(out);
    });
  });
}

const OCR_PROMPT = `这是一份采购合同或盖章回传合同。请识别全文，重点找价税合计/合计金额/合同金额以及箱数合计。只返回 valid JSON，不要 markdown：
{
  "raw_text": "识别到的全文，保留金额和箱数上下文",
  "total_amount": "价税合计/合计/合同金额，数字，未知为null",
  "total_ctns": "箱数合计，数字，未知为null"
}`;

async function ocrPdfBuffer(pdfBuffer) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");

  const tmpPdf = path.join(os.tmpdir(), `po_${process.pid}_${Date.now()}.pdf`);
  fs.writeFileSync(tmpPdf, pdfBuffer);
  let images;
  try { images = await pdfToJpeg(tmpPdf); }
  finally { try { fs.unlinkSync(tmpPdf); } catch {} }

  const content = images.slice(0, 2).map(img => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") },
  }));
  content.push({ type: "text", text: OCR_PROMPT });

  const resp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "MiniMax-M3", max_tokens: 4096, messages: [{ role: "user", content }] }),
  });
  if (!resp.ok) throw new Error("MiniMax HTTP " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const j = await resp.json();
  const text = (j.content || []).map(c => c.text || "").join("").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in OCR reply: " + text.slice(0, 200));
  return JSON.parse(m[0]);
}

function extractAmount(text, fallback) {
  const raw = String(text || "");
  const amounts = [];
  const re = /(价税合计|合计金额|合同金额|合计|总计|总金额)[\s\S]{0,80}?([¥￥]?\s*\d[\d,，]*(?:\.\d{1,2})?)/g;
  let m;
  while ((m = re.exec(raw))) {
    const n = num(m[2]);
    if (n != null) amounts.push(n);
  }
  if (amounts.length) return Math.max(...amounts);

  const all = [...raw.matchAll(/[¥￥]\s*(\d[\d,，]*(?:\.\d{1,2})?)/g)].map(x => num(x[1])).filter(x => x != null);
  if (all.length) return Math.max(...all);
  return num(fallback);
}

function extractCtns(text, fallback) {
  const raw = String(text || "");
  const hits = [];
  const re = /(箱数合计|总箱数|合计箱数|箱数|数量)[\s\S]{0,50}?(\d[\d,，]*(?:\.\d+)?)\s*(箱|CTN|CTNS|ctn|ctns)/g;
  let m;
  while ((m = re.exec(raw))) {
    const n = num(m[2]);
    if (n != null) hits.push(n);
  }
  if (hits.length) return Math.max(...hits);
  return num(fallback);
}

async function loadPdfFromOss(url) {
  let key = url;
  try { key = new URL(url).pathname.replace(/^\/+/, ""); } catch {}
  const obj = await ossClient().get(key);
  return obj.content;
}

async function writeResult(pool, uploadId, result, ocrRaw, ocrStatus = "done") {
  await pool.query(
    `UPDATE document_uploads
        SET ocr_status=$1,
            ocr_raw=$2,
            review_meta=COALESCE(review_meta,'{}'::jsonb) || $3::jsonb
      WHERE id=$4`,
    [ocrStatus, JSON.stringify(ocrRaw || {}), JSON.stringify(result), uploadId]
  );
}

export async function verifyPoUpload(pool, { uploadId, pdfBuffer } = {}) {
  const d = await pool.query(
    `SELECT id, contract_no, url
       FROM document_uploads
      WHERE id=$1 AND doc_type='po_signed'
      LIMIT 1`,
    [uploadId]
  );
  if (!d.rows.length) throw Object.assign(new Error("po_signed upload not found"), { status: 404 });

  const doc = d.rows[0];
  const contractNo = s(doc.contract_no);
  const expected = await expectedPoBaseline(pool, contractNo);

  let parsed = null;
  let foundAmount = null;
  let foundCtns = null;
  let poCheck = "need_manual";

  try {
    const buf = pdfBuffer || await loadPdfFromOss(doc.url);
    parsed = await ocrPdfBuffer(buf);
    const rawText = s(parsed.raw_text) || JSON.stringify(parsed);
    foundAmount = extractAmount(rawText, parsed.total_amount);
    foundCtns = extractCtns(rawText, parsed.total_ctns);

    if (foundAmount == null) {
      poCheck = "need_manual";
    } else {
      const diffRate = expected.expected_amount === 0
        ? Math.abs(foundAmount)
        : Math.abs(foundAmount - expected.expected_amount) / expected.expected_amount;
      const ctnOk = foundCtns == null || Math.round(foundCtns) === Math.round(expected.expected_ctns);
      poCheck = diffRate <= 0.01 && ctnOk ? "pass" : "mismatch";
    }

    const result = {
      po_check: poCheck,
      expected_amount: expected.expected_amount,
      found_amount: foundAmount,
      expected_ctns: expected.expected_ctns,
      found_ctns: foundCtns,
      checked_at: new Date().toISOString(),
    };
    await writeResult(pool, uploadId, result, parsed, "done");
    return { success: true, ...result };
  } catch (e) {
    const result = {
      po_check: "need_manual",
      expected_amount: expected.expected_amount,
      found_amount: null,
      expected_ctns: expected.expected_ctns,
      found_ctns: null,
      checked_at: new Date().toISOString(),
      error: e.message,
    };
    await writeResult(pool, uploadId, result, parsed || { error: e.message }, "error");
    return { success: true, ...result };
  }
}
