// /api/auth.js — JWT token authentication module
// Provides: generateToken, verifyToken, authMiddleware
// Uses HS256 with built-in crypto (no external deps)
import crypto from "crypto";

var SECRET = process.env.JWT_SECRET || "sanlyn-os-2026-secret-key";
var TOKEN_EXPIRY = 7 * 24 * 60 * 60; // 7 days in seconds

// ── Base64url encode/decode ──
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

// ── Generate JWT ──
export function generateToken(payload) {
  var header = { alg: "HS256", typ: "JWT" };
  var now = Math.floor(Date.now() / 1000);
  var body = Object.assign({}, payload, { iat: now, exp: now + TOKEN_EXPIRY });

  var segments = [b64url(JSON.stringify(header)), b64url(JSON.stringify(body))];
  var sig = crypto.createHmac("sha256", SECRET).update(segments.join(".")).digest();
  segments.push(b64url(sig));
  return segments.join(".");
}

// ── Verify JWT → returns payload or null ──
export function verifyToken(token) {
  try {
    if (!token) return null;
    var parts = token.split(".");
    if (parts.length !== 3) return null;

    // Verify signature
    var sig = crypto.createHmac("sha256", SECRET).update(parts[0] + "." + parts[1]).digest();
    var expectedSig = b64url(sig);
    if (expectedSig !== parts[2]) return null;

    // Decode payload
    var payload = JSON.parse(b64urlDecode(parts[1]).toString());

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch (e) {
    return null;
  }
}

// ── Express/Vercel middleware: extracts user from token ──
// Sets req.user if valid token, otherwise req.user = null
// Does NOT block — use requireAuth() to block unauthorized requests
export function extractUser(req) {
  var auth = req.headers.authorization || "";
  var token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query?.token || null);
  req.user = verifyToken(token);
  return req.user;
}

// ── Strict auth check — returns error response if no valid token ──
export function requireAuth(req, res) {
  extractUser(req);
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized", message: "请先登录" });
    return false;
  }
  return true;
}

// ── Role check ──
export function requireRole(req, res, roles) {
  if (!requireAuth(req, res)) return false;
  if (!roles.includes(req.user.role)) {
    res.status(403).json({ error: "Forbidden", message: "权限不足" });
    return false;
  }
  return true;
}
