// /api/db/stamp-pdf.js  v2
// POST { templateCode, stampUrl, position?, pages? }
// → streams back stamped PDF

import { requireAuth } from "../auth.js";
import { setCors }      from "../db.js";
import fs               from "fs";
import path             from "path";
import os               from "os";
import { execFile }     from "child_process";
import { promisify }    from "util";
import { fileURLToPath } from "url";
import { dirname }      from "path";

const execFileAsync = promisify(execFile);
const __dirname2    = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname2, "../../public/templates");
const PUBLIC_DIR    = path.join(__dirname2, "../../public");
const MANIFEST_PATH = path.join(TEMPLATES_DIR, "manifest.json");
const STAMP_SCRIPT  = path.join(__dirname2, "../../stamp_pdf.py");

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")).templates || []; }
  catch { return []; }
}

// Resolve stamp image: local public/ path → filesystem; external → fetch
async function resolveStamp(stampUrl, tmpPath) {
  // Match /public/<file> or http://localhost:PORT/public/<file>
  const localMatch = stampUrl.match(/\/public\/([^?#]+)$/);
  if (localMatch) {
    const localFile = path.join(PUBLIC_DIR, localMatch[1]);
    if (fs.existsSync(localFile)) {
      fs.copyFileSync(localFile, tmpPath);
      return;
    }
  }
  // External URL — fetch
  const resp = await fetch(stampUrl, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error("Cannot fetch stamp image: HTTP " + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(tmpPath, buf);
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!requireAuth(req, res)) return;

  const { templateCode, stampUrl, position = "br", pages = "last" } = req.body || {};
  if (!templateCode) return res.status(400).json({ error: "templateCode required" });
  if (!stampUrl)     return res.status(400).json({ error: "stampUrl required" });

  // Resolve template PDF
  const tpl = loadManifest().find(t => t.code === templateCode);
  if (!tpl)                     return res.status(404).json({ error: "Template not found: " + templateCode });
  if (!tpl.name.endsWith(".pdf")) return res.status(400).json({ error: "Not a PDF template: " + tpl.name });
  const inputPdf = path.join(TEMPLATES_DIR, tpl.name);
  if (!fs.existsSync(inputPdf)) return res.status(404).json({ error: "PDF missing: " + tpl.name });

  const tmpId    = "stmp_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  const stampTmp = path.join(os.tmpdir(), tmpId + ".png");
  const outPdf   = path.join(os.tmpdir(), tmpId + "_out.pdf");

  try {
    await resolveStamp(stampUrl, stampTmp);

    await execFileAsync("python3", [
      STAMP_SCRIPT,
      inputPdf, stampTmp, outPdf,
      "--position", position,
      "--pages",    pages,
    ], { timeout: 30000 });

    const stat    = fs.statSync(outPdf);
    const safeName = encodeURIComponent((tpl.label || tpl.name).replace(/[^\w一-龥._-]/g, "_") + "_盖章.pdf");
    res.setHeader("Content-Type",        "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${safeName}`);
    res.setHeader("Content-Length",      stat.size);
    fs.createReadStream(outPdf).pipe(res).on("finish", () => {
      fs.unlink(stampTmp, () => {});
      fs.unlink(outPdf,   () => {});
    });
  } catch (err) {
    fs.unlink(stampTmp, () => {});
    fs.unlink(outPdf,   () => {});
    console.error("[stamp-pdf]", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Stamp failed: " + err.message });
  }
}
