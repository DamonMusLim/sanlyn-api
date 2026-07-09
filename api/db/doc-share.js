// /api/db/doc-share.js
// Secure one-time document sharing with password + download tracking
//
// POST { contractNo, docKey, docUrl, docName, createdBy, recipientLabel, note }
//   → creates a share token, returns { token, password, shareUrl, expiresAt }
//
// GET  ?token=xxx&password=yyy
//   → verifies password, checks expiry + download count, redirects to file
//   → logs IP + timestamp; blocks on re-download

import { getPool } from "../db.js";
import { randomBytes } from "crypto";
import { existsSync, createReadStream } from "fs";

const SHARE_BASE = process.env.API_BASE || "https://api.sanlyn.cn";

// ── Password generator: 3 groups, e.g. "K7m-9Pq-4Rx" ──────────────────
function genPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const seg = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return seg(3) + "-" + seg(3) + "-" + seg(3);
}

// ── Token: 12 hex chars (48 bits, still ~280 trillion combos for 7-day one-time link) ──
function genToken() {
  return randomBytes(6).toString("hex");
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  // ── POST: create share link ─────────────────────────────────────────
  if (req.method === "POST") {
    const { contractNo, docKey, docUrl, docName, createdBy, recipientLabel, note } = req.body || {};
    if (!docUrl) return res.status(400).json({ error: "docUrl required" });

    const token    = genToken();
    const password = genPassword();
    // Short link for QR / SMS (password still required on arrival)
    const shareUrl = `${SHARE_BASE}/api/db/doc-share?token=${token}`;
    // One-click link that embeds the password — recipient clicks once, file downloads.
    // Use this for IM/email forwards where link + password in one place is OK.
    const quickUrl = `${SHARE_BASE}/api/db/doc-share?token=${token}&password=${encodeURIComponent(password)}`;

    await pool.query(`
      INSERT INTO doc_share_links
        (token, contract_no, doc_key, doc_url, doc_name, password,
         created_by, expires_at, max_downloads, download_count, downloaded_log)
      VALUES ($1,$2,$3,$4,$5,$6,$7, NOW()+INTERVAL '1 day', 1, 0,
        $8::jsonb)
    `, [
      token, contractNo || "", docKey || "", docUrl, docName || "",
      password, createdBy || "unknown",
      JSON.stringify([{ action: "created", by: createdBy || "unknown", label: recipientLabel || "", note: note || "", ts: new Date().toISOString() }]),
    ]);

    return res.json({
      ok: true,
      token,
      password,
      shareUrl,
      quickUrl,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      docName: docName || "",
    });
  }

  // ── GET: verify + serve ─────────────────────────────────────────────
  if (req.method === "GET") {
    const { token, password } = req.query;
    if (!token) return res.status(400).send("Missing token");

    const r = await pool.query("SELECT * FROM doc_share_links WHERE token=$1", [token]);
    if (!r.rows.length) return res.status(404).send("Link not found or expired");

    const link = r.rows[0];

    // Expiry check
    if (new Date() > new Date(link.expires_at)) {
      return res.status(410).send(page("Link Expired", "⏰", "This secure link has expired.", "#f59e0b"));
    }

    // Download limit check
    if (link.download_count >= link.max_downloads) {
      return res.status(410).send(page("Already Downloaded", "🔒", "This link has already been used. Each secure link allows only one download.", "#ef4444"));
    }

    // Password gate — show form if missing / wrong
    if (!password) {
      return res.status(200).send(passwordPage(token, link.doc_name || "Document", false));
    }
    if (password !== link.password) {
      return res.status(200).send(passwordPage(token, link.doc_name || "Document", true));
    }

    // ✅ Verified — log download and redirect
    const ip  = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
    const log = Array.isArray(link.downloaded_log) ? link.downloaded_log : [];
    log.push({ action: "downloaded", ip, ua: req.headers["user-agent"] || "", ts: new Date().toISOString() });

    await pool.query(
      "UPDATE doc_share_links SET download_count=download_count+1, downloaded_log=$1 WHERE token=$2",
      [JSON.stringify(log), token]
    );

    // If doc_url points to a local /uploads/ file, stream it directly (file is NOT
    // publicly served by nginx; password gate above is the only access control).
    try {
      var _p = "";
      try { _p = new URL(link.doc_url).pathname; } catch (e) { _p = String(link.doc_url || ""); }
      if (/^\/uploads\//.test(_p)) {
        var diskPath = "/opt/sanlyn-uploads" + _p.replace(/^\/uploads/, "");
        if (existsSync(diskPath)) {
          var ext = (diskPath.split(".").pop() || "").toLowerCase();
          var ct = ext === "pdf" ? "application/pdf"
                 : ext === "png" ? "image/png"
                 : /^jpe?g$/.test(ext) ? "image/jpeg"
                 : ext === "mp4" ? "video/mp4"
                 : "application/octet-stream";
          res.setHeader("Content-Type", ct);
          res.setHeader("Content-Disposition", 'inline; filename="' + (link.doc_name || "document") + "." + ext + '"');
          return createReadStream(diskPath).pipe(res);
        }
      }
    } catch (e) { /* fall through to redirect */ }

    // Redirect to actual file (external/public URLs)
    return res.redirect(302, link.doc_url);
  }

  return res.status(405).end();
}

