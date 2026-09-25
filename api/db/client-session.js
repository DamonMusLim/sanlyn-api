// /api/db/client-session.js - exchange client JWT for HttpOnly cookie.
import { verifyToken } from "../auth.js";
import { setCors } from "../db.js";

const COOKIE_NAME = "sanlyn_client";

function cookieValue(token) {
  return encodeURIComponent(token);
}

function sessionCookie(token, maxAge) {
  return `${COOKIE_NAME}=${cookieValue(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function bearerToken(req) {
  const header = String((req.headers && req.headers.authorization) || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function invalidToken(res) {
  return res.status(401).json({ ok: false, error: "invalid_token" });
}

export default async function handler(req, res) {
  setCors(req, res, "POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "DELETE" || (req.method === "POST" && req.body && req.body.action === "logout")) {
    res.setHeader("Set-Cookie", clearCookie());
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const token = bearerToken(req) || (req.body && typeof req.body.token === "string" ? req.body.token.trim() : "");
  const payload = verifyToken(token);
  const now = Math.floor(Date.now() / 1000);
  const exp = payload && Number(payload.exp);
  if (!payload || !Number.isFinite(exp) || exp <= now) return invalidToken(res);

  const maxAge = Math.max(0, Math.floor(exp - now));
  res.setHeader("Set-Cookie", sessionCookie(token, maxAge));
  return res.status(200).json({ ok: true });
}
