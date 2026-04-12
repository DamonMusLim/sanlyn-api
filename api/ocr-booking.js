// /api/ocr-booking.js — Booking Confirmation PDF extraction
// Upload PDF → OSS → Qwen VL extracts structured fields → match orders
// Returns { success, extracted, matchedOrders }

import OSS from "ali-oss";
import { IncomingForm } from "formidable";
import fs from "fs";
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = new IncomingForm({ maxFileSize: 20 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

// ── Upload PDF to OSS and get public URL ──
async function uploadToOSS(buffer, filename) {
  const client = new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
  });
  const ts = Date.now();
  const ossPath = `bookings/${ts}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  await client.put(ossPath, buffer, { mime: "application/pdf" });
  return `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${ossPath}`;
}

// ── Qwen VL extraction ──
async function extractBookingFields(ossUrl) {
  const apiKey = process.env.QWEN_API_KEY || "sk-465c7b0cd9414362912e58fdb7762439";
  const resp = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "qwen-vl-max",
      messages: [{
        role: "user",
        content: [
          { type: "file", file_url: { url: ossUrl } },
          {
            type: "text",
            text: `This is a shipping booking confirmation PDF. Extract ALL information and return ONLY a JSON object (no markdown, no explanation) with these fields:

{
  "bookingNo": "Booking/Reference number",
  "blNo": "Bill of Lading number (if any)",
  "carrier": "Shipping line name (e.g. COSCO, MSK, ONE)",
  "vessel": "Vessel name and voyage number",
  "etd": "ETD date in YYYY-MM-DD format",
  "eta": "ETA date in YYYY-MM-DD format",
  "pol": "Port of Loading (full name)",
  "pod": "Port of Discharge (full name)",
  "finalDest": "Final destination (if different from POD)",
  "containerType": "Container type and quantity (e.g. 3 X 20GP)",
  "containerCount": number of containers,
  "containerSize": "20GP or 40GP or 40HQ etc",
  "shipper": "Shipper company name",
  "consignee": "Consignee company name (if shown)",
  "commodity": "Cargo description",
  "grossWeight": "Total gross weight in KG (number only)",
  "volume": "Total CBM (number only if available)",
  "sealNo": "Seal numbers (comma-separated if multiple)",
  "containerNos": "Container numbers (comma-separated if shown)",
  "cutoffDate": "Document/cargo cutoff date YYYY-MM-DD",
  "cutoffTime": "Cutoff time (HH:MM)",
  "vgmCutoff": "VGM cutoff date YYYY-MM-DD (if shown)",
  "cyOpenDate": "CY Open date YYYY-MM-DD (if shown)",
  "siCutoff": "SI cutoff date YYYY-MM-DD (if shown)",
  "specialInstructions": "Any special notes or instructions",
  "loadingAddress": "Loading/pickup address if shown"
}

If a field is not found in the document, use empty string "" for text or null for numbers. For dates, always convert to YYYY-MM-DD format.`
          }
        ]
      }]
    })
  });

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to find JSON in the response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* fall through */ }
    }
    return { raw: text, parseError: "Failed to parse extraction result" };
  }
}

// ── Match extracted booking against existing orders ──
async function matchOrders(extracted) {
  if (!extracted || extracted.parseError) return [];
  const pool = getPool();

  // Build a flexible query to find matching orders
  // Match by: shipper name, destination port, commodity, dates
  const matches = [];

  try {
    // Strategy 1: Match by booking number if already stored
    if (extracted.bookingNo) {
      const r1 = await pool.query(
        `SELECT id, order_no, customer, status, raw FROM orders
         WHERE raw->>'bookingNo' = $1 OR raw->>'shipmentNo' = $1 LIMIT 10`,
        [extracted.bookingNo]
      );
      if (r1.rows.length > 0) {
        r1.rows.forEach(r => matches.push({ ...r, matchType: "bookingNo" }));
      }
    }

    // Strategy 2: Match by shipper company name (fuzzy)
    if (extracted.shipper) {
      // Extract key words from shipper name for fuzzy match
      const shipperWords = extracted.shipper.toUpperCase()
        .replace(/\b(CO|LTD|LIMITED|INC|CORP|COMPANY|IMPORT|EXPORT|AND|THE)\b/g, "")
        .trim().split(/\s+/).filter(w => w.length > 2);

      if (shipperWords.length > 0) {
        // Match against customer field or raw->>'companyName'
        const conditions = shipperWords.slice(0, 3).map((w, i) => {
          return `(UPPER(customer) LIKE $${i + 1} OR UPPER(raw->>'companyName') LIKE $${i + 1} OR UPPER(raw->>'factory') LIKE $${i + 1})`;
        });
        const params = shipperWords.slice(0, 3).map(w => `%${w}%`);

        const r2 = await pool.query(
          `SELECT id, order_no, customer, status, raw FROM orders
           WHERE (${conditions.join(" AND ")})
           AND status NOT IN ('cancelled', 'deleted')
           ORDER BY created_at DESC LIMIT 20`,
          params
        );

        r2.rows.forEach(r => {
          if (!matches.find(m => m.id === r.id)) {
            matches.push({ ...r, matchType: "shipper" });
          }
        });
      }
    }

    // Strategy 3: Match by destination/POD
    if (extracted.pod && matches.length < 5) {
      const podKey = extracted.pod.toUpperCase().split(/[,/]/).map(s => s.trim()).filter(Boolean);
      if (podKey.length > 0) {
        const podWord = podKey[0].split(/\s+/).filter(w => w.length > 3)[0];
        if (podWord) {
          const r3 = await pool.query(
            `SELECT id, order_no, customer, status, raw FROM orders
             WHERE (UPPER(raw->>'destinationPort') LIKE $1 OR UPPER(raw->>'pod') LIKE $1 OR UPPER(raw->>'destination') LIKE $1)
             AND status NOT IN ('cancelled', 'deleted')
             ORDER BY created_at DESC LIMIT 10`,
            [`%${podWord}%`]
          );
          r3.rows.forEach(r => {
            if (!matches.find(m => m.id === r.id)) {
              matches.push({ ...r, matchType: "destination" });
            }
          });
        }
      }
    }

    // Strategy 4: Match by commodity keyword
    if (extracted.commodity && matches.length < 5) {
      const commodityWords = extracted.commodity.toUpperCase()
        .split(/\s+/).filter(w => w.length > 3).slice(0, 2);
      if (commodityWords.length > 0) {
        const r4 = await pool.query(
          `SELECT id, order_no, customer, status, raw FROM orders
           WHERE UPPER(raw::text) LIKE $1
           AND status NOT IN ('cancelled', 'deleted')
           ORDER BY created_at DESC LIMIT 10`,
          [`%${commodityWords[0]}%`]
        );
        r4.rows.forEach(r => {
          if (!matches.find(m => m.id === r.id)) {
            matches.push({ ...r, matchType: "commodity" });
          }
        });
      }
    }

    // Clean up matches — return summary, not full raw
    return matches.map(m => ({
      id: m.id,
      orderNo: m.order_no,
      customer: m.customer,
      status: m.status,
      matchType: m.matchType,
      companyCode: m.raw?.companyCode || "",
      factory: m.raw?.factory || "",
      destination: m.raw?.destinationPort || m.raw?.pod || "",
      products: (m.raw?.products || []).map(p => p.name || p.productName || "").filter(Boolean).slice(0, 3),
    }));
  } catch (err) {
    console.error("[matchOrders]", err);
    return [];
  }
}

// ── Save extracted booking data to shipping_plans ──
async function saveShippingPlan(extracted, matchedOrders) {
  if (!extracted || extracted.parseError) return null;
  const pool = getPool();
  try {
    // Build a stable _id from booking number
    const bkgClean = (extracted.bookingNo || "").replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
    const planId = bkgClean ? `ocr_bkg_${bkgClean}` : `ocr_bkg_${Date.now()}`;

    // Container type: prefer size code (20GP/40HQ) over full string
    let cType = extracted.containerSize || "";
    if (!cType && extracted.containerType) {
      const m = (extracted.containerType || "").match(/(40HC|40HQ|40GP|20GP)/i);
      cType = m ? m[0].toUpperCase() : extracted.containerType;
    }

    const orderNosStr = matchedOrders.map(m => m.orderNo).filter(Boolean).join(", ");

    const rawData = {
      ocrSource: true,
      bookingNo:  extracted.bookingNo,
      carrier:    extracted.carrier,
      shipper:    extracted.shipper,
      consignee:  extracted.consignee,
      commodity:  extracted.commodity,
      grossWeight: extracted.grossWeight,
      cbm:        extracted.volume,
      sealNo:     extracted.sealNo,
      containerNos: extracted.containerNos,
      containerCount: extracted.containerCount,
      siCutoff:   extracted.siCutoff,
      vgmCutoff:  extracted.vgmCutoff,
      cyOpenDate: extracted.cyOpenDate,
      cutoffTime: extracted.cutoffTime,
      finalDest:  extracted.finalDest,
      loadingAddress: extracted.loadingAddress,
      specialInstructions: extracted.specialInstructions,
      matchedOrderIds: matchedOrders.map(m => m.id),
      extractedAt: new Date().toISOString(),
    };

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
      RETURNING id, _id, shipment_no, bl_no, etd, eta, flow_status
    `, [
      planId,                                      // $1  _id
      extracted.bookingNo || planId,               // $2  shipment_no
      extracted.blNo   || null,                    // $3  bl_no
      extracted.vessel || null,                    // $4  vessel
      extracted.pol    || null,                    // $5  pol
      extracted.pod    || null,                    // $6  pod
      cType            || null,                    // $7  container_type
      extracted.containerNos || null,              // $8  container_no
      extracted.cutoffDate   || null,              // $9  cutoff_date
      extracted.etd    || null,                    // $10 etd
      extracted.eta    || null,                    // $11 eta
      extracted.shipper|| null,                    // $12 customer
      "已订舱",                                    // $13 flow_status
      "booking_confirmed",                         // $14 status
      "Booking",                                   // $15 current_status
      "订舱",                                      // $16 current_status_cn
      JSON.stringify(rawData),                     // $17 raw
    ]);

    const saved = result.rows[0];
    console.log("[ocr-booking] shipping_plan saved:", saved?._id, "action:", saved ? "upserted" : "no row returned");
    return { action: "upserted", plan: saved };
  } catch (err) {
    console.error("[ocr-booking saveShippingPlan]", err.message);
    return { action: "error", error: err.message };
  }
}

