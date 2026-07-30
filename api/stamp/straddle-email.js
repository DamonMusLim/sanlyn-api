// api/stamp/straddle-email.js
// POST { stampedUrl, recipientEmail, documentName }
// Emails a link to an already-stamped PDF (the OSS URL is already public — this just notifies
// a recipient rather than re-uploading/attaching anything). Mirrors the SMTP pattern already
// used in api/db/urge.js (nodemailer, SMTP_HOST/PORT/USER/PASS/FROM env vars).
//
// Hardened per codex cross-review (2026-07-31):
// - requireAuth explicit (defense in depth — global authMiddleware already gates this route,
//   but every other stamp endpoint checks explicitly too, and `operator` must come from the
//   verified JWT, never the request body, or a caller could forge the "sent by" audit trail).
// - stampedUrl must correspond to a real stamp_log row, not just match a domain whitelist —
//   otherwise this is "email any file living under files.sanlynos.com to any address", which
//   is a bigger surface than "email a document I actually just stamped" if the OSS bucket ever
//   has other public content under that domain.
// - Host is parsed with `new URL()` and checked precisely, not with a regex loose enough to
//   accept lookalike hosts like sanlyn-files.evilaliyuncs.com.
// - recipientEmail/documentName are stripped of CR/LF and length-capped before going anywhere
//   near email headers (nodemailer already escapes headers, but never trust input by default).
import { getPool, setCors } from '../db.js';
import { requireAuth } from '../auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isTrustedStampHost(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.hostname === 'files.sanlynos.com') return true;
  return /^sanlyn-files\.[a-z0-9-]+\.aliyuncs\.com$/i.test(u.hostname);
}

function sanitizeHeaderValue(s, maxLen) {
  return String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
}

export default async function handler(req, res) {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireAuth(req, res)) return;

  try {
    const { stampedUrl, recipientEmail, documentName } = req.body || {};
    if (!stampedUrl) return res.status(400).json({ error: 'stampedUrl required' });
    if (!recipientEmail || !EMAIL_RE.test(String(recipientEmail))) {
      return res.status(400).json({ error: 'valid recipientEmail required' });
    }
    if (!isTrustedStampHost(stampedUrl)) {
      return res.status(400).json({ error: 'stampedUrl domain not recognized' });
    }

    const pool = getPool();
    const logRow = await pool.query(
      `SELECT id FROM stamp_log WHERE stamped_url = $1 ORDER BY stamped_at DESC LIMIT 1`,
      [stampedUrl]
    );
    if (!logRow.rows.length) {
      // Only ever email links that actually came out of our own stamping pipeline — not just
      // anything that happens to live under a trusted OSS domain.
      return res.status(403).json({ error: 'stampedUrl not found in stamp_log — refusing to email an unverified link' });
    }

    if (!process.env.SMTP_HOST) {
      return res.status(503).json({ error: 'email_not_configured', detail: 'SMTP_HOST not set on server' });
    }

    const operator = (req.user && (req.user.username || req.user.sub)) || 'unknown';
    const safeRecipient = sanitizeHeaderValue(recipientEmail, 254);
    const docLabel = sanitizeHeaderValue(documentName, 150) || 'Stamped document';

    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: safeRecipient,
      subject: `[Sanlyn] ${docLabel}`,
      text: [
        `Please find the stamped document below:`,
        '',
        stampedUrl,
        '',
        `Sent by ${operator} via Sanlyn OS`,
      ].join('\n'),
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Straddle email API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
