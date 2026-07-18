// ══════════════════════════════════════════════════════════
// server.js — Express adapter for Alibaba Cloud FC
// Wraps Vercel serverless handlers into Express routes
// Deploy: FC HTTP Trigger or standalone Node.js
export function registerCoreRoutes(app, mount) {
  mount("/api/db/auth-login",        () => import("./api/db/auth-login.js"));
  mount("/api/db/version",           () => import("./api/db/version.js")); // 版本自检:commit+部署时间 2026-07-07
  mount("/api/db/account-identities", () => import("./api/db/account-identities.js"));
  mount("/api/db/migrate-account-identities", () => import("./api/db/migrate-account-identities.js"));
  mount("/api/tasks-closure", () => import("./api/tasks-closure.js"));
  // Dev-only fixture login — endpoint self-guards (404 in production, 403 without ENABLE_TEST_AUTH=1)
  // TOOLCHAIN-TEST-ACCOUNT-FIXTURE-001
  mount("/api/db/test-fixture-login", () => import("./api/db/test-fixture-login.js"));
  mount("/api/db/admin",             () => import("./api/db/admin.js"));
  mount("/api/db/accounts",          () => import("./api/db/accounts.js"));
  mount("/api/db/share-link",        () => import("./api/db/share-link.js"));
  mount("/api/public/share-resolve",            () => import("./api/db/share-resolve.js"));
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
  mount("/api/db/customer-brand-routes", () => import("./api/db/customer-brand-routes.js")); // factory-self brand→customer auth (2026-05-19)
  mount("/api/db/partner-relationships", () => import("./api/db/partner-relationships.js")); // partner network listing (2026-05-19)
  mount("/api/db/customs",           () => import("./api/db/customs.js"));
  mount("/api/db/customs-summary",        () => import("./api/db/customs-summary.js")); // 分类报关汇总
  mount("/api/db/customs-consolidated",   () => import("./api/db/customs-consolidated.js")); // 多柜合并报关 (2026-05-22)
  mount("/api/db/customs-certify",        () => import("./api/db/customs-certify.mjs")); // 报关/开票品名权威认证
  mount("/api/db/customs-audit",          () => import("./api/db/customs-audit.mjs")); // 报关单核对件自动审核
  mount("/api/db/exchange-rates",         () => import("./api/db/exchange-rates.js")); // 汇率
  mount("/api/db/doc-render",             () => import("./api/db/doc-render.mjs")); // 厂检单/QC 按工厂模版生成(2026-06-07)
  mount("/api/db/stamps-list",            () => import("./api/db/stamps-list.mjs")); // 可选公章清单
  mount("/api/db/doc-result-ocr",         () => import("./api/db/doc-result-ocr.mjs")); // 已填报告OCR自动填值
  mount("/api/db/customs-draft",    () => import("./api/db/customs-draft.js"));   // 报关底稿生成
  mount("/api/db/doc-auth",          () => import("./api/db/doc-auth.js"));
  mount("/api/db/documents",         () => import("./api/db/documents.js"));
  mount("/api/db/document_files",     () => import("./api/db/document-files.js")); // 单证文件清单读端点(document_files SSOT) — table-check 缺单证检测 (2026-06-16)
  mount("/api/db/seller-profiles",   () => import("./api/db/seller-profiles.js")); // issuing company list for SELLER dropdown — internal only (BANK-ACCOUNT-PAYEE-MINIMAL-FIX-001)
  mount("/api/db/order-payee-account", () => import("./api/db/order-payee-account.js")); // order-scoped payee bank account (customer-safe)
  mount("/api/db/doc-uploads",       () => import("./api/db/doc-uploads.js"));
  mount("/api/db/doc-reminders",     () => import("./api/db/doc-reminders.js"));
  mount("/api/db/factory-submit",    () => import("./api/db/factory-submit.js"));
  mount("/api/db/factory-prefill",   () => import("./api/db/factory-prefill.js"));
  mount("/api/db/factory-token-create", () => import("./api/db/factory-token-create.js"));
  mount("/api/factory-confirm",         () => import("./api/factory-confirm.js"));
  mount("/api/db/factory-recent",       () => import("./api/db/factory-recent.js"));
  mount("/api/db/factory-ports",        () => import("./api/db/factory-ports.js")); // 工厂就近港口(export-docs起运港来源) 2026-07-09
  mount("/api/db/check-username",       () => import("./api/db/check-username.js"));
  mount("/api/internal/auth-check", () => import("./api/internal/auth-check.js"));
  mount("/api/internal/lookup", () => import("./api/internal/lookup.js"));
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
  mount("/api/db/finance-preview",          () => import("./api/db/finance-preview.js"));   // D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-IMPL-001
  mount("/api/db/finance-records",          () => import("./api/db/finance-records.js"));
  // Alias kept for legacy frontend callers (CustomerPCFinance + CustomerFinanceWorkbench)
  mount("/api/db/finance-receivables",      () => import("./api/db/finance-records.js"));
  // FINANCE-WORKSPACE-UI-IMPL-001: read-only freight AP bills (GET only, no writes)
  mount("/api/db/freight-supplier-bills",   () => import("./api/db/freight-supplier-bills.js"));
  mount("/api/db/inbound-collab",           () => import("./api/db/inbound-collab.js"));
  mount("/api/db/sku-recon",                () => import("./api/db/sku-recon.js"));
  mount("/api/db/stocktake",                () => import("./api/db/stocktake.js"));
  mount("/api/db/customer-collection",      () => import("./api/db/customer-collection.js"));
  mount("/api/db/sku-recon-import",         () => import("./api/db/sku-recon-import.js"));
  mount("/api/db/supplier-catalog",         () => import("./api/db/supplier-catalog.js"));
  mount("/api/db/supplier-import",          () => import("./api/db/supplier-import.js"));
  mount("/api/db/share-center",             () => import("./api/db/share-center.js"));
  mount("/api/db/bb-overview",              () => import("./api/db/bb-overview.js"));
  mount("/api/db/freight-invoice-b",        () => import("./api/db/freight-invoice-b.js"));
  mount("/api/db/freight-bill-intake",      () => import("./api/db/freight-bill-intake.js"));
  mount("/api/db/canonical-doc",            () => import("./api/db/canonical-doc.js"));
  mount("/api/db/order-intake-validate", () => import("./api/db/order-intake-validate.js"));
  mount("/api/db/freight-rate-adopt",      () => import("./api/db/freight-rate-adopt.js"));
  app.all("/api/db/billing-tab/*", async (req, res) => {
    try {
      const mod = await import("./api/db/billing-tab.js");
      await (mod.default || mod)(req, res);
    } catch (err) {
      console.error("[billing-tab] Error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  app.all("/api/db/bill-center/*", async (req, res) => {
    try {
      const mod = await import("./api/db/bill-center.js");
      await (mod.default || mod)(req, res);
    } catch (err) {
      console.error("[bill-center] Error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  mount("/api/db/bill-center",      () => import("./api/db/bill-center.js"));
  mount("/api/db/freight-cost-audit",   () => import("./api/db/freight-cost-audit.js")); // freight cost vs sale audit + set-par (2026-06-17)
  mount("/api/db/vendor-invoice-upload", () => import("./api/db/vendor-invoice-upload.js"));
  mount("/api/db/factory-portal", () => import("./api/db/factory-portal.js")); // 工厂协同门户·财务板块(短码+collab mt)
  mount("/api/db/invoice-collab-confirm", () => import("./api/db/invoice-collab-confirm.js")); // 港杂费开票确认(booking collab token)
  mount("/api/db/invoice-monthly-consolidate", () => import("./api/db/invoice-monthly-consolidate.js")); // 月结合并开票聚合(admin/finance JWT)
  mount("/api/db/customer-invoice", () => import("./api/db/customer-invoice.js")); // B3 客户销项发票门户(短码 /ci)
  mount("/api/db/rate-configs", () => import("./api/db/rate-configs.js")); // 税率/汇率配置编辑器+改动历史(admin only)
  mount("/api/db/migrate-rate-configs", () => import("./api/db/migrate-rate-configs.js"));
  mount("/api/db/factory-invoice-reconcile", () => import("./api/db/factory-invoice-reconcile.js")); // 工厂开票对账台
  mount("/api/db/supplier-bills-reconcile", () => import("./api/db/supplier-bills-reconcile.js")); // 应付货代对账台
  mount("/api/db/customer-ar-reconcile", () => import("./api/db/customer-ar-reconcile.js")); // 应收客户对账台
  mount("/api/db/customs-collab", () => import("./api/db/customs-collab.js")); // 报关单开票协同
  mount("/api/db/recon-shadow", () => import("./api/db/recon-shadow.js")); // 对账框架影子端点
  mount("/api/db/recon-persist", () => import("./api/db/recon-persist.js"));
  mount("/api/db/invoice-drafts", () => import("./api/db/invoice-drafts.js"));
  mount("/api/db/recon-board", () => import("./api/db/recon-board.js"));
  mount("/api/db/automation-hub", () => import("./api/db/automation-hub.js")); // 自动化观测台
  mount("/api/db/freight-rates",     () => import("./api/db/freight-rates.js"));
  mount("/api/db/orders",            () => import("./api/db/orders.js"));
  mount("/api/db/payments",          () => import("./api/db/payments.js"));
  mount("/api/db/finance_payments",  () => import("./api/db/finance_payments.js"));
  mount("/api/db/export-excel",      () => import("./api/db/export-excel.js"));
  mount("/api/db/export-pdf",        () => import("./api/db/export-pdf.js"));
  mount("/api/db/shipment-tracking",  () => import("./api/db/shipment-tracking.js"));
  mount("/api/db/shipment-completeness", () => import("./api/db/shipment-completeness.js")); // 2026-06-08 remount
  mount("/api/db/reconcile",             () => import("./api/db/reconcile.js"));             // 2026-06-08 remount
  mount("/api/db/urge",                  () => import("./api/db/urge.js"));
  mount("/api/db/field-registry",        () => import("./api/db/field-registry.js"));
  mount("/api/db/field-bindings",        () => import("./api/db/field-bindings.js"));
  mount("/api/db/field-catalog/resolve", () => import("./api/db/field-catalog-resolve.js"));
  mount("/api/db/field-catalog",         () => import("./api/db/field-catalog.js"));
  mount("/api/db/template-form",          () => import("./api/db/template-form.js"));
  mount("/api/db/field-layout",           () => import("./api/db/field-layout.js"));
  mount("/api/db/migrate-collab-fields", () => import("./api/db/migrate-collab-fields.js"));
  // customer-invite: self-service activation links for customer accounts — needs prefix match
  app.all("/api/db/customer-invite/*", async (req, res) => {
    try {
      const mod = await import("./api/db/customer-invite.js");
      await (mod.default || mod)(req, res);
    } catch (err) {
      console.error("[customer-invite] Error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  app.all("/api/db/customer-invite", async (req, res) => {
    try {
      const mod = await import("./api/db/customer-invite.js");
      await (mod.default || mod)(req, res);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  // customer-magic-link uses sub-paths (/generate, /validate, /use) — needs prefix match
  app.all("/api/db/customer-magic-link/*", async (req, res) => {
    try {
      const mod = await import("./api/db/customer-magic-link.js");
      const handler = mod.default || mod;
      // Set req.path to sub-path suffix (e.g. "generate", "validate", "use")
      await handler(req, res);
    } catch (err) {
      console.error("[customer-magic-link] Error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  app.all("/api/db/customer-magic-link", async (req, res) => {
    try {
      const mod = await import("./api/db/customer-magic-link.js");
      const handler = mod.default || mod;
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  mount("/api/db/migrate-magic-links",() => import("./api/db/migrate-magic-links.js"));
  // booking-collab uses sub-paths (/validate, /send-factory-link, etc.) — needs prefix match
  app.all("/api/db/booking-collab/*", async (req, res) => {
    try {
      const mod = await import("./api/db/booking-collab.js");
      const handler = mod.default || mod;
      await handler(req, res);
    } catch (err) {
      console.error("[booking-collab] Error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  mount("/api/db/booking-collab", () => import("./api/db/booking-collab.js"));
  mount("/api/db/forwarder-booking-submit", () => import("./api/db/forwarder-booking-submit.js"));
  mount("/api/db/shipping-plan-pdf",  () => import("./api/db/shipping-plan-pdf.js"));
  mount("/api/db/shipping-plan-doc-data", () => import("./api/db/shipping-plan-doc-data.js"));
  mount("/api/db/shipping-plan-create", () => import("./api/db/shipping-plan-create.js")); // SUPPLY-CHAIN-ORDER-INTAKE-001: was missing
  mount("/api/db/shipping-plan-rebook", () => import("./api/db/shipping-plan-rebook.js")); // 换航次原子操作: 旧航次进raw.booking_history+新航次写主表 2026-06-10
  mount("/api/db/shipping-transfer-gen", () => import("./api/db/shipping-transfer-gen.js")); // 内转外Excel自动生成
  mount("/api/db/shipping-transfer-data", () => import("./api/db/shipping-transfer-data.js")); // 内转外合并数据(可编辑模版用)
  mount("/api/db/customs-doc-pdf",    () => import("./api/db/customs-doc-pdf.js"));
  mount("/api/db/products",          () => import("./api/db/products.js"));
  // Product Master V1 — Factory Write-in (PATCH only; raw.factory_profile +
  // raw.aliases.factory). Permission in api/lib/product-scope.js.
  // Two mount paths so the endpoint works in both Express (server.js) and
  // Vercel (file-based routing maps the file to the flat path). Handler
  // resolves SKU from req.params.sku || req.query.sku || req.body.sku.
  mount("/api/db/products/:sku/factory-profile", () => import("./api/db/product-factory-profile.js"));
  mount("/api/db/product-factory-profile",       () => import("./api/db/product-factory-profile.js"));
  mount("/api/db/product-rebate",    () => import("./api/db/product-rebate.js")); // HS 退税率/增值税率 canonical 查询 + 批量补 rebate_rate (weight-volume-verify 依赖)
  mount("/api/db/company-brand-permissions", () => import("./api/db/company-brand-permissions.js"));
  mount("/api/db/factory-brands",    () => import("./api/db/factory-brands.js"));
  mount("/api/db/brand-applications",() => import("./api/db/brand-applications.js"));
  mount("/api/db/raw-patch",         () => import("./api/db/raw-patch.js"));
  mount("/api/db/shipping",          () => import("./api/db/shipping.js"));
  mount("/api/shipping/:id/insurance/prepare", () => import("./api/db/insurance.js"));
  mount("/api/insurance/:policyId/mark-filled", () => import("./api/db/insurance.js"));
  mount("/api/insurance/:policyId/mark-submitted", () => import("./api/db/insurance.js"));
  mount("/api/db/shipping-notify",   () => import("./api/db/shipping-notify.js")); // BL录入双轨通知
  mount("/api/db/vendor-quotes",     () => import("./api/db/vendor-quotes.js"));
  mount("/api/db/stamp-permissions", () => import("./api/db/stamp-permissions.js"));
  mount("/api/db/tenants",           () => import("./api/db/tenants.js"));
  mount("/api/db/upsert",            () => import("./api/db/upsert.js"));
  mount("/api/db/vault-read",        () => import("./api/db/vault-read.js"));
  mount("/api/db/diag-shipping",          () => import("./api/db/diag-shipping.js"));
  mount("/api/db/shipping-health-check", () => import("./api/db/shipping-health-check.js"));
  mount("/api/db/migrate-sp-audit",      () => import("./api/db/migrate-sp-audit.js")); // Phase 5: BL/ETA audit trail
  mount("/api/db/migrate-brand-nda",    () => import("./api/db/migrate-brand-nda.js")); // Phase 7: NDA exclusive brand redact
  mount("/api/db/migrate-upstream-type", () => import("./api/db/migrate-upstream-type.js")); // upstream_type: oem_factory/trade_factory/trading_co/intermediary
  mount("/api/db/migrate-factory-orders", () => import("./api/db/migrate-factory-orders.js")); // FPO tables: factory_orders + factory_order_events
  mount("/api/db/factory-orders",        () => import("./api/db/factory-orders.js"));           // FPO CRUD API
  mount("/api/db/fix-co-account",    () => import("./api/db/fix-co-account.js"));
  mount("/api/db/countries",         () => import("./api/db/countries.mjs"));
  mount("/api/db/migrate-countries",  () => import("./api/db/migrate-countries.mjs"));
  mount("/api/db/mailings", () => import("./api/db/mailings.mjs"));
   mount("/api/db/customs-fix-amount", () => import("./api/db/customs-fix-amount.mjs"));
  mount("/api/db/companies",          () => import("./api/db/companies.js"));
  mount("/api/db/trucking-vendors",  () => import("./api/db/trucking-vendors.js"));
  mount("/api/db/trucking-rates",     () => import("./api/db/trucking-rates.js"));
  mount("/api/db/customs-rates",      () => import("./api/db/customs-rates.js"));
  mount("/api/db/exchange-rate",      () => import("./api/db/exchange-rate.js"));
  mount("/api/db/local-charges",     () => import("./api/db/local-charges.js"));
  mount("/api/db/seed-huihe-charges",   () => import("./api/db/seed-huihe-charges.js"));
  mount("/api/db/seed-oss-local-charges",() => import("./api/db/seed-oss-local-charges.js"));
  mount("/api/db/fix-product-prices",() => import("./api/db/fix-product-prices.js"));
  mount("/api/db/customer-portal",  () => import("./api/db/customer-portal.js"));
  mount("/api/db/fix-groups",        () => import("./api/db/fix-groups.js"));
  mount("/api/db/migrate-products",             () => import("./api/db/migrate-products.js"));
  mount("/api/db/migrate-products-spec-source",        () => import("./api/db/migrate-products-spec-source.js")); // 002: provenance columns + backfill
  mount("/api/db/migrate-products-spec-source-repair",    () => import("./api/db/migrate-products-spec-source-repair.js")); // 002r: fix trade_show clobber bug
  mount("/api/db/migrate-products-carton-qty-backfill", () => import("./api/db/migrate-products-carton-qty-backfill.js")); // 003: factory-confirmed carton_qty + box dims
  mount("/api/db/migrate-products-spec-verified-fix",   () => import("./api/db/migrate-products-spec-verified-fix.js"));   // 003f: fix spec_verified=FALSE bug from migration 003
  mount("/api/db/migrate-products-cp-backfill",         () => import("./api/db/migrate-products-cp-backfill.js"));           // 004: CP-series 858 SKUs cbm/weight/carton_qty from 产品信息 xlsx
  mount("/api/db/migrate-products-tt-backfill",         () => import("./api/db/migrate-products-tt-backfill.js"));           // 005: TT-series 430 SKUs carton/price/image from 2025新品 xlsx
  mount("/api/db/migrate-products-size-infer",          () => import("./api/db/migrate-products-size-infer.js"));           // 006: SQL regex on size+product_name → infer carton_qty for ~270 unsourced rows
  mount("/api/db/migrate-orders",    () => import("./api/db/migrate-orders.js"));
  mount("/api/db/migrate-orders-v2", () => import("./api/db/migrate-orders-v2.js"));
  mount("/api/db/migrate-qc",        () => import("./api/db/migrate-qc.js"));
  mount("/api/db/migrate-factory-portal", () => import("./api/db/migrate-factory-portal.js"));
  mount("/api/db/migrate-order-mode", () => import("./api/db/migrate-order-mode.js")); // P1-1
  mount("/api/db/migrate-order-flow-v3", () => import("./api/db/migrate-order-flow-v3.js")); // v3
  mount("/api/db/migrate-tasks",      () => import("./api/db/migrate-tasks.js"));      // P1-2
  mount("/api/db/migrate-collab",     () => import("./api/db/migrate-collab.js"));     // P1-3
  mount("/api/db/migrate-tasks-factory-code", () => import("./api/db/migrate-tasks-factory-code.js")); // BUG-A
  mount("/api/db/migrate-sanlyn-brand", () => import("./api/db/migrate-sanlyn-brand.js")); // SANLYN white-label
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
  mount("/api/db/migrate-hh-bill-202604", () => import("./api/db/migrate-hh-bill-202604.js")); // ONE-SHOT: 天津惠禾 HH_202604ZXCK01868
  mount("/api/db/modules",           () => import("./api/db/modules.js"));
  mount("/api/db/qc-checks",         () => import("./api/db/qc-checks.js"));
  mount("/api/db/qc-notify",         () => import("./api/db/qc-notify.js"));
  mount("/api/db/loading-sheets",     () => import("./api/db/loading-sheets.js"));
  mount("/api/db/loading-collab-sheets", () => import("./api/db/loading-collab-sheets.js"));
  mount("/api/db/migrate-loading-sheets", () => import("./api/db/migrate-loading-sheets.js"));
  // ── Air-A · Collab Sheet Backend V2 ───────────────────────────────────
  mount("/api/db/migrate-collab-support",     () => import("./api/db/migrate-collab-support.js"));
  // ── Field Visibility Configurator (Air-A) ─────────────────────────────
  mount("/api/db/migrate-field-visibility",   () => import("./api/db/migrate-field-visibility.js"));
  mount("/api/db/field-visibility/bulk",      () => import("./api/db/field-visibility.js"));
  mount("/api/db/field-visibility",           () => import("./api/db/field-visibility.js"));
  mount("/api/db/customs-draft-sheets",       () => import("./api/db/customs-draft-sheets.js"));
  mount("/api/db/inspection-request-sheets",  () => import("./api/db/inspection-request-sheets.js"));
  mount("/api/db/inspection-status",          () => import("./api/db/inspection-status.js")); // 检疫状态查询
  mount("/api/db/inspection-ocr",             () => import("./api/db/inspection-ocr.js")); // 商检单/报检单 OCR (MiniMax-M3) 2026-07-05
  mount("/api/db/cert-application-sheets",    () => import("./api/db/cert-application-sheets.js"));
  mount("/api/db/trucking-pickup-sheets",     () => import("./api/db/trucking-pickup-sheets.js"));
  mount("/api/db/trucking-evidence-sheets",   () => import("./api/db/trucking-evidence-sheets.js"));
  mount("/api/db/doc-revision-sheets",        () => import("./api/db/doc-revision-sheets.js"));
  mount("/api/db/magic-link",                 () => import("./api/db/magic-link.js"));
  mount("/api/db/driver-assignments",         () => import("./api/db/driver-assignments.js"));
  mount("/api/db/driver-checkin",             () => import("./api/db/driver-checkin.js"));
  mount("/api/db/customs-broker-checkin",     () => import("./api/db/customs-broker-checkin.js"));
  mount("/api/db/customs-broker-assign",      () => import("./api/db/customs-broker-assign.js"));
  mount("/api/db/sample-delivery-checkin",   () => import("./api/db/sample-delivery-checkin.js"));
  mount("/api/db/migrate-sample-delivery",   () => import("./api/db/migrate-sample-delivery.js"));
  mount("/api/db/drivers",                    () => import("./api/db/drivers.js"));
  mount("/api/db/driver-reviews",             () => import("./api/db/driver-reviews.js"));
  mount("/api/db/shipment-collab",          () => import("./api/db/shipment-collab.js"));
  mount("/api/db/external-tokens",          () => import("./api/db/external-tokens.js"));
  mount("/api/db/collab-sheets/queue",        () => import("./api/db/collab-sheets-queue.js"));
  mount("/api/db/collab-sheets",             () => import("./api/db/collab-sheets.js"));
  mount("/api/db/collab-sheet-templates",    () => import("./api/db/collab-sheet-templates.js"));
  mount("/api/db/order-create-v2",   () => import("./api/db/order-create-v2.js"));
  mount("/api/db/order-line-items",   () => import("./api/db/order-line-items.js"));
  mount("/api/db/order-field-audit", () => import("./api/db/order-field-audit.js"));
  mount("/api/db/factory-invite",        () => import("./api/db/factory-invite.js"));        // v3 partner onboarding (6 types)
  mount("/api/db/factory-invite-list",   () => import("./api/db/factory-invite-list.js"));   // admin queue
  mount("/api/db/factory-invite-review",   () => import("./api/db/factory-invite-review.js")); // admin approve/reject
  mount("/api/db/factory-invite-complete", () => import("./api/db/factory-invite-complete.js")); // invitee final submit
  mount("/api/db/team-join",               () => import("./api/db/team-join.js")); // 2026-05-18 team invite accept (public, token-auth)
  mount("/api/db/order-confirm",           () => import("./api/db/order-confirm.js")); // 2026-05-18 factory→customer 2-stage confirm state machine
  mount("/api/db/marketplace",             () => import("./api/db/marketplace.js"));    // 2026-05-18 mount fix: handler existed but never wired → 404 in browser
  mount("/api/db/ai-cleaner",              () => import("./api/db/ai-cleaner.js"));              // MiniMax 脏活管家
  mount("/api/db/migrate-invite-review", () => import("./api/db/migrate-invite-review.js")); // schema migration
  
  // ── v2.0 主数据升级 (2026-04-29) ──
  mount("/api/db/migrate-customers-v2",  () => import("./api/db/migrate-customers-v2.js"));  // v2 customers schema
  mount("/api/db/migrate-company-certs",() => import("./api/db/migrate-company-certs.js")); // cert_type_config + company_certs
  mount("/api/db/cert-expiry-check",   () => import("./api/db/cert-expiry-check.js"));    // cron: cert expiry alert
  mount("/api/db/export-certs",        () => import("./api/db/export-certs.js"));          // per-shipment export certs (ciq/vet/phyto)
  mount("/api/db/cert-type-config",    () => import("./api/db/cert-type-config.js"));      // admin: manage cert types (legacy)
  mount("/api/db/credential-types",    () => import("./api/db/credential-types.js"));      // Stage 3 phase 1: canonical credential_types (read-only)
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
  mount("/api/db/landed-cost",         () => import("./api/db/landed-cost.js")); // 2026-05-18 My Landed Cost per-BL aggregator
  mount("/api/db/product-image-update", () => import("./api/db/product-image-update.js")); // product image upload
  // ── RFQ Marketplace ──────────────────────────────────────────
  mount("/api/db/migrate-rfq",   () => import("./api/db/migrate-rfq.js"));    // table migration
  mount("/api/db/rfq-requests",  () => import("./api/db/rfq-requests.js"));   // CRUD
  mount("/api/db/rfq-items",     () => import("./api/db/rfq-items.js"));      // forwarder quote lines
  mount("/api/public/freight-quote/:itemId", () => import("./api/public/freight-quote.js")); // 货代公开报价页(免登录,token=freight_rfq_items.id)
  mount("/api/public/forwarder-lanes/:code", () => import("./api/public/forwarder-v20.js")); // V20 货代公开多航线报价页
  mount("/api/public/forwarder-quote/:code", () => import("./api/public/forwarder-v20.js")); // V20 货代公开报价提交
  mount("/api/public/forwarder-services/:code", () => import("./api/public/forwarder-services.js")); // v3a 全链公开服务(拖车)列表
  mount("/api/public/forwarder-services/:code/quote", () => import("./api/public/forwarder-services.js")); // v3a 全链公开服务报价提交
  mount("/api/public/forwarder-shipments/:code", () => import("./api/public/forwarder-services.js")); // v3d 按票四服务全貌
  mount("/api/public/forwarder-collab-link/:code", () => import("./api/public/forwarder-collab-link.js")); // 门户「进入协同」按票签发supplier_portal链接(2026-07-17真接线)
  mount("/api/public/forwarder-grab/:code", () => import("./api/public/forwarder-services.js")); // 立即抢单两口价 grab_offers
  mount("/api/public/forwarder-history/:code", () => import("./api/public/forwarder-history.js")); // 货代门户历史业务(只读账单)
  mount("/api/public/forwarder-active/:code", () => import("./api/public/forwarder-active.js")); // 货代门户活跃业务(真实海运计划)
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
