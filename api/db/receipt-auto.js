import { getPool, setCors } from "../db.js";
import { ossUploadBuffer } from "../oss-direct.js";
import { renderReceiptDocByTemplate } from "./receipt-doc.js";

const TEMPLATE_BY_COMPANY = {
  BABI: "template1_xiamen_babi",
  OCEANBABY: "template2_shanghai_oceanbaby",
};

function json(res, status, body) {
  return res.status(status).json(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function cleanText(v) {
  return String(v || "").trim();
}

function cleanContract(v) {
  return cleanText(v).replace(/^\d+-/, "");
}

function safePathPart(v) {
  const s = cleanText(v) || "no-bank-ref";
  return s.replace(/[^\w.-]+/g, "_").slice(0, 80);
}

function startDate() {
  return process.env.RECEIPT_AUTO_DRAFT_START_DATE || "2026-09-10";
}

async function ensureColumn(pool) {
  await pool.query("ALTER TABLE bank_slips ADD COLUMN IF NOT EXISTS receipt_doc_url TEXT");
}

async function loadSlip(pool, slipId) {
  const r = await pool.query(
    `SELECT id, amount, currency, sender_name, sender_country, payment_date,
            remark_details, bank_reference_no, beneficiary_company_code,
            receipt_doc_url, created_at
       FROM bank_slips
      WHERE id=$1`,
    [slipId]
  );
  return r.rows[0] || null;
}

async function loadContracts(pool, slipId) {
  const r = await pool.query(
    `SELECT DISTINCT NULLIF(BTRIM(contract_no), '') AS contract_no
       FROM bank_slip_links
      WHERE slip_id=$1 AND NULLIF(BTRIM(contract_no), '') IS NOT NULL
      ORDER BY contract_no`,
    [slipId]
  );
  return r.rows.map((x) => cleanContract(x.contract_no)).filter(Boolean);
}

async function loadGoodsDesc(pool, contractNos) {
  if (!contractNos.length) return "";
  const r = await pool.query(
    `SELECT DISTINCT NULLIF(BTRIM(oli.declaration_name), '') AS declaration_name
       FROM orders o
       JOIN order_line_items oli ON oli.order_id = o.id
      WHERE (
            o.contract_no = ANY($1::text[])
         OR regexp_replace(COALESCE(o.contract_no,''), '^\\d+-', '') = ANY($1::text[])
         OR o.order_no = ANY($1::text[])
      )
        AND NULLIF(BTRIM(oli.declaration_name), '') IS NOT NULL
      ORDER BY declaration_name`,
    [contractNos]
  );
  return r.rows.map((x) => cleanText(x.declaration_name)).filter(Boolean).join("、");
}

async function loadTemplate(pool, companyCode) {
  const templateKey = TEMPLATE_BY_COMPANY[cleanText(companyCode).toUpperCase()];
  if (!templateKey) throw Object.assign(new Error("receipt_template_unknown_company"), { status: 400 });
  const r = await pool.query(
    "SELECT template_key, trade_type FROM receipt_company_templates WHERE template_key=$1",
    [templateKey]
  );
  if (!r.rows.length || !r.rows[0].trade_type) {
    throw Object.assign(new Error("receipt_template_not_found"), { status: 400 });
  }
  return r.rows[0];
}

async function dryRunCount(pool) {
  await ensureColumn(pool);
  const r = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM bank_slips
      WHERE created_at >= $1::date
        AND receipt_doc_url IS NULL
        AND amount IS NOT NULL
        AND NULLIF(BTRIM(COALESCE(beneficiary_company_code,'')), '') IS NOT NULL`,
    [startDate()]
  );
  return r.rows[0]?.count || 0;
}

async function createDraft(pool, slipId) {
  await ensureColumn(pool);
  const slip = await loadSlip(pool, slipId);
  if (!slip) throw Object.assign(new Error("bank_slip_not_found"), { status: 404 });
  if (new Date(slip.created_at) < new Date(`${startDate()}T00:00:00Z`)) {
    throw Object.assign(new Error("bank_slip_before_receipt_auto_start_date"), { status: 409 });
  }

  const tpl = await loadTemplate(pool, slip.beneficiary_company_code);
  const contractNos = await loadContracts(pool, slip.id);
  const goodsDesc = tpl.trade_type === "goods" ? await loadGoodsDesc(pool, contractNos) : "";
  const missingFields = { goods_desc: tpl.trade_type === "goods" && !goodsDesc };
  const receipt = await renderReceiptDocByTemplate(pool, tpl.template_key, {
    amount_total: slip.amount,
    payer_name: slip.sender_name,
    payer_country: slip.sender_country || "",
    contract_no: contractNos.join(", "),
    goods_desc: goodsDesc,
    currency: slip.currency || "CNY",
    receipt_date: slip.payment_date,
    stamp_seal: false,
  });
  if (!receipt) throw Object.assign(new Error("receipt_draft_render_failed"), { status: 500 });

  const ref = safePathPart(slip.bank_reference_no || `slip-${slip.id}`);
  const key = `documents/receipt-notices/${ref}/draft-${slip.id}.pdf`;
  const url = await ossUploadBuffer(key, receipt.pdfBuffer, "application/pdf");
  await pool.query("UPDATE bank_slips SET receipt_doc_url=$1 WHERE id=$2", [url, slip.id]);
  return {
    slip_id: Number(slip.id),
    receipt_doc_url: url,
    template_key: tpl.template_key,
    trade_type: tpl.trade_type,
    contract_no: contractNos.join(", "),
    missingFields,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { success: false, error: "method_not_allowed" });

  try {
    const body = await readJson(req);
    const pool = getPool();
    if (body.dry_run) {
      const count = await dryRunCount(pool);
      return json(res, 200, {
        success: true,
        dry_run: true,
        start_date: startDate(),
        auto_enabled: process.env.RECEIPT_AUTO_DRAFT === "1",
        would_generate: count,
      });
    }
    if (process.env.RECEIPT_AUTO_DRAFT !== "1") {
      return json(res, 409, {
        success: false,
        error: "receipt_auto_draft_disabled",
        start_date: startDate(),
        auto_enabled: false,
      });
    }
    const slipId = Number.parseInt(String(body.slip_id || ""), 10);
    if (!slipId) return json(res, 400, { success: false, error: "slip_id_required" });
    const result = await createDraft(pool, slipId);
    return json(res, 200, { success: true, draft: true, ...result });
  } catch (e) {
    return json(res, e.status || 500, { success: false, error: e.message || "receipt_auto_failed" });
  }
}
