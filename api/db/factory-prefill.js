// api/db/factory-prefill.js — Factory Portal 预填引擎
//
// POST /api/db/factory-prefill
//   输入: { factoryTaxId?, factoryCode?, customerCode, itemHint?, qty?, unitPrice? }
//   输出: { candidates[], top, source, warnings[] }
//
// 数据源优先级（SaaS 规矩：知识库永远本地，零外部依赖）:
//   1. 同工厂历史 (customers.raw.invoiceHistory)     — 未来接入
//   2. 业务归纳映射 (tax-hs-map.json)                — 未来接入
//   3. 宠物品类子集 (kb/tax-codes-pet.json)           — ✅ 已就位
//   4. 全量税码 (kb/tax-codes-active.json)            — 兜底
//
// 税率规则: 从税码表强制取，工厂不可覆盖。默认接一般纳税人走 13%。
// 详见 project_factory_portal.md。

import { getPool, setCors } from "../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.join(__dirname, "..", "kb");

// ── 知识库缓存（首次加载后常驻内存） ─────────────────
let _petCodes = null;
let _allCodes = null;

function loadPetCodes() {
  if (_petCodes) return _petCodes;
  try {
    const raw = fs.readFileSync(path.join(KB_DIR, "tax-codes-pet.json"), "utf8");
    _petCodes = JSON.parse(raw).codes || [];
  } catch (e) {
    console.error("[factory-prefill] 宠物税码库加载失败:", e.message);
    _petCodes = [];
  }
  return _petCodes;
}
function loadAllCodes() {
  if (_allCodes) return _allCodes;
  try {
    const raw = fs.readFileSync(path.join(KB_DIR, "tax-codes-active.json"), "utf8");
    _allCodes = JSON.parse(raw).codes || [];
  } catch (e) {
    console.error("[factory-prefill] 全量税码库加载失败:", e.message);
    _allCodes = [];
  }
  return _allCodes;
}

// ── 从 hint 中提取候选词（简单 tokenization，足够用） ─
function tokenize(str) {
  if (!str) return [];
  const cleaned = String(str).toLowerCase().replace(/[0-9]+/g, " ").trim();
  // 中文按字拆，英文按空格
  const zhChars = (cleaned.match(/[\u4e00-\u9fa5]/g) || []);
  const enWords = (cleaned.match(/[a-z]+/g) || []).filter(w => w.length >= 2);
  return [...new Set([...zhChars, ...enWords])];
}

// ── 对单条税码算匹配分 ─────────────────────────────
function scoreCode(code, hintTokens) {
  const blob = [code.name, code.shortName, code.keywords, code.description, code.customsName]
    .filter(Boolean).join(" ").toLowerCase();
  if (!hintTokens.length) return 0;
  let hits = 0;
  for (const t of hintTokens) {
    if (blob.includes(t)) hits++;
  }
  // 深度（子码）优先 — 19位后面非0段越多越具体
  const depth = code.code.replace(/0+$/, "").length;
  const isPet = code.code.startsWith("1060513");
  return hits * 10 + depth * 0.1 + (isPet ? 2 : 0);
}

// ── 按品类默认（没 hint 时的兜底） ────────────────
function categoryDefault(category) {
  const defaults = {
    pet: "1060513040000000000",            // 宠物专用品
    pet_food: "1030104000000000000",       // 饲料及宠物食品
    pet_toy: "1060513010000000000",        // 宠物玩具
    pet_clothes: "1060513020000000000",    // 宠物服装
  };
  return defaults[category] || defaults.pet;
}

