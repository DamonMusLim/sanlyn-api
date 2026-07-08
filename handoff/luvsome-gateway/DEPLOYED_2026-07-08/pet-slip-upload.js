// LuvSome payment slip upload skeleton.
// Wire this route to luvsome-gateway's HTTP router, then run the pet slip migration.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { dedupeAndRegisterUpload } from "./slip-core.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UP_DIR = path.join(__dirname, "..", "..", "uploads", "pet-slips");
const MAX_BYTES = 15 * 1024 * 1024;

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS pet_slip_uploads (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    uploader TEXT,
    note TEXT,
    size_bytes BIGINT,
    upload_ip TEXT,
    processed BOOLEAN DEFAULT FALSE,
    slip_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", c => {
      total += c.length;
      if (total > MAX_BYTES + 1024 * 1024) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
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

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const pool = getPool();
  if (req.method === "POST" && req.query?.action === "process_pending") {
    if (!requireAuth(req, res)) return;
    const { processPetSlipUpload } = await import("./pet-slip-ocr.js");
    const pending = await pool.query("SELECT * FROM pet_slip_uploads WHERE processed=FALSE ORDER BY id");
    const errors = [];
    for (const row of pending.rows) {
      try { await processPetSlipUpload(pool, row); }
      catch (e) { errors.push({ id: row.id, message: e.message }); }
    }
    return res.json({ ok: true, processed: pending.rows.length - errors.length, errors });
  }

  await ensureTable(pool);
  if (req.method === "GET") {
    const r = await pool.query("SELECT filename, note, created_at FROM pet_slip_uploads ORDER BY id DESC LIMIT 10");
    return res.json({ ok: true, recent: r.rows });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    let body;
    if (req.body !== undefined && req.body !== null) {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    } else {
      const raw = await readBody(req);
      try { body = JSON.parse(raw.toString("utf8")); }
      catch (_) { return res.status(400).json({ ok: false, error: "bad json" }); }
    }

    const fname = String(body.filename || "pet-slip.pdf").replace(/[^\w.\-一-鿿() ]/g, "_").slice(0, 180);
    const data = Buffer.from(String(body.data || ""), "base64");
    if (!data.length) return res.status(400).json({ ok: false, error: "empty file" });
    if (data.length > MAX_BYTES) return res.status(413).json({ ok: false, error: "file exceeds 15MB" });
    if (!/\.(pdf|png|jpe?g|webp)$/i.test(fname)) {
      return res.status(400).json({ ok: false, error: "PDF / image only" });
    }

    const stored = Date.now() + "_" + fname;
    const uploader = String(body.uploader || "").slice(0, 80);
    const dedupe = await dedupeAndRegisterUpload(pool, {
      domain: "pet_slip",
      fileBytes: data,
      filename: fname,
      storedPath: "uploads/pet-slips/" + stored,
      uploader
    });
    if (dedupe.isDuplicate) return res.json(duplicateJson(dedupe.existingDoc));

    fs.mkdirSync(UP_DIR, { recursive: true });
    fs.writeFileSync(path.join(UP_DIR, stored), data);
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0];
    const r = await pool.query(
      `INSERT INTO pet_slip_uploads (filename, stored_path, uploader, note, size_bytes, upload_ip)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [fname, "uploads/pet-slips/" + stored, uploader, String(body.note || "").slice(0, 500), data.length, ip]
    );

    const uploadRow = {
      id: r.rows[0].id,
      stored_path: "uploads/pet-slips/" + stored,
      filename: fname,
      uploader,
      file_sha256: dedupe.fileSha256
    };
    setImmediate(async () => {
      try {
        const { processPetSlipUpload } = await import("./pet-slip-ocr.js");
        await processPetSlipUpload(pool, uploadRow);
      } catch (e) {
        console.warn("[pet-slip-upload] OCR pipeline error:", e.message);
      }
    });

    return res.json({ ok: true, id: r.rows[0].id, filename: fname, at: r.rows[0].created_at });
  } catch (e) {
    if (String(e.message).includes("too large")) return res.status(413).json({ ok: false, error: "file exceeds 15MB" });
    console.error("[pet-slip-upload]", e.message);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}
