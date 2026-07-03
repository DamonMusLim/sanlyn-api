// api/db/po-contract.js — PO采购合同 PDF / signed upload / OCR gate
import OSS from "ali-oss";
import crypto from "node:crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { readUploadPayload, validateFile } from "./factory-invoice-upload.js";
import { htmlToPdf } from "./_html-to-pdf.js";
import { expectedPoBaseline, verifyPoUpload } from "./po-verify.js";

export const config = { api: { bodyParser: false } };

function ossClient() {
  return new OSS({
    region: process.env.OSS_REGION || "oss-cn-hongkong",
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || "sanlyn-files",
  });
}

function applyCors(req, res) {
  try { setCors(req, res); } catch { setCors(res); }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function requireAdmin(req) {
  if (req.user?.role !== "admin") {
    const err = new Error("admin required");
    err.status = 403;
    throw err;
  }
}

function safeName(name) {
  const base = String(name || "po_signed.pdf").split(/[\\/]/).pop() || "po_signed.pdf";
  return base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+/, "").slice(0, 120) || "po_signed.pdf";
}

function ymdhms(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function money(n) {
  return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function cnMoney(n) {
  const fraction = ["角", "分"];
  const digit = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
  const unit = [["元", "万", "亿"], ["", "拾", "佰", "仟"]];
  let s = "";
  n = Math.abs(Number(n || 0));
  for (let i = 0; i < fraction.length; i++) {
    s += (digit[Math.floor(n * 10 * Math.pow(10, i)) % 10] + fraction[i]).replace(/零./, "");
  }
  s = s || "整";
  n = Math.floor(n);
  for (let i = 0; i < unit[0].length && n > 0; i++) {
    let p = "";
    for (let j = 0; j < unit[1].length && n > 0; j++) {
      p = digit[n % 10] + unit[1][j] + p;
      n = Math.floor(n / 10);
    }
    s = p.replace(/(零.)*零$/, "").replace(/^$/, "零") + unit[0][i] + s;
  }
  return s.replace(/(零.)*零元/, "元").replace(/(零.)+/g, "零").replace(/^整$/, "零元整");
}

async function fetchPo(pool, contractNo) {
  const orders = await pool.query(
    `SELECT id, order_no, contract_no, factory, factory_code, factory_company_id
       FROM orders
      WHERE contract_no=$1 AND COALESCE(status,'') <> 'cancelled'
      ORDER BY id`,
    [contractNo]
  );
  if (!orders.rows.length) throw Object.assign(new Error("contract_no not found"), { status: 404 });

  const ids = orders.rows.map(r => r.id);
  const items = await pool.query(
    `SELECT
       COALESCE(NULLIF(product_name,''), '未命名产品') AS product_name,
       COALESCE(factory_price,0)::numeric AS factory_price,
       SUM(COALESCE(qty_ctn,0))::numeric AS qty_ctn,
       ROUND(SUM(COALESCE(factory_subtotal, COALESCE(qty_ctn,0)*COALESCE(factory_price,0)))::numeric, 2) AS factory_subtotal
     FROM order_line_items
     WHERE order_id=ANY($1::int[])
     GROUP BY COALESCE(NULLIF(product_name,''), '未命名产品'), COALESCE(factory_price,0)
     ORDER BY product_name`,
    [ids]
  );
  return { order: orders.rows[0], orders: orders.rows, items: items.rows };
}

function renderHtml({ contractNo, po, expected }) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = po.items.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${esc(r.product_name)}</td>
      <td class="num">${money(r.qty_ctn)}</td>
      <td class="num">${money(r.factory_price)}</td>
      <td class="num">${money(r.factory_subtotal)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
@page { size: A4; margin: 12mm 10mm; }
body { font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif; color: #111; font-size: 12px; }
h1 { text-align: center; font-size: 22px; margin: 4px 0 18px; letter-spacing: 2px; }
.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 28px; margin-bottom: 14px; }
.box { border: 1px solid #333; padding: 10px 12px; line-height: 1.8; }
.label { color: #555; display: inline-block; min-width: 62px; }
table { width: 100%; border-collapse: collapse; margin-top: 14px; }
th, td { border: 1px solid #333; padding: 7px 8px; }
th { background: #f2f2f2; font-weight: 700; text-align: center; }
td.num { text-align: right; white-space: nowrap; }
.total { margin-top: 12px; border: 1px solid #333; padding: 10px 12px; font-size: 13px; line-height: 1.9; }
.terms { margin-top: 14px; line-height: 1.9; }
.signs { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; margin-top: 42px; }
.sign { height: 118px; border: 1px solid #333; padding: 10px 12px; position: relative; }
.seal { position: absolute; right: 18px; bottom: 18px; width: 92px; height: 92px; border: 1px dashed #999; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #777; }
.small { color: #555; font-size: 11px; }
</style>
</head>
<body>
<h1>采购合同</h1>
<div class="meta">
  <div><span class="label">合同号：</span>${esc(contractNo)}</div>
  <div><span class="label">日期：</span>${today}</div>
</div>
<div class="box">
  <div><b>买方：</b>厦门巴匕进出口有限公司</div>
  <div><span class="label">税号：</span>91350206MA34RW3852</div>
</div>
<div class="box" style="margin-top:8px">
  <div><b>卖方：</b>${esc(po.order.factory || "")}</div>
  <div><span class="label">工厂代码：</span>${esc(po.order.factory_code || "")}</div>
</div>
<table>
  <thead><tr><th style="width:45px">序号</th><th>产品名称</th><th style="width:95px">箱数</th><th style="width:105px">含税单价</th><th style="width:120px">小计</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="total">
  <div><b>价税合计（小写）：</b>¥${money(expected.expected_amount)}</div>
  <div><b>价税合计（大写）：</b>${cnMoney(expected.expected_amount)}</div>
  <div><b>箱数合计：</b>${money(expected.expected_ctns)} 箱</div>
</div>
<div class="terms">
  <div>一、以上价格为含税人民币价格，卖方应按买方订单要求供货并开具合法有效的增值税发票。</div>
  <div>二、产品数量、单价及金额以本合同明细为准；双方盖章后生效。</div>
  <div>三、本合同与订单明细共同作为采购、对账及发票校验依据。</div>
</div>
<div class="signs">
  <div class="sign"><b>买方盖章：</b><div class="seal">盖章处</div><div class="small">厦门巴匕进出口有限公司</div></div>
  <div class="sign"><b>卖方盖章：</b><div class="seal">盖章处</div><div class="small">${esc(po.order.factory || "")}</div></div>
</div>
</body>
</html>`;
}

async function handlePdf(req, res, contractNo) {
  const pool = getPool();
  const po = await fetchPo(pool, contractNo);
  const expected = await expectedPoBaseline(pool, contractNo);
  const pdf = await htmlToPdf(renderHtml({ contractNo, po, expected }));
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(contractNo)}_po.pdf"`);
  res.end(pdf);
}

async function handleStatus(req, res, contractNo) {
  const pool = getPool();
  const expected = await expectedPoBaseline(pool, contractNo);
  const r = await pool.query(
    `SELECT uploaded_at, review_meta
       FROM document_uploads
      WHERE doc_type='po_signed' AND contract_no=$1
      ORDER BY uploaded_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [contractNo]
  );
  if (!r.rows.length) {
    return send(res, 200, { state: "awaiting_signed", ...expected, found_amount: null, found_ctns: null, uploaded_at: null });
  }
  const meta = r.rows[0].review_meta || {};
  const state = meta.po_check === "pass" ? "verified" : meta.po_check === "mismatch" ? "mismatch" : "need_manual";
  return send(res, 200, {
    state,
    expected_amount: Number(meta.expected_amount ?? expected.expected_amount),
    expected_ctns: Number(meta.expected_ctns ?? expected.expected_ctns),
    found_amount: meta.found_amount ?? null,
    found_ctns: meta.found_ctns ?? null,
    uploaded_at: r.rows[0].uploaded_at,
  });
}

async function handleUploadSigned(req, res) {
  const pool = getPool();
  const { fields, file } = await readUploadPayload(req);
  const verr = validateFile(file);
  if (verr) return send(res, 400, { error: verr });
  if (file.buffer.slice(0, 5).toString("ascii") !== "%PDF-") return send(res, 400, { error: "file is not a PDF" });

  const contractNo = String(fields.contract_no || fields.contractNo || "").trim();
  if (!contractNo) return send(res, 400, { error: "contract_no required" });

  const po = await fetchPo(pool, contractNo);
  const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const key = `shipping/po-signed/${safeName(contractNo)}_${ymdhms()}.pdf`;
  const dryRun = fields.dry_run === true || fields.dry_run === "1" || fields.dry_run === "true";
  if (dryRun) return send(res, 200, { dry_run: true, key, size: file.buffer.length, sha256 });

  const oss = await ossClient().put(key, file.buffer);
  const ins = await pool.query(
    `INSERT INTO document_uploads
       (doc_id, doc_type, contract_no, url, name, size, note, uploader)
     VALUES ($1,'po_signed',$2,$3,$4,$5,$6,$7)
     RETURNING id, uploaded_at`,
    [
      po.order.order_no || contractNo,
      contractNo,
      oss.url,
      safeName(file.fileName),
      file.buffer.length,
      JSON.stringify({ sha256, source: "po-contract.upload_signed" }),
      req.user?.email || req.user?.name || "admin",
    ]
  );

  const check = await verifyPoUpload(pool, { uploadId: ins.rows[0].id, pdfBuffer: file.buffer });
  return send(res, 200, { success: true, url: oss.url, key, size: file.buffer.length, sha256, upload_id: ins.rows[0].id, uploaded_at: ins.rows[0].uploaded_at, check });
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    if (!requireAuth(req, res)) return;
    requireAdmin(req);
    const action = String(req.query.action || "").trim();
    const contractNo = String(req.query.contract_no || req.query.contractNo || "").trim();

    if (req.method === "GET" && action === "pdf") {
      if (!contractNo) return send(res, 400, { error: "contract_no required" });
      return handlePdf(req, res, contractNo);
    }
    if (req.method === "GET" && action === "status") {
      if (!contractNo) return send(res, 400, { error: "contract_no required" });
      return handleStatus(req, res, contractNo);
    }
    if (req.method === "POST") {
      const postAction = action || String(req.body?.action || "").trim();
      if (postAction === "upload_signed") return handleUploadSigned(req, res);
    }
    return send(res, 404, { error: "unknown action" });
  } catch (err) {
    console.error("[po-contract]", err);
    return send(res, err.status || 500, { error: err.message || "po-contract failed" });
  }
}