// ── 规范化输出 ─────────────────────────────────
function normalizeCandidate(code, confidence, matchedVia) {
  const vat = code.vatRate && code.vatRate.replace(/[^0-9.]/g, "");
  const vatNum = vat ? parseFloat(vat) / 100 : null;
  return {
    taxCode:        code.code,
    taxCodeName:    code.name,
    invoiceName:    code.shortName || code.name,
    vatRate:        vatNum,               // 可能 null (大类码)
    vatRateSource:  "gov_tax_code_table_v32",
    hsHint:         code.hsHint || null,
    customsName:    code.customsName || null,
    isAbbrAllowed:  !!code.isAbbrAllowed,
    parentCode:     code.parentCode || null,
    confidence,                           // "history" | "category_exact" | "keyword_match" | "default_fallback"
    matchedVia,                           // 人看得懂的 debug 信息
  };
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = req.body || {};
    const factoryTaxId   = (body.factoryTaxId   || "").trim();
    const factoryCode    = (body.factoryCode    || "").trim();
    const customerCode   = (body.customerCode   || "").trim();
    const itemHint       = (body.itemHint       || "").trim();
    const category       = (body.category       || "pet").trim();
    const qty            = parseFloat(body.qty || 0) || 0;
    const unitPrice      = parseFloat(body.unitPrice || 0) || 0;

    const warnings = [];
    const pool = getPool();
    const candidates = [];
    let historyCount = 0;

    // ── 1. 同工厂历史（最高优先级，以后追 ocr-records） ──
    if (factoryTaxId || factoryCode) {
      const factoryQuery = factoryTaxId
        ? "SELECT raw FROM customers WHERE tax_id = $1 AND portal_role='factory' LIMIT 1"
        : "SELECT raw FROM customers WHERE company_code = $1 AND portal_role='factory' LIMIT 1";
      const factoryArg = factoryTaxId || factoryCode;
      const r = await pool.query(factoryQuery, [factoryArg]);
      if (r.rows.length > 0) {
        const fraw = r.rows[0].raw || {};
        const history = Array.isArray(fraw.invoiceHistory) ? fraw.invoiceHistory : [];
        historyCount = history.length;
        // 历史命中：直接推第一条（以后可做频次排序）
        for (const h of history.slice(0, 3)) {
          if (h.taxCode) {
            candidates.push({
              taxCode:       h.taxCode,
              taxCodeName:   h.taxCodeName || null,
              invoiceName:   h.invoiceName || null,
              vatRate:       h.vatRate || null,
              vatRateSource: "factory_history",
              hsHint:        h.hsHint || null,
              confidence:    "history",
              matchedVia:    `${factoryTaxId || factoryCode} 历史开票 #${h.invoiceNo || "?"}`,
            });
          }
        }
      } else if (factoryTaxId) {
        warnings.push(`未找到工厂 taxId=${factoryTaxId}，可能是首单。营业执照待 OCR。`);
      }
    }

    // ── 2. 业务归纳 (tax-hs-map.json) —— 以后接 ──

    // ── 3. 宠物子集关键词匹配 ──
    const petCodes = loadPetCodes();
    const hintTokens = tokenize(itemHint || "宠物用品");
    if (itemHint) {
      const scored = petCodes
        .map(c => ({ c, s: scoreCode(c, hintTokens) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 5);
      for (const { c } of scored) {
        // 跳过已经出现在 history 的
        if (candidates.find(x => x.taxCode === c.code)) continue;
        candidates.push(normalizeCandidate(c, "keyword_match", `宠物库命中: ${hintTokens.join("/")}`));
      }
    }

    // ── 4. 品类默认兜底 ──
    if (candidates.length === 0) {
      const defaultCode = categoryDefault(category);
      const all = loadAllCodes();
      const c = all.find(x => x.code === defaultCode);
      if (c) {
        candidates.push(normalizeCandidate(c, "default_fallback", `品类 ${category} 兜底 → 宠物专用品`));
        warnings.push("未命中任何具体品类，使用宠物专用品兜底。强烈建议让工厂手动确认品名。");
      }
    }

    // ── 锁定 13% 税率（如果兜底码没率，就强制填 13%） ──
    for (const cand of candidates) {
      if (cand.vatRate == null || cand.vatRate === 0) {
        cand.vatRate = 0.13;
        cand.vatRateSource = "sanlyn_default_13pct";
        cand.note = cand.note || "大类码无默认税率，按 Sanlyn 规则锁定 13%（一般纳税人 / 宠物用品标准率）";
      }
    }

    // ── 金额预算（如果给了 qty+unitPrice） ──
    let financial = null;
    if (qty > 0 && unitPrice > 0 && candidates[0]) {
      const subtotal = +(qty * unitPrice).toFixed(2);
      const rate = candidates[0].vatRate;
      const grossAmount = +(subtotal * (1 + rate)).toFixed(2);
      financial = {
        qty, unitPrice, subtotal,
        taxRate: rate,
        grossAmount,
        taxAmount: +(grossAmount - subtotal).toFixed(2),
        currency: "CNY",
      };
    }

    return res.status(200).json({
      success: true,
      top: candidates[0] || null,
      candidates,
      financial,
      context: {
        factoryTaxId, factoryCode, customerCode, itemHint, category,
        historyCount,
        kbVersion: "tax-codes v32.0 (2019-04) + sanlyn overlay",
      },
      warnings,
    });

  } catch (err) {
    console.error("[factory-prefill]", err);
    return res.status(500).json({ error: err.message });
  }
}
