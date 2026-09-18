import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { handleLegacy, handleLinePrice, handleList, handleSend, handleVoid } from "./lib/customer-bill-core.js";
import { handleComment, handleConfirm, handlePublicGet } from "./lib/customer-bill-public.js";

function suffix(req) {
  const path = (req.path || req.url || "").replace(/\?.*/, "");
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const db = getPool();
  const s = suffix(req);
  try {
    if (req.method === "GET" && s === "customer-bill" && String(req.path || "").startsWith("/api/public/")) {
      return await handlePublicGet(req, res, db);
    }
    if (req.method === "POST" && s === "confirm") return await handleConfirm(req, res, db);
    if (req.method === "POST" && s === "comment") return await handleComment(req, res, db);
    if (!requireAuth(req, res)) return;
    if (req.method === "GET" && s === "customer-bill") return await handleList(req, res, db);
    if (req.method === "POST" && s === "line-price") return await handleLinePrice(req, res, db);
    if (req.method === "POST" && s === "send") return await handleSend(req, res, db);
    if (req.method === "POST" && s === "void") return await handleVoid(req, res, db);
    if (req.method === "POST" && s === "legacy") return await handleLegacy(req, res, db);
    return res.status(404).json({ ok: false, error: "not_found" });
  } catch (e) {
    console.error("[customer-bill]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
