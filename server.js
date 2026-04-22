// ══════════════════════════════════════════════════════════
// server.js — Express adapter for Alibaba Cloud FC
// Wraps Vercel serverless handlers into Express routes
// Deploy: FC HTTP Trigger or standalone Node.js
import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { authMiddleware } from "./api/auth.js";
import { portalGate }    from "./api/portal/gate.js";
import rateLimit from "express-rate-limit";

const app = express();
// Nginx sits in front — trust 1 hop of X-Forwarded-For (needed for rate-limit client IP)
app.set("trust proxy", 1);

// ── Security: rate limit login endpoint ──────────────────────────────────────
// Max 10 attempts per IP per 15 minutes. Blocks brute-force attacks.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 10,                     // max 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait 15 minutes and try again." },
  skipSuccessfulRequests: true, // only count failed attempts
});
app.use("/api/db/auth-login", loginLimiter);

// Public factory-fill endpoint: max 30 requests / 5min / IP (covers GET/POST/lookup)
const factoryLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a few minutes." },
});
app.use("/api/factory-fill", factoryLimiter);
// ────────────────────────────────────────────────────────────────────────────
// ── CORS middleware (replace Vercel headers config) ──
const ALLOWED_ORIGINS = [
  "https://ai.sanlyn.cn",
  "https://ai.sanlynos.com",
  "https://sanlyn-os.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});
// ── Body parsing (for non-multipart routes) ──
app.use((req, res, next) => {
  // Skip body parsing for multipart endpoints (formidable handles it)
  if (req.path === "/api/oss-upload" || req.path === "/api/ocr-booking") return next();
  express.json({ limit: "10mb" })(req, res, (err) => {
    if (err) return next(err);
    express.urlencoded({ extended: true, limit: "10mb" })(req, res, next);
  });
});

// ── JWT 鉴权中间件 ──
app.use(authMiddleware);
// ── Portal 专用鉴权网关（/api/portal 路由组，Phase 3 Fix1）──
app.use("/api/portal", portalGate);


// ── Vercel handler adapter ──
// Vercel handlers expect (req, res) with req.query populated
// Express already does this, so we just need to call the handler
function mount(route, handlerModule) {
  app.all(route, async (req, res) => {
    try {
      const mod = await handlerModule();
      const handler = mod.default || mod;
      await handler(req, res);
    } catch (err) {
      console.error(`[${route}] Error:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });
}
// Route Registration — mirrors Vercel's file-based routing
// ── /api/db/* endpoints ──
mount("/api/db/auth-login",        () => import("./api/db/auth-login.js"));
mount("/api/db/admin",             () => import("./api/db/admin.js"));
mount("/api/db/accounts",          () => import("./api/db/accounts.js"));
mount("/api/db/analytics",         () => import("./api/db/analytics.js"));
mount("/api/db/audit-log",         () => import("./api/db/audit-log.js"));
mount("/api/db/bl-control",        () => import("./api/db/bl-control.js"));
mount("/api/db/container-bookings",      () => import("./api/db/container-bookings.js"));
mount("/api/db/container-bookings-parse",() => import("./api/db/container-bookings-parse.js"));
mount("/api/driver-evidence",            () => import("./api/driver-evidence.js"));
mount("/api/factory-fill",               () => import("./api/factory-fill.js"));
mount("/api/db/company",           () => import("./api/db/company.js"));
mount("/api/db/contracts",         () => import("./api/db/contracts.js"));
mount("/api/db/customers",         () => import("./api/db/customers.js"));
mount("/api/db/import-customers",  () => import("./api/db/import-customers.js"));
mount("/api/db/customer-stamps",   () => import("./api/db/customer-stamps.js"));
mount("/api/db/customs",           () => import("./api/db/customs.js"));
mount("/api/db/doc-auth",          () => import("./api/db/doc-auth.js"));
mount("/api/db/documents",         () => import("./api/db/documents.js"));
mount("/api/db/doc-uploads",       () => import("./api/db/doc-uploads.js"));
mount("/api/db/doc-reminders",     () => import("./api/db/doc-reminders.js"));
mount("/api/db/factory-submit",    () => import("./api/db/factory-submit.js"));
mount("/api/db/factory-prefill",   () => import("./api/db/factory-prefill.js"));
mount("/api/db/factory-token-create", () => import("./api/db/factory-token-create.js"));
mount("/api/db/factory-recent",       () => import("./api/db/factory-recent.js"));
mount("/api/db/check-username",       () => import("./api/db/check-username.js"));
mount("/api/db/export-refund-lookup", () => import("./api/db/export-refund-lookup.js"));
mount("/api/db/invoice-points",       () => import("./api/db/invoice-points.js"));
mount("/api/db/invoice-confirmation-scan", () => import("./api/db/invoice-confirmation-scan.js"));
mount("/api/db/factory-reviews",   () => import("./api/db/factory-reviews.js"));
mount("/api/db/seed-payment-defaults",  () => import("./api/db/seed-payment-defaults.js"));
mount("/api/db/recompute-credit-used",  () => import("./api/db/recompute-credit-used.js"));
mount("/api/db/credit-approvals",       () => import("./api/db/credit-approvals.js"));
mount("/api/db/forward-doc",       () => import("./api/db/forward-doc.js"));
mount("/api/db/finance-records",   () => import("./api/db/finance-records.js"));
mount("/api/db/freight-rates",     () => import("./api/db/freight-rates.js"));
mount("/api/db/orders",            () => import("./api/db/orders.js"));
mount("/api/db/payments",          () => import("./api/db/payments.js"));
mount("/api/db/finance_payments",  () => import("./api/db/finance_payments.js"));
mount("/api/db/products",          () => import("./api/db/products.js"));
mount("/api/db/raw-patch",         () => import("./api/db/raw-patch.js"));
mount("/api/db/shipping",          () => import("./api/db/shipping.js"));
mount("/api/db/vendor-quotes",     () => import("./api/db/vendor-quotes.js"));
mount("/api/db/stamp-permissions", () => import("./api/db/stamp-permissions.js"));
mount("/api/db/tenants",           () => import("./api/db/tenants.js"));
mount("/api/db/upsert",            () => import("./api/db/upsert.js"));
mount("/api/db/vault-read",        () => import("./api/db/vault-read.js"));
mount("/api/db/diag-shipping",     () => import("./api/db/diag-shipping.js"));
mount("/api/db/fix-co-account",    () => import("./api/db/fix-co-account.js"));
mount("/api/db/local-charges",     () => import("./api/db/local-charges.js"));
mount("/api/db/seed-huihe-charges",   () => import("./api/db/seed-huihe-charges.js"));
mount("/api/db/seed-oss-local-charges",() => import("./api/db/seed-oss-local-charges.js"));
mount("/api/db/fix-product-prices",() => import("./api/db/fix-product-prices.js"));
mount("/api/db/fix-groups",        () => import("./api/db/fix-groups.js"));
mount("/api/db/migrate-products",  () => import("./api/db/migrate-products.js"));
mount("/api/db/migrate-orders",    () => import("./api/db/migrate-orders.js"));
mount("/api/db/migrate-orders-v2", () => import("./api/db/migrate-orders-v2.js"));
mount("/api/db/migrate-qc",        () => import("./api/db/migrate-qc.js"));
mount("/api/db/migrate-factory-portal", () => import("./api/db/migrate-factory-portal.js"));
mount("/api/db/migrate-freight",   () => import("./api/db/migrate-freight.js"));
mount("/api/db/modules",           () => import("./api/db/modules.js"));
mount("/api/db/qc-checks",         () => import("./api/db/qc-checks.js"));
mount("/api/db/order-create-v2",   () => import("./api/db/order-create-v2.js"));
mount("/api/db/sync-products-oss", () => import("./api/db/sync-products-to-oss.js"));
// ── /api/jdy/* endpoints ──
mount("/api/jdy/customer-addresses",  () => import("./api/jdy/customer-addresses.js"));
mount("/api/jdy/customer-full-sync", () => import("./api/jdy/customer-full-sync.js"));
mount("/api/jdy/docs-sync",          () => import("./api/jdy/docs-sync.js"));
mount("/api/jdy/order-create",       () => import("./api/jdy/order-create.js"));
mount("/api/jdy/pi-sync",            () => import("./api/jdy/pi-sync.js"));
// ── /api/stamp/* ──
mount("/api/stamp/apply", () => import("./api/stamp/apply.js"));
mount("/api/stamp/smart-position", () => import("./api/stamp/smart-position.js"));
// ── /api/convert/* ──
mount("/api/convert/excel-to-pdf", () => import("./api/convert/excel-to-pdf.js"));
// ── /api/* top-level endpoints ──
mount("/api/doc-convert-jdy", () => import("./api/doc-convert-jdy.js"));
mount("/api/doc-convert",     () => import("./api/doc-convert.js"));
mount("/api/doc-review",      () => import("./api/doc-review.js"));
mount("/api/db/doc-share",    () => import("./api/db/doc-share.js"));
mount("/api/freight-quotes",  () => import("./api/freight-quotes.js"));
mount("/api/jdy-company-sync",() => import("./api/jdy-company-sync.js"));
mount("/api/jdy-company",     () => import("./api/jdy-company.js"));
mount("/api/jdy-customer-sync",() => import("./api/jdy-customer-sync.js"));
mount("/api/jdy-driver-update",() => import("./api/jdy-driver-update.js"));
mount("/api/jdy-freight-sync", () => import("./api/jdy-freight-sync.js"));
mount("/api/jdy-plans-sync",  () => import("./api/jdy-plans-sync.js"));
mount("/api/jdy-sync",        () => import("./api/jdy-sync.js"));
mount("/api/jdy-write",       () => import("./api/jdy-write.js"));
mount("/api/ocr-license",     () => import("./api/ocr-license.js"));
mount("/api/ocr-review",      () => import("./api/ocr-review.js"));
mount("/api/oss-upload",      () => import("./api/oss-upload.js"));
mount("/api/proxy-file",      () => import("./api/proxy-file.js"));
mount("/api/send-email",      () => import("./api/send-email.js"));
mount("/api/setup-finance",   () => import("./api/setup-finance.js"));
mount("/api/vessel-callback", () => import("./api/vessel-callback.js"));
mount("/api/vessel-map",      () => import("./api/vessel-map.js"));
mount("/api/vessel-subscribe",() => import("./api/vessel-subscribe.js"));
mount("/api/vessel-sync",     () => import("./api/vessel-sync.js"));
mount("/api/vessel-track",    () => import("./api/vessel-track.js"));
mount("/api/db/m3-missing",   () => import("./api/db/m3-missing.js"));
mount("/api/m3/run-merge",    () => import("./api/m3/run-merge.js"));
mount("/api/m3/scan-missing", () => import("./api/m3/scan-missing.js"));
// ── Portal 读接口（Phase 2 + Phase 3 登录）──────────────────
mount("/api/portal/login",     () => import("./api/portal/login.js"));
mount("/api/portal/shipping",  () => import("./api/portal/shipping.js"));
mount("/api/portal/documents", () => import("./api/portal/documents.js"));
mount("/api/portal/missing",   () => import("./api/portal/missing.js"));
// ── Static files (driver-evidence page) ──
import { join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use("/public", express.static(join(__dirname, "public")));
// Short link for factory fill: /f/<token> → static page
app.get("/f/:token", (req, res) => {
  res.redirect("/public/factory-fill.html?t=" + encodeURIComponent(req.params.token));
});
// ── Health check ──
app.get("/", (req, res) => res.json({ status: "ok", version: "S88", ts: new Date().toISOString() }));
app.get("/health", (req, res) => res.json({ status: "ok" }));
// ── Start server (for local/FC deployment) ──
const PORT = process.env.PORT || 9000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[sanlyn-api] listening on :${PORT}`);
});
export default app;
