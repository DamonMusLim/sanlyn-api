export function registerApiTailRoutes(mount) {
  // ── /api/* top-level endpoints ──
  mount("/api/doc-convert-jdy", () => import("./api/doc-convert-jdy.js"));
  mount("/api/doc-convert",     () => import("./api/doc-convert.js"));
  mount("/api/doc-review",      () => import("./api/doc-review.js"));
  mount("/api/db/doc-share",    () => import("./api/db/doc-share.js"));
  mount("/api/freight-quotes",  () => import("./api/freight-quotes.js"))
  // [SECURITY-P0 A5] removed unauthenticated route — covered by api/db/freight-rates.js
  // mount("/api/freight-rates",   () => import("./api/freight-rates.js"));;
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
  mount("/api/db/email-templates", () => import("./api/db/email-templates.js")); // 邮件模版中心 CRUD
  mount("/api/db/email-senders", () => import("./api/db/email-senders.js")); // 发件公司主体
  mount("/api/db/email-message-log", () => import("./api/db/email-message-log.js")); // 邮件收发记录+统计
  mount("/api/db/notification-projects", () => import("./api/db/notification-projects.js")); // 通知项目中心
  mount("/api/notify/trigger", () => import("./api/notify-trigger.js")); // 统一通知触发
  mount("/api/notify/preview", () => import("./api/notify-preview.js")); // 通知预览(不发送)
  mount("/api/db/order-diary-notes", () => import("./api/db/order-diary-notes.js"));
  mount("/api/db/order-diary-notes/:id", () => import("./api/db/order-diary-notes.js"));
  mount("/api/internal/ar-followup", () => import("./api/internal/ar-followup.js"));
  mount("/api/orders/:id/timeline", () => import("./api/orders-timeline.js"));
  mount("/api/orders/:id/share-links", () => import("./api/orders-share-links.js"));
  mount("/api/public/order-timeline", () => import("./api/public-order-timeline.js"));
  mount("/api/notify/order-created", () => import("./api/notify/order-created.js"));
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
  mount("/api/db/ports",     () => import("./api/db/ports.js"));
  mount("/api/db/staff-daily-reports", () => import("./api/db/staff-daily-reports.mjs"));
  mount("/api/db/carriers", () => import("./api/db/carriers.js"));
  mount("/api/bl-ocr",      () => import("./api/bl-ocr.js"));
  mount("/api/minimax-chat",     () => import("./api/minimax-chat.js"));
  mount("/api/ocr-booking",     () => import("./api/ocr-booking.js")); // multipart bypass at line 77
}
