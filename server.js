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
app.use("/api/pending-confirm", factoryLimiter);

// B2-2A: factory-portal endpoints rate-limit (notifications / upload-history).
// Factory portal polls notifications every 30s → allow ≥ 120 req / 5min / IP headroom,
// but cap abusive clients. 240 req / 5min / IP is safe for a factory with 3–4 open tabs.
const factoryPortalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many factory-portal requests. Please wait a few minutes." },
});
app.use("/api/factory-portal/notifications", factoryPortalLimiter);
app.use("/api/factory-portal/upload-history", factoryPortalLimiter);
// ────────────────────────────────────────────────────────────────────────────
// ── CORS middleware (replace Vercel headers config) ──
const ALLOWED_ORIGINS = [
  "https://ai.sanlyn.cn",
  "https://ai.sanlynos.com",
  "https://sanlyn-os.vercel.app",
  "https://dashboard.sanlyn.cn",
  "http://localhost:5173",
  "http://localhost:5188",
  "http://localhost:3000",
  "http://localhost:3099",
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
mount("/api/pending-confirm",            () => import("./api/pending-confirm.js"));
mount("/api/db/pending-token-create",    () => import("./api/db/pending-token-create.js"));
mount("/api/db/company",           () => import("./api/db/company.js"));
mount("/api/db/contracts",         () => import("./api/db/contracts.js"));
mount("/api/db/customers",         () => import("./api/db/customers.js"));
mount("/api/db/import-customers",  () => import("./api/db/import-customers.js"));
mount("/api/db/customer-stamps",   () => import("./api/db/customer-stamps.js"));
mount("/api/db/customs",           () => import("./api/db/customs.js"));
mount("/api/db/customs-summary",   () => import("./api/db/customs-summary.js")); // 分类报关汇总
mount("/api/db/customs-draft",    () => import("./api/db/customs-draft.js"));   // 报关底稿生成
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
mount("/api/db/orders-recompute-all",  () => import("./api/db/orders-recompute.js"));
mount("/api/db/orders-recompute",      () => import("./api/db/orders-recompute.js"));
mount("/api/db/credit-approvals",       () => import("./api/db/credit-approvals.js"));
mount("/api/db/forward-doc",       () => import("./api/db/forward-doc.js"));
mount("/api/db/finance-records",       () => import("./api/db/finance-records.js"));
// Alias kept for legacy frontend callers (CustomerPCFinance + CustomerFinanceWorkbench)
mount("/api/db/finance-receivables",   () => import("./api/db/finance-records.js"));
mount("/api/db/freight-rates",     () => import("./api/db/freight-rates.js"));
mount("/api/db/orders",            () => import("./api/db/orders.js"));
mount("/api/db/payments",          () => import("./api/db/payments.js"));
mount("/api/db/finance_payments",  () => import("./api/db/finance_payments.js"));
mount("/api/db/export-excel",      () => import("./api/db/export-excel.js"));
mount("/api/db/products",          () => import("./api/db/products.js"));
mount("/api/db/raw-patch",         () => import("./api/db/raw-patch.js"));
mount("/api/db/shipping",          () => import("./api/db/shipping.js"));
mount("/api/db/shipping-notify",   () => import("./api/db/shipping-notify.js")); // BL录入双轨通知
mount("/api/db/vendor-quotes",     () => import("./api/db/vendor-quotes.js"));
mount("/api/db/stamp-permissions", () => import("./api/db/stamp-permissions.js"));
mount("/api/db/tenants",           () => import("./api/db/tenants.js"));
mount("/api/db/upsert",            () => import("./api/db/upsert.js"));
mount("/api/db/vault-read",        () => import("./api/db/vault-read.js"));
mount("/api/db/diag-shipping",     () => import("./api/db/diag-shipping.js"));
mount("/api/db/fix-co-account",    () => import("./api/db/fix-co-account.js"));
mount("/api/db/countries",         () => import("./api/db/countries.mjs"));
mount("/api/db/migrate-countries",  () => import("./api/db/migrate-countries.mjs"));
mount("/api/db/companies",          () => import("./api/db/companies.js"));
mount("/api/db/trucking-rates",     () => import("./api/db/trucking-rates.js"));
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
mount("/api/db/migrate-order-mode", () => import("./api/db/migrate-order-mode.js")); // P1-1
mount("/api/db/migrate-order-flow-v3", () => import("./api/db/migrate-order-flow-v3.js")); // v3
mount("/api/db/migrate-tasks",      () => import("./api/db/migrate-tasks.js"));      // P1-2
mount("/api/db/migrate-collab",     () => import("./api/db/migrate-collab.js"));     // P1-3
mount("/api/db/migrate-tasks-factory-code", () => import("./api/db/migrate-tasks-factory-code.js")); // BUG-A
// ── v2 Network Layer (blueprint v2) ───────────────────────────
mount("/api/db/migrate-v2-network",     () => import("./api/db/migrate-v2-network.js"));     // v2 schema
mount("/api/db/relationships",          () => import("./api/db/relationships.js"));          // graph edges
mount("/api/db/company-capabilities",   () => import("./api/db/company-capabilities.js"));   // what each company can do
mount("/api/db/thread-events",          () => import("./api/db/thread-events.js"));          // unified timeline
// ── Payment Terms (factory proposes, admin approves) ──────────
mount("/api/db/migrate-payment-terms",  () => import("./api/db/migrate-payment-terms.js"));
mount("/api/db/payment-terms",          () => import("./api/db/payment-terms.js"));
mount("/api/db/seed-payment-term-tasks",() => import("./api/db/seed-payment-term-tasks.js"));
mount("/api/factory-portal/tasks",  () => import("./api/factory-portal-tasks.js"));  // P1-2 list
mount("/api/factory-portal/notifications",      () => import("./api/factory-portal-notifications.js"));      // B2-1 list
mount("/api/factory-portal/notifications/:id",  () => import("./api/factory-portal-notifications.js"));      // B2-1 patch
mount("/api/factory-portal/upload-history",     () => import("./api/factory-portal-upload-history.js"));     // B2-1 list
mount("/api/db/migrate-factory-notifications",  () => import("./api/db/migrate-factory-notifications.js")); // B2-2A migration
mount("/api/tasks",                 () => import("./api/tasks.js"));                 // P1-2 detail + P1-4 action
mount("/api/tasks/create",          () => import("./api/tasks-create.js"));          // P2-B admin manual create
mount("/api/collab",                () => import("./api/collab.js"));                // P1-3
mount("/api/db/migrate-freight",   () => import("./api/db/migrate-freight.js"));
mount("/api/db/modules",           () => import("./api/db/modules.js"));
mount("/api/db/qc-checks",         () => import("./api/db/qc-checks.js"));
mount("/api/db/qc-notify",         () => import("./api/db/qc-notify.js"));
mount("/api/db/loading-sheets",     () => import("./api/db/loading-sheets.js"));
mount("/api/db/migrate-loading-sheets", () => import("./api/db/migrate-loading-sheets.js"));
// ── Air-A · Collab Sheet Backend V2 ───────────────────────────────────
mount("/api/db/migrate-collab-support",     () => import("./api/db/migrate-collab-support.js"));
// ── Field Visibility Configurator (Air-A) ─────────────────────────────
mount("/api/db/migrate-field-visibility",   () => import("./api/db/migrate-field-visibility.js"));
mount("/api/db/field-visibility/bulk",      () => import("./api/db/field-visibility.js"));
mount("/api/db/field-visibility",           () => import("./api/db/field-visibility.js"));
mount("/api/db/customs-draft-sheets",       () => import("./api/db/customs-draft-sheets.js"));
mount("/api/db/inspection-request-sheets",  () => import("./api/db/inspection-request-sheets.js"));
mount("/api/db/cert-application-sheets",    () => import("./api/db/cert-application-sheets.js"));
mount("/api/db/trucking-pickup-sheets",     () => import("./api/db/trucking-pickup-sheets.js"));
mount("/api/db/trucking-evidence-sheets",   () => import("./api/db/trucking-evidence-sheets.js"));
mount("/api/db/doc-revision-sheets",        () => import("./api/db/doc-revision-sheets.js"));
mount("/api/db/magic-link",                 () => import("./api/db/magic-link.js"));
mount("/api/db/driver-assignments",         () => import("./api/db/driver-assignments.js"));
mount("/api/db/drivers",                    () => import("./api/db/drivers.js"));
mount("/api/db/driver-reviews",             () => import("./api/db/driver-reviews.js"));
mount("/api/db/collab-sheets/queue",        () => import("./api/db/collab-sheets-queue.js"));
mount("/api/db/collab-sheets",             () => import("./api/db/collab-sheets.js"));
mount("/api/db/collab-sheet-templates",    () => import("./api/db/collab-sheet-templates.js"));
mount("/api/db/order-create-v2",   () => import("./api/db/order-create-v2.js"));
mount("/api/db/factory-invite",        () => import("./api/db/factory-invite.js"));        // v3 partner onboarding (6 types)
mount("/api/db/factory-invite-list",   () => import("./api/db/factory-invite-list.js"));   // admin queue
mount("/api/db/factory-invite-review",   () => import("./api/db/factory-invite-review.js")); // admin approve/reject
mount("/api/db/factory-invite-complete", () => import("./api/db/factory-invite-complete.js")); // invitee final submit
mount("/api/db/ai-cleaner",              () => import("./api/db/ai-cleaner.js"));              // MiniMax 脏活管家
mount("/api/db/migrate-invite-review", () => import("./api/db/migrate-invite-review.js")); // schema migration

// ── v2.0 主数据升级 (2026-04-29) ──
mount("/api/db/migrate-customers-v2",  () => import("./api/db/migrate-customers-v2.js"));  // v2 customers schema
mount("/api/db/migrate-company-certs",() => import("./api/db/migrate-company-certs.js")); // cert_type_config + company_certs
mount("/api/db/cert-expiry-check",   () => import("./api/db/cert-expiry-check.js"));    // cron: cert expiry alert
mount("/api/db/export-certs",        () => import("./api/db/export-certs.js"));          // per-shipment export certs (ciq/vet/phyto)
mount("/api/db/cert-type-config",    () => import("./api/db/cert-type-config.js"));      // admin: manage cert types
mount("/api/db/company-certs",       () => import("./api/db/company-certs.js"));          // factory/seller: own cert docs
mount("/api/db/migrate-audit-logs",   () => import("./api/db/migrate-audit-logs.js"));   // audit_logs v2 columns
mount("/api/db/kyc-upload",           () => import("./api/db/kyc-upload.js"));           // KYC doc upload
mount("/api/db/kyc-ocr",              () => import("./api/db/kyc-ocr.js"));              // KYC OCR (4-country)
mount("/api/db/kyc-review",           () => import("./api/db/kyc-review.js"));           // admin KYC approval
mount("/api/db/change-password",      () => import("./api/db/change-password.js"));      // self-service pwd change
mount("/api/db/accounts-team",        () => import("./api/db/accounts-team.js"));        // team invite/manage
mount("/api/db/company-departments",  () => import("./api/db/company-departments.js")); // group / dept management
mount("/api/db/seed-zc-group",        () => import("./api/db/seed-zc-group.js"));       // one-time: ZC group seed
mount("/api/db/fix-wp-brands",        () => import("./api/db/fix-wp-brands.js"));       // one-time: fix WP order brand tags
mount("/api/db/orders-status",     () => import("./api/db/orders-status.js"));    // v3 state machine
mount("/api/db/products-v3",       () => import("./api/db/products-v3.js"));      // v3 role-filtered
mount("/api/db/products-stats",    () => import("./api/db/products-stats.js"));   // v3 KPI stats
mount("/api/db/sync-products-oss", () => import("./api/db/sync-products-to-oss.js"));
// ── Credit Notes ──────────────────────────────────────────────
mount("/api/db/credit-notes",          () => import("./api/db/credit-notes.js"));          // CRUD + status update
mount("/api/db/migrate-credit-notes",  () => import("./api/db/migrate-credit-notes.js"));  // table migration
// ── Freight Debit Notes (洋宝宝出单) ──────────────────────────
mount("/api/freight-debit-notes",          () => import("./api/freight-debit-notes.js"));          // GET/POST/PATCH
mount("/api/db/migrate-freight-debit-notes", () => import("./api/db/migrate-freight-debit-notes.js")); // table migration
mount("/api/db/product-image-update", () => import("./api/db/product-image-update.js")); // product image upload
// ── RFQ Marketplace ──────────────────────────────────────────
mount("/api/db/migrate-rfq",   () => import("./api/db/migrate-rfq.js"));    // table migration
mount("/api/db/rfq-requests",  () => import("./api/db/rfq-requests.js"));   // CRUD
mount("/api/db/rfq-items",     () => import("./api/db/rfq-items.js"));      // forwarder quote lines
mount("/api/db/etd-delay-notify", () => import("./api/db/etd-delay-notify.js")); // ETD delay WeCom notify
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
mount("/api/freight-quotes",  () => import("./api/freight-quotes.js"))
mount("/api/freight-rates",   () => import("./api/freight-rates.js"));;
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
// ── Supply-chain tracking card (public, token-authenticated) ──
mount("/api/track/verify",  () => import("./api/track/verify.js"));
mount("/api/track/confirm", () => import("./api/track/confirm.js"));
mount("/api/track/sign",    () => import("./api/track/sign.js"));
mount("/api/track/message", () => import("./api/track/message.js"));
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
mount("/api/portal/orders",    () => import("./api/portal/orders.js"));    // Stage C1

// MiniMax chat completion proxy for Task Workspace V1.5 (read-only).
// Hard contract: keys stay in process.env.MINIMAX_API_KEY; rate-limited
// 30s/task+role; daily cap 100; max_tokens hard 800; prompt 4000 chars.
mount("/api/minimax-chat",     () => import("./api/minimax-chat.js"));
// ── Static files (driver-evidence page) ──
import { join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use("/public", express.static(join(__dirname, "public")));
// Short link for factory fill: /f/<token> → static page
app.get("/f/:token", (req, res) => {
  res.redirect("/public/factory-fill.html?t=" + encodeURIComponent(req.params.token));
});
mount("/api/db/packaging",             () => import("./api/db/packaging.js"));
mount("/api/db/packaging-move",        () => import("./api/db/packaging-move.js"));
mount("/api/db/packaging-logs",        () => import("./api/db/packaging-logs.js"));
mount("/api/db/migrate-packaging",     () => import("./api/db/migrate-packaging.js"));
mount("/api/db/migrate-profit",        () => import("./api/db/migrate-profit.js"));
mount("/api/db/migrate-local-charges", () => import("./api/db/migrate-local-charges.js"));
mount("/api/db/forwarder-performance", () => import("./api/db/forwarder-performance.js"));
mount("/api/db/forwarder-alert-rules", () => import("./api/db/forwarder-alert-rules.js"));
mount("/api/db/migrate-forwarder-perf",() => import("./api/db/migrate-forwarder-perf.js"));
// ── Payment reminder endpoints ──
mount("/api/admin/trigger-payment-reminder", () => import("./api/admin/trigger-payment-reminder.js"));

// ── Health check ──
app.get("/", (req, res) => res.json({ status: "ok", version: "S88", ts: new Date().toISOString() }));
app.get("/health", (req, res) => res.json({ status: "ok" }));
// ── Start server (for local/FC deployment) ──
const PORT = process.env.PORT || 9000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[sanlyn-api] listening on :${PORT}`);
});

// ── Payment reminder cron (09:00 daily) ──────────────────────────────────────
import("./jobs/payment-reminder.js")
  .then(({ schedulePaymentReminder }) => schedulePaymentReminder())
  .catch(e => console.error("[server] payment-reminder schedule failed:", e.message));

export default app;