// ── Main handler ──
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { fields, files } = await parseForm(req);
    const fileObj = Array.isArray(files.file) ? files.file[0] : files.file;

    // Support two modes:
    // Mode 1: Upload PDF file directly
    // Mode 2: Pass ossUrl of already-uploaded PDF
    let ossUrl = "";

    if (fileObj) {
      const buffer = fs.readFileSync(fileObj.filepath);
      const fname = fileObj.originalFilename || "booking.pdf";
      ossUrl = await uploadToOSS(buffer, fname);
    } else {
      const url = Array.isArray(fields.ossUrl) ? fields.ossUrl[0] : fields.ossUrl;
      if (!url) return res.status(400).json({ error: "Provide file upload or ossUrl" });
      ossUrl = url;
    }

    // Extract fields via Qwen VL
    const extracted = await extractBookingFields(ossUrl);

    // Match against existing orders
    const matchedOrders = await matchOrders(extracted);

    // Save to shipping_plans DB (always — idempotent via ON CONFLICT _id)
    const savedPlan = await saveShippingPlan(extracted, matchedOrders);

    return res.status(200).json({
      success: true,
      ossUrl,
      extracted,
      matchedOrders,
      matchCount: matchedOrders.length,
      savedPlan,
    });
  } catch (err) {
    console.error("[ocr-booking]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
