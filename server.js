// ══════════════════════════════════════════════════════════
// server.js — Express adapter for Alibaba Cloud FC
// Wraps Vercel serverless handlers into Express routes
// Deploy: FC HTTP Trigger or standalone Node.js
// ══════════════════════════════════════════════════════════
import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname } from "path";

const app = express();

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
  // Skip body parsing for oss-upload (formidable handles it)
  if (req.path === "/api/oss-upload") return next();
  next();
});
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

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

// ══════════════════════════════════════════════════════════
// Route Registration — mirrors Vercel's file-based routing
// ══════════════════════════════════════════════════════════

// ── /api/db/* endpoints ──
mount("/api/db/accounts",          () => import("./api/db/accounts.js"));
mount("/api/db/analytics",         () => import("./api/db/analytics.js"));
mount("/api/db/audit-log",         () => import("./api/db/audit-log.js"));
mount("/api/db/company",           () => import("./api/db/company.js"));
mount("/api/db/contracts",         () => import("./api/db/contracts.js"));
mount("/api/db/customers",         () => import("./api/db/customers.js"));
mount("/api/db/customs",           () => import("./api/db/customs.js"));
mount("/api/db/doc-auth",          () => import("./api/db/doc-auth.js"));
mount("/api/db/documents",         () => import("./api/db/documents.js"));
mount("/api/db/finance-records",   () => import("./api/db/finance-records.js"));
mount("/api/db/freight-rates",     () => import("./api/db/freight-rates.js"));
mount("/api/db/orders",            () => import("./api/db/orders.js"));
mount("/api/db/payments",          () => import("./api/db/payments.js"));
mount("/api/db/products",          () => import("./api/db/products.js"));
mount("/api/db/raw-patch",         () => import("./api/db/raw-patch.js"));
mount("/api/db/shipping",          () => import("./api/db/shipping.js"));
mount("/api/db/stamp-permissions", () => import("./api/db/stamp-permissions.js"));
mount("/api/db/tenants",           () => import("./api/db/tenants.js"));
mount("/api/db/upsert",            () => import("./api/db/upsert.js"));
mount("/api/db/vault-read",        () => import("./api/db/vault-read.js"));

// ── /api/jdy/* endpoints ──
mount("/api/jdy/customer-addresses", () => import("./api/jdy/customer-addresses.js"));
mount("/api/jdy/docs-sync",          () => import("./api/jdy/docs-sync.js"));
mount("/api/jdy/order-create",       () => import("./api/jdy/order-create.js"));
mount("/api/jdy/pi-sync",            () => import("./api/jdy/pi-sync.js"));

// ── /api/stamp/* ──
mount("/api/stamp/apply", () => import("./api/stamp/apply.js"));

// ── /api/convert/* ──
mount("/api/convert/excel-to-pdf", () => import("./api/convert/excel-to-pdf.js"));

// ── /api/* top-level endpoints ──
mount("/api/doc-convert-jdy", () => import("./api/doc-convert-jdy.js"));
mount("/api/doc-convert",     () => import("./api/doc-convert.js"));
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
mount("/api/send-email",      () => import("./api/send-email.js"));
mount("/api/setup-finance",   () => import("./api/setup-finance.js"));
mount("/api/vessel-callback", () => import("./api/vessel-callback.js"));
mount("/api/vessel-map",      () => import("./api/vessel-map.js"));
mount("/api/vessel-subscribe",() => import("./api/vessel-subscribe.js"));
mount("/api/vessel-sync",     () => import("./api/vessel-sync.js"));
mount("/api/vessel-track",    () => import("./api/vessel-track.js"));

// ── Static files (driver-evidence page) ──
import { join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use("/public", express.static(join(__dirname, "public")));

// ── Health check ──
app.get("/", (req, res) => res.json({ status: "ok", version: "S88", ts: new Date().toISOString() }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── Start server (for local/FC deployment) ──
const PORT = process.env.PORT || 9000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[sanlyn-api] listening on :${PORT}`);
});

export default app;
