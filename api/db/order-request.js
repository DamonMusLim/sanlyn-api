// order-request.js — 三入口订单申请后端接口
import { IncomingForm } from "formidable";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  handleOrderRequestCreate,
  handleOrderRequestList,
  handleOrderRequestGet,
  handleOrderRequestReview,
  handleOrderRequestConfirm,
  handleOrderRequestReturn,
  handleOrderRequestFile,
  handleOrderRequestForm,
} from "./lib/order-request.js";

function endpoint(req) {
  const p = (req.url || "").split("?")[0].replace(/\/+$/, "");
  const i = p.indexOf("/order-request");
  return i >= 0 ? p.slice(i + "/order-request".length).replace(/^\/+/, "") : "";
}

function flattenFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = Array.isArray(v) ? v[0] : v;
  // 页面带附件时把整张表单塞在 payload（JSON 字符串）里 → 摊平
  if (typeof out.payload === "string") { try { Object.assign(out, JSON.parse(out.payload)); } catch (_) {} delete out.payload; }
  for (const k of ["lines", "products", "review"]) {
    if (typeof out[k] === "string") {
      try { out[k] = JSON.parse(out[k]); } catch (_) {}
    }
  }
  return out;
}

function flattenFiles(files) {
  const arr = [];
  for (const v of Object.values(files || {})) {
    if (Array.isArray(v)) arr.push(...v);
    else if (v) arr.push(v);
  }
  return arr;
}

async function parseMultipart(req) {
  if (!String(req.headers["content-type"] || "").includes("multipart/form-data")) {
    return { body: req.body || {}, files: [] };
  }
  const form = new IncomingForm({ multiples: true, maxFileSize: 10 * 1024 * 1024, maxFiles: 5 });
  const [fields, files] = await form.parse(req);
  return { body: flattenFields(fields), files: flattenFiles(files) };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const sub = endpoint(req);
  try {
    if (req.method === "GET") {
      if (sub === "file") return await handleOrderRequestFile(req, res, pool);
      if (sub === "form") return await handleOrderRequestForm(req, res, pool);
      if (req.query?.id) return await handleOrderRequestGet(req, res, pool);
      return await handleOrderRequestList(req, res, pool);
    }
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
    const parsed = await parseMultipart(req);
    req.body = parsed.body;
    if (sub === "review") return await handleOrderRequestReview(req, res, pool);
    if (sub === "confirm") return await handleOrderRequestConfirm(req, res, pool);
    if (sub === "return") return await handleOrderRequestReturn(req, res, pool);
    if (!sub) return await handleOrderRequestCreate(req, res, pool, parsed.files);
    return res.status(404).json({ ok: false, error: "not_found" });
  } catch (e) {
    const status = Number(e.status || 500);
    const ref = "or-" + Date.now().toString(36);
    if (status >= 500) console.error("[order-request]", ref, e);
    return res.status(status).json({ ok: false, error: status >= 500 ? "server_error" : e.message, ref: status >= 500 ? ref : undefined });
  }
}
