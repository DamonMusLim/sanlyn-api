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
  mount("/api/db/orders-master-grid",   () => import("./api/db/orders-master-grid.js"));   // 0812 订单密网格
  mount("/api/db/shipping-master-grid", () => import("./api/db/shipping-master-grid.js")); // 0812 海运密网格
  mount("/api/db/ops-alerts", () => import("./api/db/ops-alerts.js")); // 0825 操作预警：未接入节点不反推假数
  mount("/api/db/ops-todos", () => import("./api/db/ops-todos.js")); // 0825 操作待办/审核：operation_todos 真源
  mount("/api/db/audit-review", () => import("./api/db/audit-review.js")); // 0826 审核管理专项：只读真实接入状态
  mount("/api/db/fee-alerts", () => import("./api/db/fee-alerts.js")); // 0825 费用预警：未接入/无法判断不反推假数
  mount("/api/db/fee-templates", () => import("./api/db/fee-templates.js")); // 0826 费用模板：只读真实费率来源
  mount("/api/db/invoice-records", () => import("./api/db/invoice-records.js")); // 0826 开票记录:只读进销项发票真源
  mount("/api/db/receipt-payment-management", () => import("./api/db/receipt-payment-management.js")); // 0826 收付管理:只读finance_payments真源
  mount("/api/db/settlement-management", () => import("./api/db/settlement-management.js")); // 0826 核销管理:只读finance_settlement_links真源
  mount("/api/db/commission-management", () => import("./api/db/commission-management.js")); // 0827 提成管理:无提成规则表则返回no_data
  mount("/api/db/commission-report", () => import("./api/db/commission-report.js")); // 0826 提成管理:只读真实回款+费率字段
  mount("/api/db/business-report", () => import("./api/db/business-report.js")); // 0826 业务报表:只读真实字段覆盖率
  mount("/api/db/financial-report", () => import("./api/db/financial-report.js")); // 0826 财务报表:只读真实财务字段覆盖率
  mount("/api/db/consolidated-fee-details", () => import("./api/db/consolidated-fee-details.js")); // 0826 集运费用明细：只读货代账单真源
  mount("/api/db/hgj-2025-bill-import", () => import("./api/db/hgj-2025-bill-import.js")); // 0906 海管家2025账单导入hy预检:只读
  mount("/api/db/hgj-template-195", () => import("./api/db/hgj-template-195.js")); // 0911 海管家195模板:占位符映射+通用渲染器只读
  mount("/api/db/biz-alerts", () => import("./api/db/biz-alerts.js")); // 0825 业务预警：额度/合同未设置不反推假数
  mount("/api/db/order-services", () => import("./api/db/order-services.js")); // 0826 服务项目12项: explicit + derived read lens
  mount("/api/db/order-staff-slots", () => import("./api/db/order-staff-slots.js")); // 0826 订单8个人员角色槽: 对接ai_staff花名册
  mount("/api/db/booking-platform", () => import("./api/db/booking-platform.js")); // 0826 订舱平台:只读真实字段覆盖率
  mount("/api/db/bl-management", () => import("./api/db/bl-management.js")); // 0826 提单管理:只读真实字段覆盖率
  mount("/api/db/transport-directions", () => import("./api/db/transport-directions.js")); // 0826 六方向运输:只读shipping_plans方向字段覆盖率
  mount("/api/db/order-draft-entry", () => import("./api/db/order-draft-entry.js")); // 0826 订单录入:先建草稿后补全
  mount("/api/db/quick-entry", () => import("./api/db/quick-entry.js")); // 0827 通用快速录入:字段id/canonical_key驱动
  mount("/api/db/field-engine", () => import("./api/db/field-engine.js")); // 0828 通用表格字段定义:只读
  mount("/api/db/hy-grid", () => import("./api/db/hy-grid.js")); // 0828 通用表格数据:字段定义驱动只读
  mount("/api/db/hy-modules", () => import("./api/db/hy-modules.js")); // 0828 海管家通用表模块目录:字段定义白名单
  mount("/api/db/global-search", () => import("./api/db/global-search.js")); // 0825 顶栏全局搜索：只读白名单表
  mount("/api/db/custom-nav", () => import("./api/db/custom-nav.js")); // 0826 工作台自定义导航:复用system_settings配置真源
  mount("/api/db/rates-hub",              () => import("./api/db/rates-hub.js")); // 0825 价表总台(海运周价/官方港杂/本地费)
  mount("/api/db/online-customs", () => import("./api/db/online-customs.js")); // 0826 在线报关:只读接入状态,不对外发送
  mount("/api/db/manifest-fields", () => import("./api/db/manifest-fields.js")); // 0906 舱单字段补齐:只读真实字段覆盖率
  mount("/api/db/manifest-message-channel", () => import("./api/db/manifest-message-channel.js")); // 0826 报文生成+校验+落地待发:不对外发送
  mount("/api/db/manifest-send", () => import("./api/db/manifest-send.js")); // 0826 上海舱单发送:申报通道只读接入状态
  mount("/api/db/tianjin-dalian-manifest-send", () => import("./api/db/tianjin-dalian-manifest-send.js")); // 0826 天津/大连舱单:只读接入状态,不对外发送
  mount("/api/db/shenzhen-nansha-manifest-send", () => import("./api/db/shenzhen-nansha-manifest-send.js")); // 0826 深圳/南沙舱单发送:只读接入状态,不对外发送
  mount("/api/db/qingdao-manifest-send", () => import("./api/db/qingdao-manifest-send.js")); // 0826 青岛舱单发送:只读接入状态,不对外发送
  mount("/api/db/xiamen-manifest-send", () => import("./api/db/xiamen-manifest-send.js")); // 0826 厦门舱单发送:只读接入状态,不对外发送
  mount("/api/db/ics2-send", () => import("./api/db/ics2-send.js")); // 0826 ICS2(欧线):只读接入状态,不对外发送
  mount("/api/db/cargo-info", () => import("./api/db/cargo-info.js")); // 0826 箱货信息:只读真实字段覆盖率
  mount("/api/db/warehouse-info", () => import("./api/db/warehouse-info.js")); // 0826 仓储信息:只读仓库/库存字段覆盖率
  mount("/api/db/em-aci-send", () => import("./api/db/em-aci-send.js")); // 0826 EM&ACI发送(加拿大线):只读接入状态,不对外发送
  mount("/api/db/ams-send", () => import("./api/db/ams-send.js")); // 0826 AMS发送(美线):只读接入状态,不对外发送
  mount("/api/db/afr-send", () => import("./api/db/afr-send.js")); // 0826 AFR发送(日本线):只读接入状态,不对外发送
  mount("/api/db/isf-send", () => import("./api/db/isf-send.js")); // 0826 ISF发送(美线):只读接入状态,不对外发送
  mount("/api/db/vgm-send", () => import("./api/db/vgm-send.js")); // 0826 VGM发送:只读接入状态,不对外发送
  mount("/api/db/container-watch", () => import("./api/db/container-watch.js")); // 0826 盯箱宝:只读真实船踪/ETA预警
  mount("/api/db/cargo-insurance", () => import("./api/db/cargo-insurance.js")); // 0826 货运保险:只读真实保单字段覆盖率
  mount("/api/db/spot-ecommerce", () => import("./api/db/spot-ecommerce.js")); // 0826 SPOT电商:只读商品/线上价字段覆盖率
  mount("/api/db/single-ticket-quote", () => import("./api/db/single-ticket-quote.js")); // 0826 单票报价:只读真实字段
  mount("/api/db/customs-master-grid",  () => import("./api/db/customs-master-grid.js"));  // 0812 报关密网格
  mount("/api/db/tax-rebate-master", () => import("./api/db/tax-rebate-master.js"));
  mount("/api/db/petstore-todo",        () => import("./api/db/petstore-todo.js"));
  mount("/api/db/petstore-todo-export", () => import("./api/db/petstore-todo-export.js"));
  mount("/api/db/petstore-sync",        () => import("./api/db/petstore-sync.js"));
  mount("/api/db/petstore-product-detail", () => import("./api/db/petstore-product-detail.js"));
  mount("/api/db/petstore-supervision", () => import("./api/db/petstore-supervision.js"));
  mount("/api/db/petstore-product-note",   () => import("./api/db/petstore-product-note.js"));
  mount("/api/db/petstore-intents",        () => import("./api/db/petstore-intents.js"));
  mount("/api/db/petstore-locks",          () => import("./api/db/petstore-locks.js"));
  mount("/api/db/petstore-make-batch",     () => import("./api/db/petstore-make-batch.js"));
  mount("/api/db/petstore-batch",          () => import("./api/db/petstore-batch.js"));
  mount("/api/db/petstore-pricing",        () => import("./api/db/petstore-pricing.js")); // 定价经营台(0814)
  mount("/api/db/petstore-pricing-decide", () => import("./api/db/petstore-pricing-decide.mjs")); // 改价拍板·老板终审(0816)
  mount("/api/db/petstore-decision-gate",  () => import("./api/db/petstore-decision-gate.js")); // 拍板提交闸 M083(0817):277条压成4组,D组必须逐条确认
  mount("/api/db/petstore-ops-row",        () => import("./api/db/petstore-ops-row.js")); // 商品经营行统一契约(0815)
  mount("/api/db/petstore-products-grid", () => import("./api/db/petstore-products-grid.js")); // 商品库主数据密网格(0815)
  mount("/api/db/petstore-stock-query", () => import("./api/db/petstore-stock-query.js")); // mini橙库存查询
  mount("/api/db/petstore-stock-changes", () => import("./api/db/petstore-stock-changes.js")); // mini橙库存变化
  mount("/api/db/petstore-stock-alerts", () => import("./api/db/petstore-stock-alerts.js")); // mini橙库存预警
  mount("/api/db/petstore-perm-users", () => import("./api/db/petstore-perm-users.js")); // mini橙权限:子账号列表
  mount("/api/db/petstore-perm-roles", () => import("./api/db/petstore-perm-roles.js")); // mini橙权限:角色列表
  mount("/api/db/petstore-perm-save", () => import("./api/db/petstore-perm-save.js")); // mini橙权限:唯一写入口
  mount("/api/db/petstore-goods-list", () => import("./api/db/petstore-goods-list.js")); // mini橙商品主线:商品库
  mount("/api/db/petstore-goods-detail", () => import("./api/db/petstore-goods-detail.js")); // mini橙商品主线:商品详情
  mount("/api/db/petstore-goods-expiry", () => import("./api/db/petstore-goods-expiry.js")); // mini橙商品主线:保质期
  mount("/api/db/petstore-goods-shelf", () => import("./api/db/petstore-goods-shelf.js")); // mini橙商品主线:货位
  mount("/api/db/petstore-sales-ranking", () => import("./api/db/petstore-sales-ranking.js")); // mini橙销量分析:商品动销排行
  mount("/api/db/petstore-sales-dead", () => import("./api/db/petstore-sales-dead.js")); // mini橙销量分析:无动销商品
  mount("/api/db/petstore-restock", () => import("./api/db/petstore-restock.js")); // mini橙销量分析:智能补货
  mount("/api/db/petstore-price-log", () => import("./api/db/petstore-price-log.js")); // mini橙价格:调价监控/改价日志
  mount("/api/db/petstore-market-compare", () => import("./api/db/petstore-market-compare.js")); // mini橙竞品:智能比价
  mount("/api/db/petstore-pet-archive", () => import("./api/db/petstore-pet-archive.js")); // 宠物档案(它大夫schema,91条真数据)
  mount("/api/db/recon-export", () => import("./api/db/recon-export.js"));
  mount("/api/db/recon-edit", () => import("./api/db/recon-edit.js")); // 对账主表行内编辑 2026-08-11
  mount("/api/db/recon-confirm", () => import("./api/db/recon-confirm.js")); // 对平状态 2026-08-12
  mount("/api/db/recon-companies", () => import("./api/db/recon-companies.js")); // 公司下拉 2026-08-12
  mount("/api/db/field-lookup", () => import("./api/db/field-lookup.js"));
  mount("/api/db/invoice-bill-match", () => import("./api/db/invoice-bill-match.js")); // 补挂已存在的发票-账单匹配 handler，避免带 token 仍 404。
  mount("/api/db/freight-invoice-confirm", () => import("./api/db/freight-invoice-confirm.js")); // 补挂已存在的货代发票确认 handler，避免确认写入管道断线。
  mount("/api/db/knowledge", () => import("./api/db/knowledge.js"));
  mount("/api/db/customs-intake", () => import("./api/db/customs-intake.js")); // 录单执行器V1 2026-08-12
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
  mount("/api/public/container-types", () => import("./api/public/container-types.js"));
}
