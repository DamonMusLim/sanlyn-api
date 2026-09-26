// po-collab.js — 采购单协同（九步 SOP 第 1 步）
// Mounted at /api/db/po-collab
//
// Endpoints:
//   POST /send-link   内部（需登录）：建协同单 + 签发工厂免登录链接
//   GET  /validate    工厂（token）：打开页面，拿采购单 + 缺什么 + 条款 + 下载包
//   POST /submit      工厂（token）：提交回填
//   POST /upload      工厂（token）：传产品图 / QC报告 / 自己的合同模板
//
// ⛔ 除 /send-link 外一律【只认 magic_links 的 factory_po token】，不认内部 JWT。
// ⛔ 工厂提交的东西只进 collab.*，orders / products 一个字段都不写。

import { getPool, setCors } from "../db.js";
import { handleSendLink, handleValidate, handleSubmit, handleUpload, resolveToken, factoryGate, maybeConfirm }
  from "./lib/po-collab-handlers.js";
import { handleContractPdf, handleSeal, handleContract, handleSealUpload } from "./lib/po-collab-seal.js";
import { handleReview, handleAdopt, handleReturn, handleFile, handleSealApprove }
  from "./lib/po-collab-review.js";
import { handleCustomerSendLink, handleCustomerValidate, handleCustomerSubmit, handleCustomerUpload, handleCustomerShipmentLink,
         resolveCustomerToken, customerGate, isCustomerToken, maybeCustomerConfirm,
         CUSTOMER_SEAL_OPTS, CUSTOMER_SEAL_UPLOAD_OPTS, CUSTOMER_PDF_OPTS } from "./lib/po-collab-customer.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  const m = /\/api\/db\/po-collab\/?(.*)$/.exec(req.url.split("?")[0] || "");
  const sub = (m && m[1] ? m[1] : "").replace(/\/+$/, "");

  try {
    // 订单协同·客户版（Damon 0926）：发链接看 body.side；其余看协同链接是哪一类 token
    if (req.method === "POST" && sub === "send-link" && req.body?.side === "customer") return await handleCustomerSendLink(req, res, pool);
    const tok = req.method === "GET" ? req.query?.token : req.body?.token;
    if (tok && await isCustomerToken(pool, tok)) {
      if (req.method === "GET"  && sub === "validate")      return await handleCustomerValidate(req, res, pool);
      if (req.method === "POST" && sub === "submit")        return await handleCustomerSubmit(req, res, pool);
      if (req.method === "POST" && sub === "upload")        return await handleCustomerUpload(req, res, pool);
      if (req.method === "POST" && sub === "shipment-link") return await handleCustomerShipmentLink(req, res, pool);
      if (["contract-pdf", "seal", "contract", "seal-upload"].includes(sub)) {
        const src = req.method === "GET" ? req.query : (req.body || {});
        const { sheet, err } = await resolveCustomerToken(pool, src.token, src.sheet);
        if (err) return res.status(403).json({ ok: false, error: err });
        if (!(await customerGate(req, res, pool, sheet))) return;
        if (req.method === "GET"  && sub === "contract-pdf") return await handleContractPdf(req, res, pool, sheet, CUSTOMER_PDF_OPTS);
        if (req.method === "POST" && sub === "seal")         return await handleSeal(req, res, pool, sheet, maybeCustomerConfirm, CUSTOMER_SEAL_OPTS(sheet));
        if (req.method === "GET"  && sub === "contract")     return await handleContract(req, res, pool, sheet);
        if (req.method === "POST" && sub === "seal-upload")  return await handleSealUpload(req, res, pool, sheet, CUSTOMER_SEAL_UPLOAD_OPTS(sheet));
      }
      return res.status(404).json({ ok: false, error: "unknown endpoint: " + sub });
    }
    if (req.method === "POST" && sub === "send-link") return await handleSendLink(req, res, pool);
    if (req.method === "GET"  && sub === "validate")  return await handleValidate(req, res, pool);
    if (req.method === "POST" && sub === "submit")    return await handleSubmit(req, res, pool);
    if (req.method === "POST" && sub === "upload")    return await handleUpload(req, res, pool);
    // 采购合同 PDF / 工厂一键盖公章 / 看回签合同 —— 都要：协同链接 + 登录（本厂工厂账号或内部员工）
    if (["contract-pdf", "seal", "contract", "seal-upload"].includes(sub)) {
      const src = req.method === "GET" ? req.query : (req.body || {});
      const { sheet, err } = await resolveToken(pool, src.token, src.sheet);
      if (err) return res.status(403).json({ ok: false, error: err });
      if (!(await factoryGate(req, res, pool, sheet))) return;
      if (req.method === "GET"  && sub === "contract-pdf") return await handleContractPdf(req, res, pool, sheet);
      if (req.method === "POST" && sub === "seal")         return await handleSeal(req, res, pool, sheet, maybeConfirm);
      if (req.method === "GET"  && sub === "contract")     return await handleContract(req, res, pool, sheet);
      if (req.method === "POST" && sub === "seal-upload")  return await handleSealUpload(req, res, pool, sheet);
    }
    // 我方审核采纳（要登录，handler 里 staffOnly 拦外部账号）
    if (req.method === "GET"  && sub === "review")    return await handleReview(req, res, pool);
    if (req.method === "POST" && sub === "adopt")     return await handleAdopt(req, res, pool);
    if (req.method === "POST" && sub === "return")    return await handleReturn(req, res, pool);
    if (req.method === "GET"  && sub === "file")      return await handleFile(req, res, pool);
    if (req.method === "POST" && sub === "seal-approve") return await handleSealApprove(req, res, pool);
    return res.status(404).json({ ok: false, error: "unknown endpoint: " + sub });
  } catch (err) {
    console.error("[po-collab]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
