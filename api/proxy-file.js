// proxy-file.js — server-side proxy for JDY / external file URLs
// Fixes CORS: frontend can't fetch files.jiandaoyun.com directly
// Usage: GET /api/proxy-file?url=https://files.jiandaoyun.com/...
// (2026-06-22) Use Node 18+ built-in global fetch; node-fetch dependency removed.
import { Readable } from "node:stream";

const ALLOWED_HOSTS = [
  "files.jiandaoyun.com",
  "jdy.mobi",
  "oss-cn-hangzhou.aliyuncs.com",
  "sanlyn-oss.oss-cn-hangzhou.aliyuncs.com",
];

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
    return res.status(200).end();
  }

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  let parsed;
  try { parsed = new URL(url); } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  // Whitelist check — only proxy trusted hosts
  if (!ALLOWED_HOSTS.some(h => parsed.hostname.endsWith(h))) {
    return res.status(403).json({ error: "Host not allowed: " + parsed.hostname });
  }

  try {
    const upstream = await fetch(url, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: { "User-Agent": "SanlynOS/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=3600");

    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    const cd = upstream.headers.get("content-disposition");
    res.setHeader("Content-Type", ct);
    if (cd) res.setHeader("Content-Disposition", cd);

    if (req.method === "HEAD") {
      return res.status(upstream.status).end();
    }

    res.status(upstream.status);
    // Built-in fetch returns a WHATWG ReadableStream (no Node .pipe); bridge it.
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    res.status(502).json({ error: "Proxy fetch failed: " + err.message });
  }
}
