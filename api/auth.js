// /api/auth.js — JWT token authentication module
// Provides: generateToken, verifyToken, extractUser, requireAuth, requireRole, authMiddleware
// Uses HS256 with built-in crypto (no external deps)
import crypto from "crypto";

var SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error("JWT_SECRET environment variable is required but not set");
var TOKEN_EXPIRY = 3650 * 24 * 60 * 60; // 10y ~ permanent (Damon 0731) // 7 days in seconds

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
  "/api/db/statement-portal-data",  // 客户对账单门户 public token
  "/",
  "/health",
  // "/api/db/accounts", // REMOVED 2026-04-22 P0 — no longer public; use /api/db/auth-login
  "/api/db/auth-login",   // 主应用登录接口
  "/api/db/test-fixture-login", // Dev-only fixture login (returns 404 in production)
  "/api/db/check-username", // 注册页查重（只返回 {exists:bool}，不泄露其他字段）
  "/api/portal/login",    // Portal 登录（portal token 在此签发，登录前无 token）
  "/api/driver-evidence", // 司机扫 QR 上传装柜证据（无登录；凭 bl_no+container_no 授权）
  "/api/db/slip-upload", // 客户/内部自助传水单/入账通知（无登录；凭 ?k=SLIP_UPLOAD_KEY 授权，handler内fail-closed）
  "/api/db/ocean-doc-upload", // 海运单据通用上传（无登录；凭 ?k=SLIP_UPLOAD_KEY 授权，handler内fail-closed）
  "/api/db/slip-customer-search", // 客户自选票据搜索（无登录；?k=授权+customer参数服务端强制过滤）
  "/api/db/magic-link",   // Driver Magic Link (Air-A): 司机点 SMS 链接，凭 raw token + SHA-256 比对授权
  "/api/factory-fill",    // 工厂 token 填单（无登录；凭 _idx_tokens 授权）
  "/api/factory-confirm", // 工厂订单确认（无登录；凭 _idx_tokens 授权）
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
  "/api/db/hr-staff-auth",   // 员工端登录(手机号+密码;接口内自己防爆破) [Claude 0730]
  "/api/db/hr-apply",   // 招聘自助投递(候选人无账号;接口内限流+字段截断+状态锁死new) [Claude 0728]
  "/api/db/forwarder-booking-submit",
  // Billing tab read-only lens — handler validates raw magic-link token itself
  "/api/db/billing-tab",
  "/api/db/billing-tab/shipment",
  "/api/db/billing-tab/company",
  // Customs Broker Magic Link — token-authenticated, no JWT
  "/api/db/customs-broker-checkin",
  // Sample Delivery Magic Link — factory manager, token-authenticated, no JWT
  "/api/db/sample-delivery-checkin",
  "/api/db/factory-portal", // 工厂门户:resolve/upload公开,gen内部校admin JWT
  "/api/db/invoice-collab-confirm", // 港杂费开票确认: magic-link token-gated
  "/api/db/portcharge-bill-pdf", // 港杂费账单明细PDF+盖章: 同 magic-link token 鉴权(token=凭证)
  "/api/db/customer-invoice", // 客户销项发票门户:resolve/save/confirm公开,gen内部校admin JWT
  "/api/db/factory-invoice-reconcile", // 工厂开票对账台:internal自校JWT,factory c/mt token-gated
  "/api/db/customs-collab", // 报关单开票协同:internal自校JWT,factory c/mt token-gated
  "/api/db/recon-shadow", // 对账框架影子: handler内admin自校
  // Team invite accept — public (token in URL is the credential, validated server-side)
  "/api/db/team-join",
  "/api/db/kp",
  "/api/db/invoice-portal",
  // Booking Collab Sheet — magic-link token-gated, no JWT（2026-06-22 恢复:被部署冲掉过,全站协同链接曾登录墙故障）
  "/api/db/booking-collab/validate",
  "/api/db/booking-collab/factory-submit",
  "/api/db/booking-collab/customer-submit",
  "/api/db/booking-collab/trucking-submit",
  "/api/db/booking-collab/broker-submit",
  "/api/db/booking-collab/update-bl-no",
  "/api/db/booking-collab/confirm-telex",
  "/api/db/booking-collab/confirm-payment",
  "/api/db/booking-collab/customer-notes",
  "/api/db/booking-collab/file",
  "/api/db/booking-collab/upload",
  "/api/db/booking-collab/sailings",
  "/api/db/booking-collab/collab-pricing",
  "/api/db/booking-collab/collab-order-pricing",
  "/api/db/booking-collab/collab-pricing-submit",
  "/api/db/booking-collab/collab-quote-submit",
  "/api/db/booking-collab/collab-ref-submit",
  "/api/db/booking-collab/collab-requirement-submit",
  "/api/db/booking-collab/cargo-payment",
  "/api/db/booking-collab/factory-invoice-code",
  "/api/db/booking-collab/cargo-payment-confirm",
  "/api/db/booking-collab/archive-retrieve-request",
  "/api/db/bill-center/collab/validate",
  "/api/db/bill-center/collab/submit",
  "/api/internal/ar-followup", // 微信文字回复记催款跟进状态；handler内X-Internal-Key强校验fail-closed，不发任何对外消息
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

