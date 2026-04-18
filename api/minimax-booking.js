// /api/minimax-booking.js — BL / Booking PDF 智能录单
// 上传 PDF → OSS 存档 → MiniMax 视觉识别 → 写 shipping_plans + 匹配 orders
// POST: multipart file=<pdf> 或 { url: "<任意可下载链接>" }
// 无需登录（auth bypass 白名单）

import OSS from "ali-oss";
import { IncomingForm } from "formidable";
import fs from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { getPool } from "./db.js";

export const config = { api: { bodyParser: false } };

const ALLOWED = [
  "https://sanlyn-os.vercel.app",
  "https://ai.sanlynos.com",
  "https://ai.sanlyn.cn",
  "http://localhost:5173",
  "http://localhost:3000",
];

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = new IncomingForm({ maxFileSize: 30 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

// ── OSS 上传 ──
async function uploadToOSS(buffer, filename, mimeType = "application/pdf") {
  const client = new OSS({
    region: process.env.OSS_REGION || "oss-cn-hongkong",
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || "sanlyn-files",
  });
  const ts = Date.now();
  const clean = filename.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, "_").slice(0, 60);
  const ossPath = `bl-docs/${ts}_${clean}`;
  await client.put(ossPath, buffer, { mime: mimeType });
  const bucket = process.env.OSS_BUCKET || "sanlyn-files";
  const region = process.env.OSS_REGION || "oss-cn-hongkong";
  return `https://${bucket}.${region}.aliyuncs.com/${ossPath}`;
}

// ── MiniMax 视觉识别 ──
const BL_PROMPT = `你是专业的提单(Bill of Lading)和订舱确认(Booking Confirmation)单据识别专家。

请从图片/文档中精确提取以下字段，严格以JSON格式返回，不要有任何额外说明：

{
  "docType": "BL 或 BOOKING，根据单据类型判断",
  "bl_no": "提单号(B/L No.)",
  "booking_no": "订舱号(Booking No./Reference No.)",
  "carrier": "船公司名称(如 KMTC, COSCO, MSK, ONE, CULines)",
  "vessel": "船名(Vessel Name)",
  "voyage": "航次(Voyage No.)",
  "etd": "开船日期/On Board Date，格式YYYY-MM-DD",
  "eta": "预计到港日期，格式YYYY-MM-DD",
  "pol": "装货港全称(Port of Loading)",
  "pod": "卸货港全称(Port of Discharge)",
  "container_no": "集装箱号，多个用英文逗号分隔",
  "seal_no": "铅封号",
  "container_type": "箱型如40HQ/40GP/20GP",
  "container_qty": 集装箱数量(数字),
  "shipper": "发货人公司名",
  "consignee": "收货人公司名",
  "notify": "通知方公司名",
  "description": "货物描述，简短",
  "hs_code": "HS编码",
  "total_ctns": 总件数(数字),
  "gross_weight_kg": 总毛重KG(数字),
  "cbm": 总体积CBM(数字),
  "cutoff_date": "截关日期，格式YYYY-MM-DD",
  "si_cutoff": "SI截止日期，格式YYYY-MM-DD",
  "original_bl_qty": "正本提单份数(如THREE(3)则填3)"
}

注意：
- 如某字段图片中找不到，填null
- 只返回JSON对象，不要markdown代码块，不要其他文字
- 日期一律转为YYYY-MM-DD格式`;

// ── PDF → JPEG（使用 pdftoppm，服务器已安装 poppler-utils）──
function pdfToJpeg(pdfBuffer) {
  const ts = Date.now();
  const pdfPath = join(tmpdir(), `bl_${ts}.pdf`);
  const outPrefix = join(tmpdir(), `bl_${ts}`);
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    // -r 150: 150 DPI足够OCR; -l 1: 只取第1页; -jpeg: 输出JPEG
    execSync(`pdftoppm -r 150 -l 1 -jpeg "${pdfPath}" "${outPrefix}"`, { timeout: 15000 });
    // pdftoppm 输出文件名为 outPrefix-1.jpg 或 outPrefix-01.jpg
    const candidates = [`${outPrefix}-1.jpg`, `${outPrefix}-01.jpg`];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const buf = fs.readFileSync(c);
        try { fs.unlinkSync(c); } catch {}
        return buf;
      }
    }
    throw new Error("pdftoppm output not found");
  } finally {
    try { fs.unlinkSync(pdfPath); } catch {}
  }
}

