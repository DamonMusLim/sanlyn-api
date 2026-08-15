import crypto from "crypto";
import fs from "fs";

const CLERK = "http://127.0.0.1:7432";
const ENV_FILE = "/opt/pet-ai-clerk/.env";
const CARD_ROLES = new Set(["manager", "boss"]);

function json(res, code, data) {
  return res.status(code).json(data);
}

function envVal(key) {
  if (process.env[key]) return process.env[key];
  try {
    const line = fs.readFileSync(ENV_FILE, "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : "";
  } catch {
    return "";
  }
}

function sign(payloadB64) {
  const secret = envVal("CLERK_SESSION_SECRET");
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url").slice(0, 32);
}

function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return null;
  const want = sign(b64);
  if (!want || sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const body = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (!body.exp || body.exp < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}

function adminToken() {
  return envVal("CLERK_ADMIN_TOKEN");
}

async function loadBatch(batchToken) {
  try {
    const r = await fetch(`${CLERK}/progress?token=${encodeURIComponent(batchToken)}`, {
      headers: { "X-Clerk-Admin": adminToken() },
      signal: AbortSignal.timeout(8000),
    });
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok || !data?.ok || !data.batch) return null;
    return data.batch;
  } catch {
    return null;
  }
}

export function requirePricingCardSession(req, res) {
  const token = String(req.headers["x-clerk-session"] || "");
  if (!token) {
    json(res, 401, { ok: false, error: "clerk_session_required" });
    return null;
  }
  const session = verifySession(token);
  if (!session) {
    json(res, 401, { ok: false, error: "clerk_session_invalid" });
    return null;
  }
  if (!CARD_ROLES.has(String(session.role || ""))) {
    json(res, 403, { ok: false, error: "clerk_forbidden" });
    return null;
  }
  return session;
}

export async function requirePricingCardBatchOwner(req, res, batchToken, session) {
  if (!batchToken) {
    json(res, 400, { ok: false, error: "batch_token_required" });
    return null;
  }
  const batch = await loadBatch(batchToken);
  const ownerRole = String(batch?.owner_role || "");
  if (!CARD_ROLES.has(ownerRole)) {
    json(res, 403, { ok: false, error: "pricing_batch_owner_required" });
    return null;
  }
  const sessionRole = String(session?.role || "");
  if (sessionRole !== "boss" && sessionRole !== ownerRole) {
    json(res, 403, { ok: false, error: "pricing_batch_owner_forbidden" });
    return null;
  }
  return batch;
}