// ── Account/session validity cache ──
// 灰度: 老 token 没有 tv 仍放行到自然过期；有 tv 才比对 token_version。
// DB 异常 fail-open，避免认证表短故障打死全站。
var _accountStateCache = new Map();
async function checkAccountState(req, res) {
  if (!req.user) return true;
  var uid = req.user.uid || req.user.id || req.user.sub;
  var username = req.user.username || "";
  if (!uid && !username) return true;
  var key = String(uid || username);
  var hit = _accountStateCache.get(key);
  var state = null;

  if (hit && Date.now() - hit.ts < 60000) {
    state = hit;
  } else {
    try {
      var dbMod = await import("./db.js");
      var r = await dbMod.getPool().query(
        `SELECT a.id,
                COALESCE(a.token_version, 1) AS token_version,
                COALESCE(a.is_active, true) AS is_active,
                BOOL_OR(e.status IS NOT NULL AND e.status <> 'ACTIVE') AS has_inactive_employee,
                ARRAY_AGG(e.status) FILTER (WHERE e.status IS NOT NULL AND e.status <> 'ACTIVE') AS inactive_statuses
           FROM accounts a
      LEFT JOIN employees e ON e.user_id::text = a.id::text
          WHERE a.id::text = $1::text OR a.username = $2
       GROUP BY a.id, a.token_version, a.is_active
          LIMIT 1`,
        [uid || "", username]
      );
      if (!r.rows[0]) {
        return res.status(401).json({ error: "ACCOUNT_NOT_FOUND", message: "账号不存在或已失效" });
      }
      var row = r.rows[0];
      state = {
        ts: Date.now(),
        account_id: row.id,
        tv: Number(row.token_version || 1),
        active: row.is_active !== false,
        emp_status: row.has_inactive_employee ? ((row.inactive_statuses || [])[0] || "INACTIVE") : "ACTIVE",
      };
      _accountStateCache.set(key, state);
      _accountStateCache.set(String(row.id), state);
    } catch (e) {
      console.warn("[authMiddleware] account state check fail-open:", e.message);
      return true;
    }
  }

  if (!state.active) {
    return res.status(401).json({ error: "ACCOUNT_INACTIVE", message: "账号已停用" });
  }
  if (state.emp_status && state.emp_status !== "ACTIVE") {
    return res.status(401).json({ error: "EMPLOYEE_INACTIVE", message: "员工状态已停用" });
  }
  if (Object.prototype.hasOwnProperty.call(req.user, "tv") && Number(req.user.tv) !== state.tv) {
    return res.status(401).json({ error: "TOKEN_REVOKED", message: "登录已失效，请重新登录" });
  }
  return true;
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

  // 自动化心跳上报:仅 POST + 正确 x-cron-secret 才免登录;GET 看板仍需登录
  // (2026-07-31: 之前被全局鉴权挡死,导致没有任何 job 能报心跳,美团/饿了么掉线 18 天没人看见)
  if (req.path === "/api/db/automation-hub" && req.method === "POST" &&
      (req.headers["x-cron-secret"] || "") ===
        (process.env.CRON_SECRET || "a931e0008d84d0e1a6f69129457dbe54")) {
    return next();
  }

  // 静态文件 /public/* 直通（driver-evidence.html / dispatch-paste.html 等）
  if (req.path.startsWith("/public/")) return next();

  // Public forwarder freight quote page — token = freight_rfq_items.id (UUID), 处理器自校验
  if (req.path.startsWith("/api/public/")) return next();

  // Factory short link /f/<token> → redirect to /public/factory-fill.html, no auth
  if (req.path.startsWith("/f/")) return next();

  // Factory confirm short link /fc/<token> → redirect to /public/factory-confirm.html, no auth
  if (req.path.startsWith("/fc/")) return next();

  // Factory invoice short link /fi/<code> → /public/factory-invoice.html, no auth
  if (req.path.startsWith("/fi/")) return next();

  // Customer invoice short link /ci/<code> → /public/customer-invoice.html, no auth
  if (req.path.startsWith("/ci/")) return next();

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
  if (!(await checkAccountState(req, res))) return;
  await enrichStaleUser(req);

  // ── 人事口白名单（0803 Damon：人事只有他一个人能进）──
  // 放在这里而不是各接口里：以后新加的 hr-* 自动被管住，没人能忘了加检查。
  // 前端藏菜单不算数 —— 藏起来的接口照样能用 curl 打。
  if (!hrGate(req, res)) return;

  next();
}

// 员工端那三个不是给后台管理员用的，必须放行：
//   hr-staff-auth   员工登录(公开)
//   hr-apply        应聘投递(公开)
//   hr-staff-portal 员工自己的工作台(role=staff 限权 token,压根没有 username)
const HR_STAFF_PATHS = new Set([
  "/api/db/hr-staff-auth", "/api/db/hr-apply", "/api/db/hr-staff-portal",
]);
// 想多给一个人开，改这个环境变量，不用改代码
const HR_ADMINS = (process.env.HR_ADMINS || "damon_sl,damon")
  .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

function hrGate(req, res) {
  const p = req.path || "";
  if (!p.startsWith("/api/db/hr-") && !p.startsWith("/api/hr/")) return true;
  if (HR_STAFF_PATHS.has(p)) return true;
  const who = String(req.user?.username || req.user?.account || req.user?.sub || "").toLowerCase();
  if (HR_ADMINS.includes(who)) return true;
  res.status(403).json({ error: "Forbidden", message: "人事数据只有老板本人能看" });
  return false;
}

export default authMiddleware;
