// 客户水单上传通道（2026-06-12 Damon）：给客户财务一个长期 URL 自助传 Payment Advice。
// fail-closed：?k= 必须等于 env SLIP_UPLOAD_KEY 才收；文件落 uploads/slips/；OCR 自动触发。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dedupeAndRegisterUpload } from "./slip-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UP_DIR = path.join(__dirname, "..", "..", "uploads", "slips");
const MAX_BYTES = 15 * 1024 * 1024;

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS slip_uploads (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    uploader TEXT,
    note TEXT,
    customer_selected_shipments TEXT[],
    size_bytes BIGINT,
    upload_ip TEXT,
    processed BOOLEAN DEFAULT FALSE,
    slip_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE slip_uploads ADD COLUMN IF NOT EXISTS customer_selected_shipments TEXT[]`);
}

function normalizeSelectedShipments(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const shipmentNo = String(item || "").trim().toUpperCase();
    if (!/^CY\d+$/.test(shipmentNo) || seen.has(shipmentNo)) continue;
    seen.add(shipmentNo);
    out.push(shipmentNo);
    if (out.length >= 10) break;
  }
  return out;
}

async function filterSelectedShipmentsByCustomer(pool, shipmentNos, customer) {
  if (!shipmentNos.length) return [];
  const customerTerm = String(customer || "").trim();
  if (!customerTerm) return [];
  const r = await pool.query(
    `SELECT shipment_no
       FROM shipping_plans
      WHERE shipment_no = ANY($1::text[])
        AND (customer ILIKE $2 OR customer_cn ILIKE $2 OR customer_en ILIKE $2)`,
    [shipmentNos, `%${customerTerm}%`]
  );
  const allowed = new Set(r.rows.map(row => String(row.shipment_no || "").toUpperCase()));
  return shipmentNos.filter(shipmentNo => allowed.has(shipmentNo));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0; const chunks = [];
    req.on("data", c => {
      total += c.length;
      if (total > MAX_BYTES + 1024 * 1024) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function duplicateJson(existingDoc) {
  return {
    ok: true,
    duplicate: true,
    existing: existingDoc ? {
      canonical_document_id: existingDoc.id,
      linked_table: existingDoc.linked_table,
      linked_id: existingDoc.linked_id,
      processing_status: existingDoc.processing_status,
      created_at: existingDoc.created_at
    } : null
  };
}

function friendlyOcrError(note) {
  const marker = "OCR_FAIL:";
  const idx = String(note || "").lastIndexOf(marker);
  if (idx < 0) return null;
  const raw = String(note || "").slice(idx + marker.length).trim();
  const low = raw.toLowerCase();
  if (low.includes("payment_date")) {
    return "未能识别出付款日期，请确认图片完整拍到单据日期部分";
  }
  if (low.includes("unknown format") || low.includes("decode")) {
    return "图片格式识别失败，请重新拍摄或换一张图片上传";
  }
  return "识别失败，请联系客服核实";
}

async function getUploadStatus(pool, uploadId) {
  const upload = await pool.query(
    `SELECT id, filename, processed, slip_id, note
       FROM slip_uploads
      WHERE id=$1`,
    [uploadId]
  );
  if (!upload.rows.length) return null;
  const row = upload.rows[0];
  const failedError = friendlyOcrError(row.note);
  if (!row.processed && failedError) {
    return {
      ok: true,
      id: Number(row.id),
      filename: row.filename,
      status: "failed",
      error: failedError
    };
  }

  if (row.processed && row.slip_id) {
    const slip = await pool.query(
      `SELECT amount, currency, sender_name, raw->'match_candidates' AS candidates
         FROM bank_slips
        WHERE id=$1`,
      [row.slip_id]
    );
    const slipRow = slip.rows[0] || {};
    const candidates = Array.isArray(slipRow.candidates) ? slipRow.candidates : [];
    return {
      ok: true,
      id: Number(row.id),
      filename: row.filename,
      status: candidates.length ? "matched" : "no_match",
      amount: slipRow.amount == null ? null : Number(slipRow.amount),
      currency: slipRow.currency || null,
      sender_name: slipRow.sender_name || null,
      candidates
    };
  }

  return {
    ok: true,
    id: Number(row.id),
    filename: row.filename,
    status: "processing"
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const pool = getPool();

  // batch-process: 内部角色调，扫 processed=FALSE 逐条跑 OCR
  if (req.method === "POST" && (req.query && req.query.action) === "process_pending") {
    if (!requireAuth(req, res)) return;
    const role = req.user?.role || "";
    if (role === "customer" || role === "factory") return res.status(403).json({ ok: false, error: "forbidden" });
    const { processSlipUpload } = await import("./slip-ocr.js");
    const pending = await pool.query("SELECT * FROM slip_uploads WHERE processed=FALSE ORDER BY id");
    const errors = [];
    for (const row of pending.rows) {
      try { await processSlipUpload(pool, row); }
      catch (e) { errors.push({ id: row.id, message: e.message }); }
    }
    return res.json({ ok: true, processed: pending.rows.length - errors.length, errors });
  }

  const KEY = process.env.SLIP_UPLOAD_KEY || "";
  const k = (req.query && req.query.k) || "";
  if (!KEY || k !== KEY) return res.status(403).json({ ok: false, error: "链接无效或已停用" }); // fail-closed

  await ensureTable(pool);

  if (req.method === "GET") {
    if ((req.query && req.query.action) === "status") {
      const id = Number.parseInt(String(req.query.id || ""), 10);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: "bad id" });
      }
      const status = await getUploadStatus(pool, id);
      if (!status) return res.status(404).json({ ok: false, error: "not found" });
      return res.json(status);
    }
    const r = await pool.query("SELECT filename, note, created_at FROM slip_uploads ORDER BY id DESC LIMIT 10");
    return res.json({ ok: true, recent: r.rows });
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false });
  try {
    let body;
    if (req.body !== undefined && req.body !== null) {
      body = (typeof req.body === "string") ? JSON.parse(req.body || "{}") : req.body;
    } else {
      const raw = await readBody(req);
      try { body = JSON.parse(raw.toString("utf8")); } catch (e) { return res.status(400).json({ ok: false, error: "bad json" }); }
    }
    const fname = String(body.filename || "slip.pdf").replace(/[^\w.\-一-鿿() ]/g, "_").slice(0, 180);
    const data = Buffer.from(String(body.data || ""), "base64");
    if (!data.length) return res.status(400).json({ ok: false, error: "空文件" });
    if (data.length > MAX_BYTES) return res.status(413).json({ ok: false, error: "文件超过15MB" });
    const okExt = /\.(pdf|png|jpe?g|webp)$/i.test(fname);
    if (!okExt) return res.status(400).json({ ok: false, error: "只收 PDF / 图片" });
    const customerSelectedShipments = await filterSelectedShipmentsByCustomer(
      pool,
      normalizeSelectedShipments(body.customer_selected_shipments),
      req.query?.customer || body.customer
    );

    const stored = Date.now() + "_" + fname;
    const dedupe = await dedupeAndRegisterUpload(pool, {
      domain: "bank_slip",
      fileBytes: data,
      filename: fname,
      storedPath: "uploads/slips/" + stored,
      uploader: String(body.uploader || "").slice(0, 80)
    });
    if (dedupe.isDuplicate) return res.json(duplicateJson(dedupe.existingDoc));

    fs.mkdirSync(UP_DIR, { recursive: true });
    fs.writeFileSync(path.join(UP_DIR, stored), data);

    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0];
    const r = await pool.query(
      `INSERT INTO slip_uploads (filename, stored_path, uploader, note, customer_selected_shipments, size_bytes, upload_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [
        fname,
        "uploads/slips/" + stored,
        String(body.uploader || "").slice(0, 80),
        String(body.note || "").slice(0, 500),
        customerSelectedShipments.length ? customerSelectedShipments : null,
        data.length,
        ip
      ]);

    // 非阻塞：上传成功后异步 OCR 处理
    const uploadRow = {
      id: r.rows[0].id,
      stored_path: "uploads/slips/" + stored,
      filename: fname,
      uploader: String(body.uploader || "").slice(0, 80),
      customer_selected_shipments: customerSelectedShipments,
      file_sha256: dedupe.fileSha256
    };
    setImmediate(async () => {
      try {
        const { processSlipUpload } = await import("./slip-ocr.js");
        await processSlipUpload(pool, uploadRow);
      } catch(e) { console.warn("[slip-upload] OCR pipeline error:", e.message); }
    });

    return res.json({ ok: true, id: r.rows[0].id, filename: fname, at: r.rows[0].created_at });
  } catch (e) {
    if (String(e.message).includes("too large")) return res.status(413).json({ ok: false, error: "文件超过15MB" });
    console.error("[slip-upload]", e.message);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}
