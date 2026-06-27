// ══════════════════════════════════════════════════════════
// /api/db/templates-list — Local HTML Template Library
// GET /api/db/templates-list        → manifest of all .html files
// GET /api/db/templates-list/preview?file=<name> → serve file content
// Whitelist: only ~/Desktop/Sanlyn/templates/*.html — no path traversal
// Dev/Mac only — production serves a static copy of the manifest
// ══════════════════════════════════════════════════════════
import { setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import fs from "fs";
import path from "path";
import os from "os";

var TEMPLATES_DIR = path.join(os.homedir(), "Desktop", "Sanlyn", "templates");
// On prod server, fall back to a static copy if installed
var PROD_MANIFEST_PATH = "/opt/sanlyn-templates/manifest.json";
var PUBLIC_MANIFEST_PATH = "/opt/sanlyn-api-test/public/templates/manifest.json";

function categorize(name) {
  var n = name.toLowerCase();
  if (n.startsWith("cn_") || n.includes("credit")) return "CN";
  if (n.startsWith("freight-") || (n.includes("freight") && !n.startsWith("invoice"))) return "Freight";
  if (n.startsWith("customs-") || (n.includes("customs") && !n.startsWith("invoice"))) return "Customs";
  if (n.startsWith("booking-") || n.startsWith("docs-") || n.startsWith("das-")) return "Booking";
  if (n.startsWith("brand-") || n.startsWith("collab-") || n.startsWith("pi-")) return "Brand";
  return "Other";
}

function sizeLabel(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function buildManifest() {
  var dir = TEMPLATES_DIR;
  if (!fs.existsSync(dir)) return { total: 0, files: [], generated: new Date().toISOString().slice(0, 10), source: "dir_not_found" };

  var entries = fs.readdirSync(dir)
    .filter(function(f) { return f.endsWith(".html"); })
    .map(function(f) {
      try {
        var stat = fs.statSync(path.join(dir, f));
        return {
          name: f,
          cat: categorize(f),
          mtime: stat.mtime.toISOString().slice(0, 10),
          size: stat.size,
          size_label: sizeLabel(stat.size),
        };
      } catch(e) { return null; }
    })
    .filter(Boolean)
    .sort(function(a, b) { return b.mtime.localeCompare(a.mtime); });

  return { total: entries.length, files: entries, generated: new Date().toISOString().slice(0, 10) };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Preview: no auth needed (internal HTML templates) ──
  var isPreview = (req.url || "").includes("/preview");
  if (isPreview) {
    var fileName = (req.query.file || "").replace(/\//g, "").replace(/\.\./g, "");
    if (!fileName || !fileName.endsWith(".html")) {
      return res.status(400).json({ error: "Invalid file parameter. Must be *.html filename only." });
    }
    var filePath = path.join(TEMPLATES_DIR, fileName);
    // Safety: verify resolved path stays within TEMPLATES_DIR
    var resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(TEMPLATES_DIR))) {
      return res.status(403).json({ error: "Path traversal blocked" });
    }
    if (!fs.existsSync(resolved)) {
      // Try public/templates fallback
      var pubPath = path.join("/opt/sanlyn-api-test/public/templates", fileName);
      if (fs.existsSync(pubPath)) { resolved = pubPath; }
      else { return res.status(404).json({ error: "File not found: " + fileName }); }
    }
    var content = fs.readFileSync(resolved, "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(content);
  }

  if (!requireAuth(req, res)) return;
  var isAdmin = req.user && req.user.role === "admin";
  if (!isAdmin) return res.status(403).json({ error: "Admin only" });

  // ── Manifest endpoint: GET /api/db/templates-list ──
  if (req.method === "GET") {
    // Try local dir first (Mac dev)
    if (fs.existsSync(TEMPLATES_DIR)) {
      var manifest = buildManifest();
      return res.status(200).json({ success: true, ...manifest });
    }
    // Prod fallback: serve static manifest copy if it exists
    if (fs.existsSync(PROD_MANIFEST_PATH)) {
      try {
        var data = JSON.parse(fs.readFileSync(PROD_MANIFEST_PATH, "utf8"));
        return res.status(200).json({ success: true, ...data, source: "static_copy" });
      } catch(e) {
        return res.status(500).json({ success: false, error: "Manifest parse error: " + e.message });
      }
    }
    // Public templates dir fallback (production canonical path)
    var publicManifestPath = PUBLIC_MANIFEST_PATH;
    if (fs.existsSync(publicManifestPath)) {
      try {
        var pubData = JSON.parse(fs.readFileSync(publicManifestPath, "utf8"));
        var pubFiles = pubData.templates || pubData.files || [];
        return res.status(200).json({ success: true, total: pubFiles.length, files: pubFiles, generated: pubData.generated || new Date().toISOString().slice(0, 10), source: "public_manifest" });
      } catch(e) {
        return res.status(500).json({ success: false, error: "Public manifest parse error: " + e.message });
      }
    }
    // Nothing available
    return res.status(200).json({
      success: true, total: 0, files: [],
      generated: new Date().toISOString().slice(0, 10),
      note: "Templates directory not found on this server. This is a dev-only feature.",
    });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
