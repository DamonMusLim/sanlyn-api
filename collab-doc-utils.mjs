import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export const DOC_TYPES = new Set(["pl_sc_iv", "bl", "freight_bill", "portcharge_bill", "insurance", "fe"]);

export function parseArgs(argv) {
  const out = { commit: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--commit") out.commit = true;
    else if (a === "--only") out.only = argv[++i] || "";
    else if (a.startsWith("--only=")) out.only = a.slice(7);
    else if (a === "--months") out.months = Number(argv[++i] || 0);
    else if (a.startsWith("--months=")) out.months = Number(a.slice(9));
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
    else if (a === "--root") out.root = argv[++i] || "";
    else if (a.startsWith("--root=")) out.root = a.slice(7);
    else if (a === "--api-root") out.apiRoot = argv[++i] || "";
    else if (a.startsWith("--api-root=")) out.apiRoot = a.slice(11);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

export function mapDocType(filename) {
  const base = path.basename(String(filename || "")).trim();
  if (/^FE_/i.test(base)) return "fe";
  if (/^BL_/i.test(base)) return "bl";
  if (/^(PL\+SC\+IV|PL)/i.test(base)) return "pl_sc_iv";
  if (/^海运费单/.test(base)) return "freight_bill";
  if (/^港杂费账单/.test(base)) return "portcharge_bill";
  if (/^货运险保单/.test(base)) return "insurance";
  return "";
}

export function extractLookup(filename, docType) {
  const base = path.basename(String(filename || ""), path.extname(String(filename || "")));
  if (docType === "fe") {
    return { kind: "cert_no", value: base.replace(/^FE[_\s-]*/i, "").trim() };
  }
  let s = base
    .replace(/^(PL\+SC\+IV|PL|BL)[_\s-]*/i, "")
    .replace(/^(海运费单|港杂费账单|货运险保单)[_\s-]*/u, "")
    .trim();
  s = (s.match(/[A-Z]{3,5}\d{6,12}[A-Z0-9]*/i) || s.match(/[A-Z0-9][A-Z0-9-]{5,}/i) || [""])[0];
  return { kind: "bl_no", value: s.toUpperCase() };
}

export function safeStoredName(docType, source, filename) {
  const ext = path.extname(filename || "") || ".pdf";
  const stem = path.basename(filename || "document", ext)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90) || "document";
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${docType}-${source}-${ts}-${stem}${ext}`;
}

export function mimeFromName(filename) {
  return /\.pdf$/i.test(filename || "") ? "application/pdf" : "application/octet-stream";
}

export function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] != null) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

export function pgFromBase(base = process.env.PG_MODULE_BASE || "/opt/sanlyn-api-test/package.json") {
  const req = createRequire(base);
  return req("pg");
}

export function parseUploads(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

export function hasUpload(plan, docType, source, filename = "") {
  const uploads = parseUploads(plan.collab_uploads || (plan.raw && plan.raw.collab_uploads));
  return uploads.some((u) => {
    if (!u || u.doc_type !== docType) return false;
    if (u.source === source) return true;
    return filename && u.filename === filename;
  });
}

export async function appendUpload(client, planId, upload) {
  const q = `
    UPDATE shipping_plans
       SET raw = jsonb_set(
         COALESCE(raw, '{}'::jsonb),
         '{collab_uploads}',
         COALESCE(raw->'collab_uploads', '[]'::jsonb) || $2::jsonb,
         true
       ),
       updated_at = NOW()
     WHERE id::text = $1 OR _id = $1
     RETURNING id, _id`;
  const r = await client.query(q, [String(planId), JSON.stringify([upload])]);
  return r.rows[0] || null;
}

export function printRow(cols) {
  console.log(cols.map((v) => String(v == null ? "" : v)).join(" | "));
}