// ── Minimal HTML pages ──────────────────────────────────────────────────
function page(title, icon, msg, color) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:system-ui;background:#060e1a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
  .box{text-align:center;padding:40px;background:#0f1629;border-radius:16px;border:1px solid rgba(255,255,255,0.08);max-width:360px;}
  .icon{font-size:48px;margin-bottom:16px;} .title{font-size:20px;font-weight:800;color:${color};margin-bottom:8px;}
  .msg{font-size:13px;color:#94a3b8;line-height:1.6;} .brand{margin-top:24px;font-size:11px;color:#334155;}
  </style></head><body><div class="box"><div class="icon">${icon}</div>
  <div class="title">${title}</div><div class="msg">${msg}</div>
  <div class="brand">⚡ Sanlyn OS · Secure Document Sharing</div></div></body></html>`;
}

function passwordPage(token, docName, wrong) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Secure Document Access</title>
  <style>*{box-sizing:border-box}body{font-family:system-ui;background:#060e1a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
  .box{padding:36px;background:#0f1629;border-radius:16px;border:1px solid rgba(56,189,248,0.2);max-width:380px;width:90%;}
  .logo{font-size:28px;text-align:center;margin-bottom:6px;} .title{font-size:18px;font-weight:800;text-align:center;color:#38bdf8;margin-bottom:4px;}
  .sub{font-size:11px;color:#475569;text-align:center;margin-bottom:24px;} .doc{font-size:13px;font-weight:600;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 14px;margin-bottom:18px;}
  label{font-size:11px;color:#64748b;display:block;margin-bottom:6px;} input{width:100%;padding:10px 14px;background:rgba(255,255,255,0.05);border:1px solid rgba(56,189,248,0.25);border-radius:10px;color:#e2e8f0;font-size:14px;font-family:monospace;letter-spacing:2px;outline:none;}
  .err{color:#f87171;font-size:12px;margin:8px 0 0;} button{width:100%;margin-top:16px;padding:12px;border-radius:10px;border:none;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-size:14px;font-weight:700;cursor:pointer;}
  .notice{font-size:10px;color:#334155;text-align:center;margin-top:16px;line-height:1.6;} .brand{font-size:10px;color:#1e293b;text-align:center;margin-top:12px;}
  </style></head><body>
  <div class="box">
    <div class="logo">🔐</div>
    <div class="title">Secure Document Access</div>
    <div class="sub">This document is password-protected. One download only.</div>
    <div class="doc">📄 ${docName}</div>
    <form method="GET" action="/api/db/doc-share">
      <input type="hidden" name="token" value="${token}">
      <label>Enter password provided by sender</label>
      <input type="text" name="password" placeholder="XXX-XXX-XXX" autofocus autocomplete="off">
      ${wrong ? '<div class="err">❌ Incorrect password. Please check with sender.</div>' : ""}
      <button type="submit">🔓 Access Document</button>
    </form>
    <div class="notice">⚠ This link can only be downloaded once.<br>Your access will be logged for security.</div>
    <div class="brand">⚡ Sanlyn OS · Secure Document Sharing</div>
  </div>
  </body></html>`;
}
