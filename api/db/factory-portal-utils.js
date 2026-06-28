// api/db/factory-portal-utils.js
// 工厂进项票门户共享原子工具（被 factory-portal / factory-invoice-upload / factory-invoice-ocr 复用）。
// 单一真源：这些小工具只在此定义一次，避免各模块各拷一份漂移。

import crypto from "crypto";

export function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

export function cleanString(v) {
  return String(first(v) || "").trim();
}

export function cleanArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(cleanArray).filter(Boolean);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch (_) {}
    return s.split(/[,\n，；;]+/).map((x) => x.trim()).filter(Boolean);
  }
  return [String(v).trim()].filter(Boolean);
}

export function extOf(name) {
  const m = String(name || "").toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

export function safeNamePart(s) {
  return String(s || "unknown")
    .trim()
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "_")
    .slice(0, 80) || "unknown";
}

export function randomId() {
  return crypto.randomBytes(10).toString("hex");
}
