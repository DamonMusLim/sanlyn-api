// api/db/inspection-ocr.js — 商检单/报检单 OCR 抽取管道
// 出境货物检验检疫申请(工厂已报) → 图/PDF → MiniMax-M3 → inspection_request_sheets + 回填工厂检验检疫主数据
// 范本: customs-ocr.js。2026-07-05。qwen 不用,统一 MiniMax-M3。
// POST {doc_id}                              从 document_uploads 取(doc_type ciq_inspection/inspection)
//   或 {image_url} / {pdf_url}               直接给图/PDF(测试或外部)
//   [+ {contract_no} {order_no} {dry_run:true}]
import { getPool, setCors } from "../db.js";
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
function pdfToJpeg(pdfPath) {
  return new Promise((resolve, reject) => {
    const tmpBase = path.join(os.tmpdir(), "insp_" + process.pid + "_" + Math.floor(performance.now()));
    execFile("pdftoppm", ["-jpeg", "-r", "160", "-f", "1", "-l", "1", pdfPath, tmpBase], (err) => {
      if (err) return reject(new Error("pdftoppm failed: " + err.message));
      for (const c of [tmpBase + "-1.jpg", tmpBase + "-01.jpg", tmpBase + "-001.jpg"]) {
        if (fs.existsSync(c)) { const d = fs.readFileSync(c); fs.unlinkSync(c); return resolve(d); }
      }
      reject(new Error("pdftoppm: output not found"));
    });
  });
}
function num(v) { const n = parseFloat(String(v ?? "").replace(/[, ]/g, "")); return isFinite(n) ? n : null; }
function s(v) { return (v == null ? "" : String(v)).trim(); }

const OCR_PROMPT = `这是一张中华人民共和国海关"出境货物检验检疫申请"(商检单/报检单)。提取所有字段，只回 valid JSON，不要 markdown。不要编造，未知文本用""，未知数字用null。货物表每行一个对象。数/重量与货物总值抽纯数字，单位分开抽。
{
  "record_no": "电子底账数据号/编号(右上角)",
  "applicant": "申请单位名称(加盖公章那栏)",
  "applicant_reg_no": "申请单位登记号",
  "contact_name": "联系人",
  "contact_phone": "电话",
  "apply_date": "申请日期 YYYY-MM-DD",
  "shipper_cn": "发货人中文",
  "shipper_en": "发货人外文",
  "consignee_cn": "收货人中文",
  "consignee_en": "收货人外文",
  "contract_no": "合同号",
  "lc_no": "信用证号",
  "usage": "用途",
  "ship_date": "发货日期 YYYY-MM-DD",
  "dest_country": "输往国家(地区)",
  "license_no": "许可证/审批号",
  "departure_place": "启运地",
  "arrival_port": "到达口岸",
  "producer_reg_no": "生产单位注册号",
  "transport": "运输工具名称号码",
  "trade_mode": "贸易方式",
  "storage_place": "货物存放地点",
  "container_spec": "集装箱规格数量及号码",
  "marks": "标记及号码",
  "items": [
    { "name_cn": "货物名称中文", "name_en": "货物名称外文", "hs_code": "H.S.编码", "origin": "产地", "weight": "数/重量(数字)", "weight_unit": "重量单位(如千克)", "value": "货物总值(数字)", "value_currency": "币种(如人民币)", "package": "包装种类及数量(整段照抄)" }
  ],
  "certs": [ { "name": "证单名称(如兽医卫生证书)", "orig": "正份数(数字)", "copy": "副份数(数字)" } ]
}`;

async function ocr(imgBytes, mediaType) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");
  const b64 = imgBytes.toString("base64");
  const resp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "MiniMax-M3", max_tokens: 4096,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: b64 } },
        { type: "text", text: OCR_PROMPT },
      ] }],
    }),
  });
  if (!resp.ok) throw new Error("MiniMax HTTP " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const j = await resp.json();
  const text = (j.content || []).map(c => c.text || "").join("").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in OCR reply: " + text.slice(0, 200));
  return JSON.parse(m[0]);
}

