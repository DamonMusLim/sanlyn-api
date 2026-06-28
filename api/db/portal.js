// api/db/portal.js — S98: External Factory Portal API
//
// POST /api/db/portal          → Create portal link (with password) for a contract
// GET  /api/db/portal?token=X  → Get portal info (public, no auth needed)
// POST /api/db/portal?action=verify → Verify password, return contract + doc list
// POST /api/db/portal?action=upload → Upload document via portal
//
// DB table: portal_links
//   token (PK), contract_no, factory_name, password, created_by, created_at, expires_at, disabled

import { getPool, setCors } from "../db.js";

function _genToken() {
  // 8-char alphanumeric token
  var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var t = "";
  for (var i = 0; i < 8; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();

  try {
    // ══════ GET: public info (no password needed) ══════
    if (req.method === "GET") {
      var token = req.query.token;
      if (!token) return res.status(400).json({ success: false, error: "Missing token" });

      var r = await pool.query(
        "SELECT token, contract_no, factory_name, created_at, expires_at, disabled FROM portal_links WHERE token = $1 LIMIT 1",
        [token.toUpperCase()]
      );
      if (r.rowCount === 0) return res.status(404).json({ success: false, error: "Link not found" });

      var link = r.rows[0];
      if (link.disabled) return res.status(403).json({ success: false, error: "Link disabled" });
      if (link.expires_at && new Date(link.expires_at) < new Date()) {
        return res.status(403).json({ success: false, error: "Link expired" });
      }

      return res.status(200).json({
        success: true,
        portal: {
          token: link.token,
          contract_no: link.contract_no,
          factory_name: link.factory_name,
          created_at: link.created_at,
        },
      });
    }

    // ══════ POST ══════
    if (req.method === "POST") {
      var body = req.body || {};
      var action = req.query.action || body.action || "create";

      // ── action=verify: check password, return contract docs ──
      if (action === "verify") {
        var token = (body.token || "").toUpperCase();
        var password = body.password || "";
        if (!token || !password) return res.status(400).json({ success: false, error: "Missing token or password" });

        var r = await pool.query("SELECT * FROM portal_links WHERE token = $1 LIMIT 1", [token]);
        if (r.rowCount === 0) return res.status(404).json({ success: false, error: "Link not found" });

        var link = r.rows[0];
        if (link.disabled) return res.status(403).json({ success: false, error: "Link disabled" });
        if (link.expires_at && new Date(link.expires_at) < new Date()) {
          return res.status(403).json({ success: false, error: "Link expired" });
        }
        if (link.password !== password) {
          return res.status(401).json({ success: false, error: "Wrong password" });
        }

        // Fetch documents for this contract from OSS
        var docs = [];
        try {
          var ossRes = await fetch("https://files.sanlynos.com/data/documents.json");
          var ossRaw = await ossRes.json();
          var allDocs = Array.isArray(ossRaw) ? ossRaw : (ossRaw.documents || ossRaw.data || []);
          docs = allDocs.filter(function (d) { return d.contractNo === link.contract_no || d.orderNo === link.contract_no; });
        } catch (e) { /* ignore */ }

        // Fetch contract info
        var contractInfo = null;
        try {
          var cRes = await pool.query("SELECT * FROM contracts WHERE contract_no = $1 LIMIT 1", [link.contract_no]);
          if (cRes.rowCount > 0) contractInfo = cRes.rows[0];
        } catch (e) { /* ignore */ }

        return res.status(200).json({
          success: true,
          portal: {
            token: link.token,
            contract_no: link.contract_no,
            factory_name: link.factory_name,
          },
          contract: contractInfo,
          documents: docs,
        });
      }

      // ── action=upload: upload doc via portal ──
      if (action === "upload") {
        var token = (body.token || "").toUpperCase();
        var password = body.password || "";
        if (!token || !password) return res.status(400).json({ success: false, error: "Missing token or password" });

        // Verify first
        var r = await pool.query("SELECT * FROM portal_links WHERE token = $1 LIMIT 1", [token]);
        if (r.rowCount === 0) return res.status(404).json({ success: false, error: "Link not found" });
        var link = r.rows[0];
        if (link.disabled || (link.expires_at && new Date(link.expires_at) < new Date())) {
          return res.status(403).json({ success: false, error: "Link expired or disabled" });
        }
        if (link.password !== password) return res.status(401).json({ success: false, error: "Wrong password" });

        // Record the upload in audit log
        var docKey = body.docKey || "Other";
        var fileName = body.fileName || "";
        var fileUrl = body.fileUrl || "";
        var note = body.note || "";

        await pool.query(
          `INSERT INTO audit_log (_id, action, actor, target, detail, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            "PAL-" + Date.now().toString(36),
            "portal_upload",
            "portal:" + token,
            link.contract_no,
            JSON.stringify({ docKey: docKey, fileName: fileName, fileUrl: fileUrl, note: note, factory: link.factory_name }),
          ]
        );

        return res.status(200).json({ success: true, message: "Upload recorded" });
      }

      // ── action=create (default): generate new portal link ──
      var contract_no = body.contract_no || "";
      var factory_name = body.factory_name || "";
      var password = body.password || "";
      var created_by = body.created_by || "";
      var expires_days = parseInt(body.expires_days) || 90;

      if (!contract_no) return res.status(400).json({ success: false, error: "contract_no required" });
      if (!password) return res.status(400).json({ success: false, error: "password required" });

      // Check if link already exists for this contract
      var existing = await pool.query("SELECT token FROM portal_links WHERE contract_no = $1 AND disabled = false LIMIT 1", [contract_no]);
      if (existing.rowCount > 0) {
        // Update existing
        await pool.query(
          "UPDATE portal_links SET password = $1, factory_name = $2, expires_at = NOW() + interval '" + expires_days + " days', created_by = $3 WHERE token = $4",
          [password, factory_name, created_by, existing.rows[0].token]
        );
        return res.status(200).json({
          success: true,
          token: existing.rows[0].token,
          url: "https://ai.sanlynos.com/#portal/" + existing.rows[0].token,
          message: "Link updated",
        });
      }

      // Create new
      var token = _genToken();
      var expires_at = new Date(Date.now() + expires_days * 86400000).toISOString();

      await pool.query(
        `INSERT INTO portal_links (token, contract_no, factory_name, password, created_by, created_at, expires_at, disabled)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6, false)`,
        [token, contract_no, factory_name, password, created_by, expires_at]
      );

      return res.status(200).json({
        success: true,
        token: token,
        url: "https://ai.sanlynos.com/#portal/" + token,
        password: password,
        expires_at: expires_at,
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[portal] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
