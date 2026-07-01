import OSS from "ali-oss";
import crypto from "node:crypto";
import { getPool, setCors } from "../db.js";
import { runCustomsOcr } from "./customs-ocr.js";

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

function safeName(name) {
  const base = String(name || "customs.pdf").split(/[\\/]/).pop() || "customs.pdf";
  return base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+/, "").slice(0, 120) || "customs.pdf";
}

function ymdhms(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function buildKey({ docId, customsNo, name }) {
  return `documents/customs_declaration/${safeName(docId)}/${safeName(customsNo)}/${ymdhms()}-${safeName(name)}`;
}

function requireAdmin(req) {
  if (req.user?.role !== "admin") {
    const err = new Error("admin required");
    err.status = 403;
    throw err;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseContentDisposition(value) {
  const out = {};
  for (const part of String(value || "").split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rest.length) continue;
    out[rawKey.toLowerCase()] = rest.join("=").trim().replace(/^"|"$/g, "");
  }
  return out;
}

function parseMultipart(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const fields = {};
  let file = null;
  let pos = buffer.indexOf(marker);
  while (pos !== -1) {
    let start = pos + marker.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const headerText = buffer.slice(start, headerEnd).toString("utf8");
    const headers = Object.fromEntries(headerText.split("\r\n").map(line => {
      const idx = line.indexOf(":");
      return idx === -1 ? ["", ""] : [line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim()];
    }).filter(([k]) => k));
    const next = buffer.indexOf(marker, headerEnd + 4);
    if (next === -1) break;
    let data = buffer.slice(headerEnd + 4, next);
    if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) data = data.slice(0, -2);
    const cd = parseContentDisposition(headers["content-disposition"]);
    if (cd.filename) file = { buffer: data, name: safeName(cd.filename), type: headers["content-type"] || "" };
    else if (cd.name) fields[cd.name] = data.toString("utf8");
    pos = next;
  }
  return { fields, file };
}

async function parseRequest(req) {
  const contentType = String(req.headers["content-type"] || "");
  const body = await readBody(req);
  if (contentType.includes("multipart/form-data")) {
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
    if (!boundary) throw Object.assign(new Error("missing multipart boundary"), { status: 400 });
    return parseMultipart(body, boundary);
  }
  const json = JSON.parse(body.toString("utf8") || "{}");
  return {
    fields: json,
    file: {
      buffer: Buffer.from(String(json.base64 || ""), "base64"),
      name: safeName(json.name),
      type: "application/pdf",
    },
  };
}

function validatePdf(file) {
  if (!file?.buffer?.length) throw Object.assign(new Error("missing PDF file"), { status: 400 });
  if (file.buffer.length > 20 * 1024 * 1024) throw Object.assign(new Error("PDF exceeds 20MB"), { status: 413 });
  if (file.buffer.slice(0, 5).toString("ascii") !== "%PDF-") throw Object.assign(new Error("file is not a PDF"), { status: 400 });
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  try {
    requireAdmin(req);
    const { fields, file } = await parseRequest(req);
    validatePdf(file);
    const docId = String(fields.doc_id || fields.docId || "").trim();
    const customsNo = String(fields.customs_no || fields.customsNo || "").trim();
    if (!docId || !customsNo) return send(res, 400, { error: "missing doc_id or customs_no" });
    if (!/^\d{18}$/.test(customsNo)) return send(res, 400, { error: "invalid customs_no" });

    const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const key = buildKey({ docId, customsNo, name: file.name });
    const size = file.buffer.length;
    const dryRun = fields.dry_run === true || fields.dry_run === "1" || fields.dry_run === "true";
    if (dryRun) return send(res, 200, { dry_run: true, key, size, sha256 });

    const r = await ossClient().put(key, file.buffer);
    const pool = getPool();

    const ord = await pool.query(
      `SELECT contract_no FROM orders WHERE order_no=$1 LIMIT 1`,
      [docId]
    );
    const contractNo = String(fields.contract_no || fields.contractNo || ord.rows[0]?.contract_no || "").trim() || null;

    const ins = await pool.query(
      `INSERT INTO document_uploads
         (doc_id, doc_type, contract_no, url, name, size, note, uploader)
       VALUES ($1,'customs_decl',$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [docId, contractNo, r.url, file.name, size, JSON.stringify({ customs_no: customsNo, sha256 }), req.user?.email || req.user?.name || "admin"]
    );

    let ocr = null;
    try {
      ocr = await runCustomsOcr(pool, { doc_id: docId, contract_no: contractNo });
    } catch (e) {
      ocr = { success: false, error: e.message };
    }

    return send(res, 200, { url: r.url, key, size, sha256, upload_id: ins.rows[0]?.id, ocr });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || "upload failed" });
  }
}
