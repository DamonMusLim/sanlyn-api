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
import { handleSendLink, handleValidate, handleSubmit, handleUpload }
  from "./lib/po-collab-handlers.js";
import { handleReview, handleAdopt, handleReturn, handleFile }
  from "./lib/po-collab-review.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  const m = /\/api\/db\/po-collab\/?(.*)$/.exec(req.url.split("?")[0] || "");
  const sub = (m && m[1] ? m[1] : "").replace(/\/+$/, "");

  try {
    if (req.method === "POST" && sub === "send-link") return await handleSendLink(req, res, pool);
    if (req.method === "GET"  && sub === "validate")  return await handleValidate(req, res, pool);
    if (req.method === "POST" && sub === "submit")    return await handleSubmit(req, res, pool);
    if (req.method === "POST" && sub === "upload")    return await handleUpload(req, res, pool);
    // 我方审核采纳（要登录，handler 里 staffOnly 拦外部账号）
    if (req.method === "GET"  && sub === "review")    return await handleReview(req, res, pool);
    if (req.method === "POST" && sub === "adopt")     return await handleAdopt(req, res, pool);
    if (req.method === "POST" && sub === "return")    return await handleReturn(req, res, pool);
    if (req.method === "GET"  && sub === "file")      return await handleFile(req, res, pool);
    return res.status(404).json({ ok: false, error: "unknown endpoint: " + sub });
  } catch (err) {
    console.error("[po-collab]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
