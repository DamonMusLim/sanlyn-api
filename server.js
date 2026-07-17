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
import { registerCoreRoutes } from "./routes-core.js";
import { registerTailRoutes } from "./routes-tail.js";
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

// ── Templates list (manifest-driven) ───────────────────────────────────
{
  const { readFileSync, writeFileSync } = await import("fs");
  const { fileURLToPath: ftu } = await import("url");
  const { dirname: pd } = await import("path");
  const TPLDIR = pd(ftu(import.meta.url)) + "/public/templates";
  const MANIFEST = TPLDIR + "/manifest.json";

  function loadManifest() {
    try { return JSON.parse(readFileSync(MANIFEST, "utf8")).templates; }
    catch { return []; }
  }

  // Public — list
  app.get("/api/db/templates-list", (_q, rs) => {
    const files = loadManifest();
    rs.json({ success: true, files, total: files.length, generated: new Date().toISOString().slice(0,10) });
  });

  // Public — preview HTML
  app.get("/api/db/templates-list/preview", (req, res) => {
    const files = loadManifest();
    const f = files.find(t => t.name === req.query.file || t.code === req.query.file);
    if (!f) return res.status(404).json({ error: "not found" });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(readFileSync(TPLDIR + "/" + f.name, "utf8"));
  });

  // Auth-gated — edit label/cat/desc by code
  app.patch("/api/db/templates-list", (req, res) => {
    const { code, label, cat, desc } = req.body;
    if (!code) return res.status(400).json({ error: "code required" });
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const tpl = manifest.templates.find(t => t.code === code);
    if (!tpl) return res.status(404).json({ error: "not found" });
    if (label !== undefined) tpl.label = label;
    if (cat   !== undefined) tpl.cat   = cat;
    if (desc  !== undefined) tpl.desc  = desc;
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
    res.json({ success: true, template: tpl });
  });

  // Auth-gated — delete one or many by code
  app.delete("/api/db/templates-list", (req, res) => {
    const { codes } = req.body; // array of HT codes
    if (!Array.isArray(codes) || !codes.length) return res.status(400).json({ error: "codes required" });
    const files = loadManifest();
    const after = files.filter(t => !codes.includes(t.code));
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    manifest.templates = after;
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
    res.json({ success: true, deleted: files.length - after.length, remaining: after.length });
  });
}

// ── MCP Server (no JWT — uses x-mcp-key) ──
mount("/api/mcp", () => import("./api/mcp.js"));

// ── Task Ingest (no JWT — uses TASK_INGEST_SECRET, 供mini检测器写PG闭环任务) ──
mount("/api/tasks-ingest", () => import("./api/tasks-ingest.js"));
mount("/api/wecom-panel", () => import("./api/wecom-panel.js"));
mount("/api/wecom-suggest", () => import("./api/wecom-suggest.js"));
mount("/api/wecom-jssdk-sign", () => import("./api/wecom-jssdk-sign.js"));
mount("/api/wx-mini-login", () => import("./api/wx-mini-login.js"));
mount("/api/brief-notes", () => import("./api/brief-notes.js"));
mount("/kp", () => import("./api/db/kp.js"));

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
registerCoreRoutes(app, mount);
// ── Static files (driver-evidence page) ──
import { join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use("/public", express.static(join(__dirname, "public")));
app.use("/templates", express.static(join(__dirname, "public/templates")));
// Short link for factory fill: /f/<token> → static page
app.get("/f/:token", (req, res) => {
  res.redirect("/public/factory-fill.html?t=" + encodeURIComponent(req.params.token));
});
// Short link for factory order confirmation: /fc/<token> → confirm page
app.get("/fc/:token", (req, res) => {
  res.redirect("/public/factory-confirm.html?t=" + encodeURIComponent(req.params.token));
});
// B2: /fi/<code> -> 工厂红票门户(与 /ci 对称; 修复点🧾开票误开成订单确认页的 bug)
app.get("/fi/:token", (req, res) => {
  res.redirect("/public/factory-invoice.html?c=" + encodeURIComponent(req.params.token));
});
// B3: /ci/<code> -> 客户销项发票门户
app.get("/ci/:token", (req, res) => {
  res.redirect("/public/customer-invoice.html?c=" + encodeURIComponent(req.params.token));
});
registerTailRoutes(app, mount);
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

// ── Recurring order cron (08:00 daily) ───────────────────────────────────────
import("./jobs/recurring-order-cron.js")
  .then(({ scheduleRecurringOrders }) => scheduleRecurringOrders())
  .catch(e => console.error("[server] recurring-order-cron schedule failed:", e.message));

export default app;
