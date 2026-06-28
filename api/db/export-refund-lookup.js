// api/db/export-refund-lookup.js — 出口退税率查询（内部接口）
//
// GET /api/db/export-refund-lookup?hsCode=4212040000
//   auth: JWT required
//   返回: { hsCode, refundRate, matchLevel, color, warning, source, desc }
//
// 策略: 最长前缀匹配（完整 → 8 位 → 6 位 → 4 位 → default）
// 规则: rate=0 → 红；<0.06 → 黄低；<0.10 → 黄中；>=0.10 → 绿
// 数据源: ~/api/kb/export-refund-rates.json（国税总局公开 + Sanlyn 手工补）
// 详见 knowledge-base/README.md + MEMORY.md 一次性拷贝原则

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { setCors } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_FILE = path.join(__dirname, "..", "kb", "export-refund-rates.json");

let _kb = null;
function loadKB() {
  if (_kb) return _kb;
  try {
    _kb = JSON.parse(fs.readFileSync(KB_FILE, "utf8"));
  } catch (e) {
    console.error("[export-refund-lookup] KB load failed:", e.message);
    _kb = { rates: {}, rules: {}, customOverrides: { entries: {} } };
  }
  return _kb;
}

export function lookupRefundRate(hsCode) {
  const kb = loadKB();
  const hs = String(hsCode || "").replace(/\D/g, "");
  if (!hs) {
    return { hsCode: null, refundRate: null, matchLevel: "none", color: "gray",
             warning: "HS 编码为空", source: "no_input" };
  }

  // 1. customOverrides 完全匹配
  const override = (kb.customOverrides?.entries || {})[hs];
  if (override) {
    return classify(hs, override.refundRate, "override", override.desc || "");
  }

  // 2. 最长前缀匹配（10→8→6→4→2）
  const rates = kb.rates || {};
  for (const len of [10, 8, 6, 4, 2]) {
    const prefix = hs.slice(0, len);
    if (rates[prefix]) {
      const entry = rates[prefix];
      return classify(hs, entry.refundRate, `prefix_${len}`, entry.desc || "");
    }
  }

  return { hsCode: hs, refundRate: null, matchLevel: "not_found", color: "gray",
           warning: "未找到退税率，必须人工查核", source: "kb_v1", desc: "" };
}

function classify(hs, rate, matchLevel, desc) {
  let color = "green", warning = null;
  if (rate === 0)        { color = "red";    warning = "该 HS 不可退税！必须老板审批"; }
  else if (rate < 0.06)  { color = "yellow"; warning = "退税率较低 (<6%)，利润可能受影响"; }
  else if (rate < 0.10)  { color = "yellow"; warning = "退税率中等"; }
  return { hsCode: hs, refundRate: rate, matchLevel, color, warning, source: "kb_v1", desc };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  if (!req.user) return res.status(401).json({ error: "auth required" });

  const hsCode = (req.query?.hsCode || req.query?.hs || "").toString();
  const result = lookupRefundRate(hsCode);
  res.status(200).json({ success: true, ...result });
}