// ── Qwen VL 识别（通过OSS URL，从中国大陆可访问）──
async function extractWithQwenVL(ossImageUrl) {
  const apiKey = process.env.QWEN_API_KEY;

  const resp = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-vl-max",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: ossImageUrl } },
          { type: "text", text: BL_PROMPT },
        ],
      }],
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error("Qwen VL error: " + JSON.stringify(data));

  const text = (data.choices?.[0]?.message?.content || "").trim();
  console.log("[minimax-booking] qwen raw:", text.slice(0, 200));
  const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
    return { _raw: text, _parseError: "Failed to parse Qwen VL response" };
  }
}

// ── 匹配已有订单 ──
async function matchOrders(extracted) {
  if (!extracted || extracted._parseError) return [];
  const pool = getPool();
  const matches = [];

  try {
    // 1. BL号精确匹配
    if (extracted.bl_no) {
      const r = await pool.query(
        `SELECT id, order_no, contract_no, customer_po, customer, status, raw
         FROM orders WHERE raw->>'blNo' = $1 OR raw->>'bl_no' = $1 LIMIT 5`,
        [extracted.bl_no]
      );
      r.rows.forEach(row => matches.push({ ...row, matchType: "bl_no" }));
    }

    // 2. 订舱号匹配
    if (extracted.booking_no && matches.length === 0) {
      const r = await pool.query(
        `SELECT id, order_no, contract_no, customer_po, customer, status, raw
         FROM orders WHERE raw->>'bookingNo' = $1 OR raw->>'booking_no' = $1 LIMIT 5`,
        [extracted.booking_no]
      );
      r.rows.forEach(row => {
        if (!matches.find(m => m.id === row.id)) matches.push({ ...row, matchType: "booking_no" });
      });
    }

    // 3. 目的港 + 时间窗口（宽松匹配）
    if (matches.length === 0 && extracted.pod && extracted.etd) {
      const podKey = extracted.pod.split(/[,\s]+/).find(w => w.length > 3) || "";
      const r = await pool.query(
        `SELECT id, order_no, contract_no, customer_po, customer, status, raw
         FROM orders
         WHERE (UPPER(raw->>'pod') LIKE $1 OR UPPER(raw->>'destination') LIKE $1)
           AND status NOT IN ('cancelled','deleted','shipped')
           AND (etd IS NULL OR ABS(etd::date - $2::date) < 30)
         ORDER BY created_at DESC LIMIT 10`,
        [`%${podKey.toUpperCase()}%`, extracted.etd]
      );
      r.rows.forEach(row => {
        if (!matches.find(m => m.id === row.id)) matches.push({ ...row, matchType: "pod+etd" });
      });
    }

    return matches.map(m => ({
      id: m.id,
      orderNo: m.order_no,
      contractNo: m.contract_no,
      customerPO: m.customer_po,
      customer: m.customer,
      status: m.status,
      matchType: m.matchType,
    }));
  } catch (err) {
    console.error("[minimax-booking matchOrders]", err.message);
    return [];
  }
}

