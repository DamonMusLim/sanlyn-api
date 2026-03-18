// api/oss-upload.js — Vercel Serverless Function
// Receives FormData (file + path), uploads to Alibaba Cloud OSS via ali-oss
// Returns { success, url } or { success, error }

import OSS from "ali-oss";
import { IncomingForm } from "formidable";
import fs from "fs";

// Disable Vercel's default body parser so formidable can handle multipart
export const config = { api: { bodyParser: false } };

// ── CORS whitelist ──────────────────────────────────────────
const ALLOWED = [
    "https://sanlyn-os.vercel.app",
    "https://ai.sanlynos.com",
    "http://localhost:5173",
    "http://localhost:3000",
  ];

function setCors(req, res) {
    const origin = req.headers.origin || "";
    if (ALLOWED.includes(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── Parse multipart form ────────────────────────────────────
function parseForm(req) {
    return new Promise((resolve, reject) => {
          const form = new IncomingForm({ maxFileSize: 50 * 1024 * 1024 }); // 50 MB
                           form.parse(req, (err, fields, files) => {
                                   if (err) return reject(err);
                                   resolve({ fields, files });
                           });
    });
}

// ── Main handler ────────────────────────────────────────────
export default async function handler(req, res) {
    setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  // Only POST allowed
  if (req.method !== "POST") {
        return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
        const { fields, files } = await parseForm(req);

      // `path` field — destination key in OSS
      const ossPath = Array.isArray(fields.path) ? fields.path[0] : fields.path;
        if (!ossPath) {
                return res.status(400).json({ success: false, error: "Missing `path` field" });
        }

      // `file` field
      const fileObj = Array.isArray(files.file) ? files.file[0] : files.file;
        if (!fileObj) {
                return res.status(400).json({ success: false, error: "Missing `file` field" });
        }

      // Initialise ali-oss client
      const client = new OSS({
              region: process.env.OSS_REGION,
              accessKeyId: process.env.OSS_ACCESS_KEY_ID,
              accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
              bucket: process.env.OSS_BUCKET,
      });

      // Read temp file buffer and upload
      const buffer = fs.readFileSync(fileObj.filepath);
        const result = await client.put(ossPath, buffer, {
                mime: fileObj.mimetype || "application/octet-stream",
        });

      // Build public URL
      const url = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${ossPath}`;

      return res.status(200).json({ success: true, url });
  } catch (err) {
        console.error("[oss-upload]", err);
        return res.status(500).json({ success: false, error: err.message || "Upload failed" });
  }
}
