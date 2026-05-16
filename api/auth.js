// /api/auth.js — JWT token authentication module
// Provides: generateToken, verifyToken, extractUser, requireAuth, requireRole, authMiddleware
// Uses HS256 with built-in crypto (no external deps)
import crypto from "crypto";

var SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error("JWT_SECRET environment variable is required but not set");
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

// ── 完全公开路径（无需任何 token）──
const PUBLIC_PATHS = [
  "/",
  "/health",
  // "/api/db/accounts", // REMOVED 2026-04-22 P0 — no longer public; use /api/db/auth-login
  "/api/db/auth-login",   // 主应用登录接口
  "/api/db/test-fixture-login", // Dev-only fixture login (returns 404 in production)
  "/api/db/check-username", // 注册页查重（只返回 {exists:bool}，不泄露其他字段）
  "/api/portal/login",    // Portal 登录（portal token 在此签发，登录前无 token）
  "/api/driver-evidence", // 司机扫 QR 上传装柜证据（无登录；凭 bl_no+container_no 授权）
  "/api/db/magic-link",   // Driver Magic Link (Air-A): 司机点 SMS 链接，凭 raw token + SHA-256 比对授权
  "/api/factory-fill",    // 工厂 token 填单（无登录；凭 _idx_tokens 授权）
  "/api/pending-confirm", // 工厂确认交期（无登录；凭 _idx_tokens 授权，purpose=pending_confirm）
  "/api/track/verify",    // Public supply-chain tracking card — token validated inside handler
  "/api/track/confirm",   // Customer delivery confirmation — token validated inside handler
  "/api/track/sign",      // Customer e-signature — token validated inside handler
  "/api/track/message",   // Customer message to ops — token validated inside handler
  // Customer Magic Link (public validate/use — handler verifies token internally)
  "/api/db/customer-magic-link/validate",
  "/api/db/customer-magic-link/use",
  // Customer Invite: validate + activate are public (token is credential); generate requires admin JWT
  "/api/db/customer-invite/validate",
  "/api/db/customer-invite/activate",
  // Forwarder Booking Submit — token-authenticated, no JWT
  "/api/db/forwarder-booking-submit",
  // Customs Broker Magic Link — token-authenticated, no JWT
  "/api/db/customs-broker-checkin",
  // Sample Delivery Magic Link — factory manager, token-authenticated, no JWT
  "/api/db/sample-delivery-checkin",
  // 2026-05-16 audit one-off fix endpoint — nonce-gated inside handler.
  // Remove this entry in the follow-up commit that drops the handler file.
  "/api/admin/audit-fix-2026-05-16",
];

// Portal 路由独立 auth 体系（HMAC token）
// 不参与内部 JWT 校验；具体校验由 portalGate 中间件负责
// 注意：仅 /api/portal/login 在 PUBLIC_PATHS；其余 portal 路由在此前缀下直通，由 portalGate 拦截
const PORTAL_ROUTES_PREFIX = "/api/portal/";

// ── Stale-JWT enrichment ──
// Old JWTs may lack companyCode (e.g. issued before account row was backfilled).
// Look it up from accounts table and patch req.user. 60s TTL cache to avoid
// per-request DB hits.
var _enrichCache = new Map();
async function enrichStaleUser(req) {
  if (!req.user) return;
  if (req.user.companyCode || req.user.company_code) return;
  var uid = req.user.uid || req.user.id;
  if (!uid) return;
  var hit = _enrichCache.get(uid);
  if (hit && Date.now() - hit.ts < 60000) {
    if (hit.companyCode)  req.user.companyCode  = hit.companyCode;
    if (hit.companyCodes) req.user.companyCodes = hit.companyCodes;
    return;
  }
  try {
    var dbMod = await import("./db.js");
    var r = await dbMod.getPool().query(
      "SELECT company_code, company_codes FROM accounts WHERE id = $1 LIMIT 1",
      [uid]
    );
    var row = r.rows[0];
    if (row && row.company_code) {
      req.user.companyCode = row.company_code;
      if (row.company_codes && row.company_codes.length) req.user.companyCodes = row.company_codes;
      _enrichCache.set(uid, { ts: Date.now(), companyCode: row.company_code, companyCodes: row.company_codes });
    } else {
      _enrichCache.set(uid, { ts: Date.now() });
    }
  } catch (e) { /* swallow — endpoint will return graceful empty */ }
}

// ── Express 全局鉴权中间件 ──
// 职责：内部 JWT 校验。Portal 路径识别后直通（交由 portalGate）。
export async function authMiddleware(req, res, next) {
  if (req.method === "OPTIONS") return next();

  // Browser auto-requests: silence rather than 401
  if (req.path === "/favicon.ico" || req.path === "/robots.txt") {
    return res.status(204).end();
  }

  // 完全公开路径：无需任何 token
  if (PUBLIC_PATHS.includes(req.path)) return next();

  // 静态文件 /public/* 直通（driver-evidence.html / dispatch-paste.html 等）
  if (req.path.startsWith("/public/")) return next();

  // Factory short link /f/<token> → redirect to /public/factory-fill.html, no auth
  if (req.path.startsWith("/f/")) return next();

  // Doc share recipient download: GET /api/db/doc-share?token=...&password=...
  // External recipients have no JWT — handler verifies via token + password instead.
  // POST (link creation) still requires JWT (falls through to check below).
  if (req.method === "GET" && req.path === "/api/db/doc-share") return next();

  // Portal 路由体系：使用独立 HMAC token，由 portalGate 负责校验，跳过内部 JWT
  if (req.path.startsWith(PORTAL_ROUTES_PREFIX)) return next();

  // Cron endpoints: allow if x-cron-secret header matches env secret
  // (handler still validates; this just skips JWT requirement)
  const cronHeader = req.headers["x-cron-secret"];
  if (cronHeader && process.env.CRON_SECRET && cronHeader === process.env.CRON_SECRET) {
    req.user = { role: "system", sub: "cron", account: "cron" };
    return next();
  }

  // ── dev-only bypass for /api/minimax-chat ──
  // STRICT guards: must be (a) NOT in production, (b) MINIMAX_CHAT_DEV_BYPASS_AUTH=1,
  // (c) request path === /api/minimax-chat. Anything else falls through to normal auth.
  // Purpose: let Damon test the chat endpoint locally without spinning up the full
  // login + DB stack. NEVER set this flag in pm2 prod env.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.MINIMAX_CHAT_DEV_BYPASS_AUTH === "1" &&
    req.path === "/api/minimax-chat"
  ) {
    req.user = { role: "system", sub: "dev-bypass", account: "dev-local" };
    return next();
  }

  // 内部路由：必须持有有效内部 JWT
  extractUser(req);
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized", message: "请先登录" });
  }
  await enrichStaleUser(req);
  next();
}

export default authMiddleware;