// ── 保存到 shipping_plans ──
async function saveShippingPlan(extracted, matchedOrders, ossUrl) {
  if (!extracted || extracted._parseError) return null;
  const pool = getPool();

  const bkgId = (extracted.bl_no || extracted.booking_no || "").replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
  const planId = `mmx_${bkgId || Date.now()}`;

  const rawData = {
    ocrSource: "minimax",
    ossUrl,
    docType: extracted.docType,
    bookingNo: extracted.booking_no,
    carrier: extracted.carrier,
    shipper: extracted.shipper,
    consignee: extracted.consignee,
    notify: extracted.notify,
    description: extracted.description,
    hsCode: extracted.hs_code,
    totalCtns: extracted.total_ctns,
    grossWeightKg: extracted.gross_weight_kg,
    cbm: extracted.cbm,
    sealNo: extracted.seal_no,
    containerQty: extracted.container_qty,
    siCutoff: extracted.si_cutoff,
    originalBlQty: extracted.original_bl_qty,
    matchedOrderIds: matchedOrders.map(m => m.id),
    extractedAt: new Date().toISOString(),
  };

  try {
    const result = await pool.query(`
      INSERT INTO shipping_plans(
        _id, shipment_no, bl_no, vessel,
        pol, pod, container_type, container_no,
        cutoff_date, etd, eta,
        customer, flow_status, status,
        current_status, current_status_cn,
        raw, updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,NOW())
      ON CONFLICT (_id) DO UPDATE SET
        bl_no        = COALESCE(EXCLUDED.bl_no,        shipping_plans.bl_no),
        vessel       = COALESCE(EXCLUDED.vessel,       shipping_plans.vessel),
        container_no = COALESCE(EXCLUDED.container_no, shipping_plans.container_no),
        etd          = COALESCE(EXCLUDED.etd,          shipping_plans.etd),
        eta          = COALESCE(EXCLUDED.eta,          shipping_plans.eta),
        raw          = EXCLUDED.raw,
        updated_at   = NOW()
      RETURNING id, _id, shipment_no, bl_no, etd, eta
    `, [
      planId,
      extracted.booking_no || planId,
      extracted.bl_no || null,
      extracted.vessel ? `${extracted.vessel}${extracted.voyage ? " " + extracted.voyage : ""}` : null,
      extracted.pol || null,
      extracted.pod || null,
      extracted.container_type || null,
      extracted.container_no || null,
      extracted.cutoff_date || null,
      extracted.etd || null,
      extracted.eta || null,
      extracted.shipper || extracted.consignee || null,
      extracted.docType === "BL" ? "已装船" : "已订舱",
      extracted.docType === "BL" ? "shipped" : "booking_confirmed",
      extracted.docType === "BL" ? "Shipped" : "Booking",
      extracted.docType === "BL" ? "已发货" : "订舱",
      JSON.stringify(rawData),
    ]);

    return result.rows[0] || null;
  } catch (err) {
    console.error("[minimax-booking saveShippingPlan]", err.message);
    return { error: err.message };
  }
}

// ── 自动回写订单（如果精确匹配到 BL 号）──
async function backfillOrder(extracted, matchedOrders) {
  if (!extracted.bl_no || matchedOrders.length === 0) return null;
  const exactMatch = matchedOrders.find(m => m.matchType === "bl_no");
  if (!exactMatch) return null;

  const pool = getPool();
  const sets = ["status = 'shipped'"];
  const vals = [];

  if (extracted.bl_no) {
    vals.push(extracted.bl_no);
    sets.push(`raw = jsonb_set(raw, '{blNo}', $${vals.length}::text::jsonb)`);
  }
  if (extracted.container_no) {
    vals.push(JSON.stringify(extracted.container_no));
    sets.push(`raw = jsonb_set(raw, '{containerNo}', $${vals.length}::text::jsonb)`);
  }
  if (extracted.vessel) {
    vals.push(JSON.stringify(`${extracted.vessel}${extracted.voyage ? "/" + extracted.voyage : ""}`));
    sets.push(`raw = jsonb_set(raw, '{vessel}', $${vals.length}::text::jsonb)`);
  }
  if (extracted.etd) {
    vals.push(extracted.etd);
    sets.push(`etd = $${vals.length}::date`);
    const etdFull = JSON.stringify(extracted.etd + "T00:00:00.000Z");
    vals.push(etdFull);
    sets.push(`raw = jsonb_set(raw, '{actDelivery}', $${vals.length}::text::jsonb)`);
  }

  vals.push(exactMatch.orderNo);
  const sql = `UPDATE orders SET ${sets.join(", ")} WHERE order_no = $${vals.length} RETURNING order_no, status, etd`;
  try {
    const r = await pool.query(sql, vals);
    return r.rows[0] || null;
  } catch (err) {
    console.error("[minimax-booking backfillOrder]", err.message);
    return { error: err.message };
  }
}