async function fetchUrlBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("fetch image HTTP " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// 拿到 jpeg bytes + mediaType
async function resolveImage(pool, { doc_id, image_url, pdf_url }) {
  if (image_url) {
    const buf = await fetchUrlBytes(image_url);
    const media = /\.png(\?|$)/i.test(image_url) ? "image/png" : "image/jpeg";
    return { bytes: buf, media, source: image_url };
  }
  if (pdf_url) {
    const buf = await fetchUrlBytes(pdf_url);
    const tmp = path.join(os.tmpdir(), "insp_url_" + process.pid + ".pdf");
    fs.writeFileSync(tmp, buf);
    try { return { bytes: await pdfToJpeg(tmp), media: "image/jpeg", source: pdf_url }; }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  if (doc_id) {
    const q = await pool.query(
      `SELECT id, doc_id, url, name, contract_no FROM document_uploads
        WHERE doc_id=$1 AND doc_type IN ('ciq_inspection','inspection','商检','报检单')
        ORDER BY uploaded_at DESC LIMIT 1`, [doc_id]);
    if (!q.rows.length) { const e = new Error("找不到报检单/商检单文件 (document_uploads doc_type=ciq_inspection)"); e.status = 404; throw e; }
    const doc = q.rows[0];
    let objKey = doc.url;
    try { objKey = new URL(doc.url).pathname.replace(/^\/+/, ""); } catch {}
    const obj = await ossClient().get(objKey);
    const isPdf = /\.pdf(\?|$)/i.test(doc.url) || (obj.res && /pdf/i.test(obj.res.headers["content-type"] || ""));
    if (isPdf) {
      const tmp = path.join(os.tmpdir(), "insp_" + process.pid + ".pdf");
      fs.writeFileSync(tmp, obj.content);
      try { return { bytes: await pdfToJpeg(tmp), media: "image/jpeg", source: doc.url, docRow: doc }; }
      finally { try { fs.unlinkSync(tmp); } catch {} }
    }
    const media = /\.png(\?|$)/i.test(doc.url) ? "image/png" : "image/jpeg";
    return { bytes: obj.content, media, source: doc.url, docRow: doc };
  }
  const e = new Error("需要 doc_id 或 image_url 或 pdf_url"); e.status = 400; throw e;
}

export async function runInspectionOcr(pool, body = {}) {
  const { dry_run = false } = body;
  const img = await resolveImage(pool, body);
  const parsed = await ocr(img.bytes, img.media);
  if (dry_run) return { success: true, dry_run: true, source: img.source, parsed };

  // 定位订单: 合同号优先(商检 contract_no) → body → doc.contract_no
  const contractNo = s(parsed.contract_no) || s(body.contract_no) || s(img.docRow && img.docRow.contract_no);
  const orderNo = s(body.order_no) || s(img.docRow && img.docRow.doc_id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 找订单(拿 order_id + factory_code 用于回填)
    let ord = null;
    if (orderNo) { const r = await client.query(`SELECT id, order_no, contract_no, factory_code FROM orders WHERE order_no=$1 LIMIT 1`, [orderNo]); ord = r.rows[0] || null; }
    if (!ord && contractNo) { const r = await client.query(`SELECT id, order_no, contract_no, factory_code FROM orders WHERE contract_no=$1 ORDER BY id LIMIT 1`, [contractNo]); ord = r.rows[0] || null; }

    const certNames = Array.isArray(parsed.certs) ? parsed.certs.map(c => s(c.name)).filter(Boolean) : [];

    // 回填工厂检验检疫主数据(生产单位注册号) — 只在空时填,不覆盖
    let factoryFilled = null;
    if (ord && ord.factory_code && s(parsed.producer_reg_no)) {
      const f = await client.query(
        `UPDATE companies SET registration_no=$1, updated_at=NOW()
          WHERE code=$2 AND (registration_no IS NULL OR btrim(registration_no)='') RETURNING code`,
        [s(parsed.producer_reg_no), ord.factory_code]);
      factoryFilled = f.rows.length ? ord.factory_code : "already";
    }

    // upsert inspection_request_sheets(存整份 OCR + 证书)
    let sheetId = null;
    if (ord) {
      const ex = await client.query(`SELECT id FROM inspection_request_sheets WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, [ord.id]);
      if (ex.rows.length) {
        const u = await client.query(
          `UPDATE inspection_request_sheets SET inspection=$1, requested_certs=$2, updated_at=NOW() WHERE id=$3 RETURNING id`,
          [JSON.stringify(parsed), certNames, ex.rows[0].id]);
        sheetId = u.rows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO inspection_request_sheets (order_id, order_no, contract_no, owner_company_code, status, inspection, requested_certs, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'submitted',$5,$6,NOW(),NOW()) RETURNING id`,
          [ord.id, ord.order_no, ord.contract_no, s(ord.factory_code) || null, JSON.stringify(parsed), certNames]);
        sheetId = ins.rows[0].id;
      }
    }

    if (img.docRow) await client.query(`UPDATE document_uploads SET ocr_status='done', ocr_raw=$1 WHERE id=$2`, [JSON.stringify(parsed), img.docRow.id]);
    await client.query("COMMIT");

    return {
      success: true,
      record_no: s(parsed.record_no),
      contract_no: contractNo,
      matched_order: ord ? ord.order_no : null,
      inspection_sheet_id: sheetId,
      factory_reg_filled: factoryFilled,
      items: (parsed.items || []).length,
      certs: certNames,
      parsed,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });
  try {
    const result = await runInspectionOcr(getPool(), req.body || {});
    return res.status(200).json(result);
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, error: e.message });
  }
}
