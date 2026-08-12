// booking-collab.js — 协同托书   PAGE_VERSION v1.2.0 · 2026-06-23 — 预览豁免+is_preview/preview_godview 标志(给前端预览身份横幅)
// Mounted at /api/db/booking-collab
//
// Endpoints:
//   GET  /validate          token验证 + 返回完整数据包
//   POST /send-factory-link Sanlyn内部 → 生成工厂链接
//   POST /send-customer-link Sanlyn内部 → 生成客户链接
//   POST /factory-submit    工厂提交（token鉴权，body.token）
//   POST /customer-submit   客户提交（token鉴权，body.token）
//   GET  /sailings          获取班次（query.token 鉴权）
//   POST /sailings          Sanlyn内部添加班次
//   DELETE /sailings/:id    Sanlyn内部删除班次
//
// 2026-07-31 结构性拆分: 各 handler 移至 ./lib/collab-*.js, 本文件只留路由分发 (行为零改变)

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { registerBookingCollabView } from "./booking-collab-view.js";
import { handleCollabQuoteSubmit } from "./lib/collab-quote-submit.js";
import { handleCollabRefSubmit } from "./lib/collab-ref-submit.js";
import { handleCollabRequirementSubmit } from "./lib/collab-requirement-submit.js";
import { handleCargoPayment, handleCargoPaymentConfirm } from "./lib/cargo-payment.js";
import { handleFactoryInvoiceCode } from "./lib/factory-invoice-code.js";
import { handleArchiveRetrieveRequest } from "./lib/archive-retrieve-request.js";
// ── split modules (2026-07-31 structural split; handlers unchanged) ──
import { handleValidate } from "./lib/collab-validate.js";
import { handleSendFactoryLink, handleSendCustomerLink, handleSendRoleLink, handleSendPortalLink, handleMasterPreviewToken, handleSendIntermediaryLink } from "./lib/collab-links.js";
import { handleFactorySubmit } from "./lib/collab-submit-factory.js";
import { handleCustomerSubmit, handleTruckingSubmit, handleBrokerSubmit, handleCustomerNotes } from "./lib/collab-submit-roles.js";
import { handleSetFactoryBill, handleConfirmFactoryBill, handlePartyDefaults, handleSetPartyDefault, handlePartyBillingStatus, handleSetPartyBilling, handleCollabBillSubmit, handleCollabBillConfirm, handleCollabBillSummary } from "./lib/collab-billing.js";
import { handleFileProxy, handleCollabUpload } from "./lib/collab-files.js";
import { handleGetSailings, handlePostSailing, handleGetPlan, handlePatchPlan, handleDeleteSailing, handlePlansList, handlePlanFactories } from "./lib/collab-sailings-plans.js";
import { handleGetContacts, handleSupplyChainOptions, handleCollabPartyInvoices, handleCollabVendorOptions, handleCollabAssignVendor } from "./lib/collab-contacts-vendor.js";
import { handleCustomsDocStatus, handleCollabMessages, handlePostCollabMessage, handleShipmentOrders } from "./lib/collab-misc.js";
import { handleCollabPricing, handleCollabOrderPricing, handleCollabPricingSubmit } from "./lib/collab-pricing.js";
import { handleBlConfirmation } from "./lib/collab-bl-confirmation.js";
import { handleCcList } from "./lib/collab-cc-list.js";
import { handleCompanyProfile } from "./lib/collab-company-profile.js";
import { handlePortChargeDraft } from "./lib/collab-port-charge-draft.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // Extract path suffix:  /api/db/booking-collab/validate → "validate"
  // For /sailings/:id: second-to-last = "sailings", last = id
  const _fullPath = (req.path || req.url || "").replace(/\?.*/, "");
  const segments = _fullPath.split("/").filter(Boolean);
  const pathSuffix  = segments[segments.length - 1] || "";
  const parentSuffix = segments[segments.length - 2] || "";

  try {
    if (req.method === "GET"    && pathSuffix === "plan-factories")     return await handlePlanFactories(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "validate")           return await handleValidate(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "cargo-payment")      return await handleCargoPayment(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "cargo-payment-confirm") return await handleCargoPaymentConfirm(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "factory-invoice-code") return await handleFactoryInvoiceCode(req, res, pool);
    if ((req.method === "GET" || req.method === "POST") && pathSuffix === "company-profile") return await handleCompanyProfile(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "port-charge-draft") return await handlePortChargeDraft(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "archive-retrieve-request") return await handleArchiveRetrieveRequest(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "customs-doc-status") return await handleCustomsDocStatus(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "send-factory-link")  return await handleSendFactoryLink(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "send-customer-link") return await handleSendCustomerLink(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "factory-submit")     return await handleFactorySubmit(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "customer-submit")    return await handleCustomerSubmit(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "sailings")           return await handleGetSailings(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "contacts")           return await handleGetContacts(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "send-trucking-link") return await handleSendRoleLink(req, res, pool, "trucking");
    if (req.method === "POST"   && pathSuffix === "send-broker-link")   return await handleSendRoleLink(req, res, pool, "broker");
    if (req.method === "POST"   && pathSuffix === "send-portal-link")   return await handleSendPortalLink(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "trucking-submit")    return await handleTruckingSubmit(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "broker-submit")      return await handleBrokerSubmit(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "customer-notes")     return await handleCustomerNotes(req, res, pool);
    if ((req.method === "GET" || req.method === "POST") && pathSuffix === "bl-confirmation") return await handleBlConfirmation(req, res, pool);
    if ((req.method === "GET" || req.method === "POST") && pathSuffix === "cc-list") return await handleCcList(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "file")               return await handleFileProxy(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "upload")             return await handleCollabUpload(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "sailings")           return await handlePostSailing(req, res, pool);
    if (req.method === "DELETE" && parentSuffix === "sailings")         return await handleDeleteSailing(req, res, pool, pathSuffix);
    if (req.method === "GET"    && pathSuffix  === "plans-list")        return await handlePlansList(req, res, pool);
    if (req.method === "GET"    && parentSuffix === "plan")             return await handleGetPlan(req, res, pool, pathSuffix);
    if (req.method === "PATCH"  && parentSuffix === "plan")             return await handlePatchPlan(req, res, pool, pathSuffix);
    if (req.method === "POST"   && pathSuffix === "set-factory-bill")   return await handleSetFactoryBill(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "confirm-factory-bill") return await handleConfirmFactoryBill(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "supply-chain-options")  return await handleSupplyChainOptions(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "party-defaults")         return await handlePartyDefaults(req, res, pool);
    if (req.method === "POST" && pathSuffix === "set-party-default")      return await handleSetPartyDefault(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "party-billing-status")   return await handlePartyBillingStatus(req, res, pool);
    if (req.method === "POST" && pathSuffix === "set-party-billing")      return await handleSetPartyBilling(req, res, pool);
    if (req.method === "POST" && pathSuffix === "collab-bill-submit")     return await handleCollabBillSubmit(req, res, pool);
    if (req.method === "POST" && pathSuffix === "collab-bill-confirm")    return await handleCollabBillConfirm(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "collab-bill-summary")    return await handleCollabBillSummary(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "collab-messages")        return await handleCollabMessages(req, res, pool);
    if (req.method === "POST" && pathSuffix === "collab-message")         return await handlePostCollabMessage(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "shipment-orders")        return await handleShipmentOrders(req, res, pool);
    if (await registerBookingCollabView(req, res, pool, { pathSuffix, parentSuffix, requireAuth })) return;
    if ((req.method === "GET" || req.method === "POST") && pathSuffix === "master-preview-token") return await handleMasterPreviewToken(req, res, pool);
    if (req.method === "GET" && pathSuffix === "collab-pricing")       return await handleCollabPricing(req, res, pool);
    if (req.method === "GET" && pathSuffix === "collab-order-pricing") return await handleCollabOrderPricing(req, res, pool);
    if (req.method === "GET" && pathSuffix === "collab-party-invoices") return await handleCollabPartyInvoices(req, res, pool);
    if (req.method === "GET" && pathSuffix === "collab-vendor-options") return await handleCollabVendorOptions(req, res, pool);
    if (req.method === "POST" && pathSuffix === "collab-assign-vendor") return await handleCollabAssignVendor(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "send-intermediary-link")  return await handleSendIntermediaryLink(req, res, pool);
    if (req.method === "POST" && pathSuffix === "factory-self-token")  return await handleFactoryToken(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "collab-pricing-submit")    return await handleCollabPricingSubmit(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "collab-quote-submit")     return await handleCollabQuoteSubmit(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "collab-ref-submit")       return await handleCollabRefSubmit(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "collab-requirement-submit") return await handleCollabRequirementSubmit(req, res, pool);

    return res.status(404).json({ error: "Not found" });
  } catch (e) {
    console.error("[booking-collab]", e.message, e.stack);
    return res.status(500).json({ error: "internal_error" });
  }
}

/*
2026-07-01 factory profile address correction:
- L232-L243, L360: validate returns factory_profile_address only for non-preview scoped factory tokens with one exact companies.name_cn match.
- L625-L688: factory-submit update-factory-address requires scoped factory token, confirm=true, <=200-char address, unique companies row by token label, and appends audit to shipping_plans.raw.factory_address_changes.
*/
