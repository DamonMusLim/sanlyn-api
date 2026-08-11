// ══════════════════════════════════════════════════════════
// server.js — Express adapter for Alibaba Cloud FC
// Wraps Vercel serverless handlers into Express routes
// Deploy: FC HTTP Trigger or standalone Node.js
export function registerTailRoutes(app, mount) {
  mount("/api/db/packaging",             () => import("./api/db/packaging.js"));
  mount("/api/db/packaging-move",        () => import("./api/db/packaging-move.js"));
  mount("/api/db/packaging-logs",        () => import("./api/db/packaging-logs.js"));
  mount("/api/db/packaging-consume",  () => import("./api/db/packaging-consume.js"));
  mount("/api/db/factory-bags",          () => import("./api/db/factory-bags.js"));
  mount("/api/db/finished-goods",        () => import("./api/db/finished-goods.js"));
  mount("/api/db/finished-goods-move",   () => import("./api/db/finished-goods-move.js"));
  mount("/api/db/finished-goods-logs",   () => import("./api/db/finished-goods-logs.js"));
  mount("/api/db/daigou-promote",  () => import("./api/db/daigou-promote.js"));
  mount("/api/db/customs-ocr",  () => import("./api/db/customs-ocr.js"));
  mount("/api/db/customs-doc-upload", () => import("./api/db/customs-doc-upload.js"));
  mount("/api/db/rebate-doc-upload", () => import("./api/db/rebate-doc-upload.js"));
  mount("/api/db/po-contract", () => import("./api/db/po-contract.js"));
  mount("/kp",  () => import("./api/db/kp.js"));
  mount("/api/db/portal-short-code", () => import("./api/db/portal-short-code.js"));
  mount("/api/db/kp",  () => import("./api/db/kp.js"));
  mount("/api/db/invoice-portal",  () => import("./api/db/invoice-portal.js"));
  mount("/api/db/invoice-bind",  () => import("./api/db/invoice-bind.js"));
  mount("/api/db/migrate-packaging",     () => import("./api/db/migrate-packaging.js"));
  mount("/api/db/migrate-profit",        () => import("./api/db/migrate-profit.js"));
  mount("/api/db/migrate-local-charges", () => import("./api/db/migrate-local-charges.js"));
  mount("/api/db/forwarder-performance", () => import("./api/db/forwarder-performance.js"));
  mount("/api/db/forwarder-alert-rules", () => import("./api/db/forwarder-alert-rules.js"));
  mount("/api/db/migrate-forwarder-perf",() => import("./api/db/migrate-forwarder-perf.js"));
  // ── Payment reminder endpoints ──
  mount("/api/admin/trigger-payment-reminder", () => import("./api/admin/trigger-payment-reminder.js"));
  // ── Reconciliation / monthly statement ──
  mount("/api/db/reconciliation", () => import("./api/db/reconciliation.js"));
  mount("/api/db/recon-master", () => import("./api/db/recon-master.js"));
  mount("/api/db/tax-rebate-master", () => import("./api/db/tax-rebate-master.js"));
  mount("/api/db/petstore-todo",        () => import("./api/db/petstore-todo.js"));
  mount("/api/db/petstore-todo-export", () => import("./api/db/petstore-todo-export.js"));
  mount("/api/db/petstore-sync",        () => import("./api/db/petstore-sync.js"));
  mount("/api/db/recon-export", () => import("./api/db/recon-export.js"));
  mount("/api/db/recon-edit", () => import("./api/db/recon-edit.js")); // 对账主表行内编辑 2026-08-11
  mount("/api/db/recon-confirm", () => import("./api/db/recon-confirm.js")); // 对平状态 2026-08-12
  mount("/api/db/recon-companies", () => import("./api/db/recon-companies.js")); // 公司下拉 2026-08-12
  mount("/api/db/shipping-entry", () => import("./api/db/shipping-entry.js"));
  mount("/api/db/statement-portal-data", () => import("./api/db/statement-portal-data.js")); // 客户对账单门户public
  mount("/api/db/slip-upload", () => import("./api/db/slip-upload.js")); // 水单/入账通知上传+MiniMax OCR (补线,2026-07-08二次找回)
  mount("/api/db/slip-review", () => import("./api/db/slip-review.js")); // 水单OCR人工确认闸 2026-07-07
  mount("/api/db/ocean-doc-upload", () => import("./api/db/ocean-doc-upload.js")); // 海运单据通用上传+MiniMax分类 2026-07-08
  mount("/api/db/ocean-doc-review", () => import("./api/db/ocean-doc-review.js")); // 海运单据人工归属确认 2026-07-08
  mount("/api/db/slip-customer-search", () => import("./api/db/slip-customer-search.js")); // 客户自选票据(限定customer) 2026-07-08
  // tax-rebate 子路由: 进项票×报关单分配 N:M
  app.all("/api/db/tax-rebate/*", async (req, res) => {
    try {
      const mod = await import("./api/db/tax-rebate-links.js");
      await (mod.default || mod)(req, res);
    } catch (err) {
      console.error("[tax-rebate-links] Error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  mount("/api/db/tax-rebate", () => import("./api/db/tax-rebate.js"));  // 退税板块 P1
  mount("/api/db/ciq-no", () => import("./api/db/ciq-no.js"));  // 单一窗口报检申请号 per order
  mount("/api/db/eport-rebate", () => import("./api/db/eport-rebate.js"));
  mount("/api/db/tax-rebate-import", () => import("./api/db/tax-rebate-import.js"));
  mount("/api/db/employees",           () => import("./api/db/employees.js"));        // HR: 员工档案
  mount("/api/db/migrate-employees",   () => import("./api/db/migrate-employees.js"));  // HR migration
  mount("/api/db/payroll-sheets",      () => import("./api/db/payroll-sheets.js"));      // HR: 工资单
  mount("/api/db/migrate-payroll",     () => import("./api/db/migrate-payroll.js"));     // HR migration
  mount("/api/db/payroll-generate",    () => import("./api/db/payroll-generate.js"));   // HR: 工资单生成+Excel
  mount("/api/db/migrate-employees-v2",() => import("./api/db/migrate-employees-v2.js")); // HR: v2 migration
  mount("/api/db/fe-status", () => import("./api/db/fe-status.js"));
  mount("/api/db/verify-doc", () => import("./api/db/verify-doc.js"));
  mount("/api/db/mailings", () => import("./api/db/mailings.js"));  // 退税进项明细导入 P2
  
  // ── AI ops/summaries + notifications inbox ──
  mount("/api/db/migrate-ai-and-notifications", () => import("./api/db/migrate-ai-and-notifications.js"));
  mount("/api/db/ai-operations", () => import("./api/db/ai-operations.js"));
  mount("/api/db/ai-summaries",  () => import("./api/db/ai-summaries.js"));
  mount("/api/db/notifications", () => import("./api/db/notifications.js"));
  
  // ── SC Collab Phase 2 — quote requests / bids / collab cards ─────────────
  mount("/api/supply-chain/quote-requests", () => import("./api/supply-chain-quote-requests.js"));
  mount("/api/supply-chain/quote-bids",     () => import("./api/supply-chain-quote-bids.js"));
  mount("/api/collab/cards",                () => import("./api/supply-chain-collab-cards.js"));
  
  // ── Recurring / scheduled orders ─────────────────────────────────────────────
  mount("/api/db/recurring-orders",         () => import("./api/db/recurring-orders.js"));
  mount("/api/db/ocr-parse",               () => import("./api/db/ocr-parse.js"));
  
  // ── v3.2 §6 — order_events / order_tasks / containers ────────────────────
  mount("/api/db/migrate-order-events", () => import("./api/db/migrate-order-events.js"));
  mount("/api/db/migrate-order-tasks",  () => import("./api/db/migrate-order-tasks.js"));
  mount("/api/db/migrate-containers",   () => import("./api/db/migrate-containers.js"));
  mount("/api/db/order-events",  () => import("./api/db/order-events.js"));
  mount("/api/db/order-tasks",   () => import("./api/db/order-tasks.js"));
  mount("/api/db/containers",    () => import("./api/db/containers.js"));
  // ── Migration 025 — shipping schema ALTER TABLEs ──────────────────────────
  mount("/api/db/migrate-025-shipping-schema", () => import("./api/db/migrate-025-shipping-schema.js"));
  
   
  // ── SO Dispatch v5 ────────────────────────────────────────────────────────
  mount("/api/so/trigger",                  () => import("./api/so/trigger.js"));
  mount("/api/so/dispatch/*",                 () => import("./api/so/trigger.js"));
  mount("/api/so/loading-sheet",           () => import("./api/so/trigger.js"));
  mount("/api/so/trucking-confirm",        () => import("./api/so/trigger.js"));
  mount("/api/so/customs-acknowledge",     () => import("./api/so/trigger.js"));
  mount("/api/so/collab-share",           () => import("./api/so/collab-share.js"));
  mount("/api/so/collab-public/*",         () => import("./api/so/collab-share.js"));
  mount("/api/db/order-parties", () => import("./api/db/order-parties.js"));
  mount("/api/portal/dossier", () => import("./api/db/portal-dossier.js"));
  mount("/api/db/order-merge-groups", () => import("./api/db/order-merge-groups.js"));
  mount("/api/db/order-merge-groups/:id/dissolve", () => import("./api/db/order-merge-groups.js"));
  mount("/api/db/order-merge-groups/:id/remove-item", () => import("./api/db/order-merge-groups.js"));
}