// ── Main handler ──
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // GET: health check
  if (req.method === "GET") {
    return res.json({ ok: true, endpoint: "minimax-booking", version: "1.0" });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    let buffer, filename, mimeType;

    // 判断是文件上传还是 URL
    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("multipart/form-data")) {
      const { fields, files } = await parseForm(req);
      const fileObj = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!fileObj) {
        // 也可能是 formdata 带 url 字段
        const url = Array.isArray(fields.url) ? fields.url[0] : fields.url;
        if (!url) return res.status(400).json({ error: "请上传文件或提供 url 字段" });
        const dlResp = await fetch(url);
        if (!dlResp.ok) throw new Error("无法下载: " + url);
        buffer = Buffer.from(await dlResp.arrayBuffer());
        filename = url.split("/").pop().split("?")[0] || "document.pdf";
        mimeType = dlResp.headers.get("content-type") || "application/pdf";
      } else {
        buffer = fs.readFileSync(fileObj.filepath);
        filename = fileObj.originalFilename || "document.pdf";
        mimeType = fileObj.mimetype || "application/pdf";
      }
    } else {
      // JSON body with url
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const url = body.url;
      if (!url) return res.status(400).json({ error: "请上传文件或提供 url 字段" });
      const dlResp = await fetch(url);
      if (!dlResp.ok) throw new Error("无法下载: " + url);
      buffer = Buffer.from(await dlResp.arrayBuffer());
      filename = url.split("/").pop().split("?")[0] || "document.pdf";
      mimeType = dlResp.headers.get("content-type") || "application/pdf";
    }

    const isPDF = mimeType.includes("pdf");

    // 1. PDF → 转换为 JPEG（服务器使用 pdftoppm）
    let imgBuffer = buffer;
    let imgMime = mimeType;
    let imgFilename = filename;
    if (isPDF) {
      try {
        console.log("[minimax-booking] converting PDF to JPEG...");
        imgBuffer = pdfToJpeg(buffer);
        imgMime = "image/jpeg";
        imgFilename = filename.replace(/\.pdf$/i, ".jpg");
        console.log("[minimax-booking] PDF→JPEG OK, size:", imgBuffer.length);
      } catch (convErr) {
        console.warn("[minimax-booking] PDF conversion failed:", convErr.message);
        // 回退：直接上传原PDF，Qwen VL可能拒绝但尝试一下
      }
    }

    // 2. 上传图片到 OSS（存档+供 Qwen VL 使用）
    let ossUrl = null;
    let ossImageUrl = null;
    try {
      // 存储原始文件（PDF）
      ossUrl = await uploadToOSS(buffer, filename, mimeType);
      // 如果转换了图片，也上传图片版本（供Qwen VL识别）
      if (isPDF && imgBuffer !== buffer) {
        ossImageUrl = await uploadToOSS(imgBuffer, imgFilename, imgMime);
      } else {
        ossImageUrl = ossUrl;
      }
      console.log("[minimax-booking] OSS PDF:", ossUrl);
      console.log("[minimax-booking] OSS IMG:", ossImageUrl);
    } catch (ossErr) {
      console.warn("[minimax-booking] OSS upload failed:", ossErr.message);
    }

    // 3. Qwen VL 识别（通过 OSS URL，大陆可访问）
    if (!ossImageUrl) throw new Error("OSS upload failed, cannot extract");
    const extracted = await extractWithQwenVL(ossImageUrl);
    console.log("[minimax-booking] extracted:", JSON.stringify(extracted).slice(0, 200));

    // 3. 匹配订单
    const matchedOrders = await matchOrders(extracted);

    // 4. 写 shipping_plans
    const savedPlan = await saveShippingPlan(extracted, matchedOrders, ossUrl);

    // 5. 精确匹配时自动回写 orders
    const backfilled = await backfillOrder(extracted, matchedOrders);

    return res.json({
      success: true,
      ossUrl,
      extracted,
      matchedOrders,
      matchCount: matchedOrders.length,
      savedPlan,
      backfilled,
    });
  } catch (err) {
    console.error("[minimax-booking]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
