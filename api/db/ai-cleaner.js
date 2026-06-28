// ai-cleaner.js
// 统一脏活管家 — admin 一键触发各种 AI 数据清洗任务。
// 复用 ideas-capture.js 已配好的 MiniMax 凭据。
//
// POST /api/db/ai-cleaner
//   body: { task, limit?, dry_run? }
//
// Tasks:
//   product-categorize   → products.category 自动分类（dry/wet/treat/acc）
//   product-tags         → products.ai_tags 自动打标签
//   factory-code-infer   → products.factory_code 推断（基于 factory_name + sku）
//   name-en-fill         → customers.name_en 中→英翻译/补全
//   customer-summary     → customers.ai_summary 一句话客户画像
//   stale-order-alert    → 扫描订单状态卡死，写 ai_alerts JSONB
//   hs-check             → 抽样校验产品名/HS code/declaration_name 一致性

import { getPool, setCors } from "../db.js";

var MM_URL   = process.env.MINIMAX_BASE_URL  || "https://api.minimaxi.com/v1/text/chatcompletion_v2";
var MM_KEY   = process.env.MINIMAX_API_KEY  || "sk-cp--TQnRmQajBd6Rbng3ptBw4aES0erZfkbPS2nbYddkiG7pvRN9P3HBAUfhxyarR2m4XYNnJOIicdkqCU3MoI6AK7z4tSEp-a2VCcWoV4WCNF3uLJyJpop83M";
var MM_MODEL = process.env.MINIMAX_MODEL     || "MiniMax-M2.7-highspeed";

var ALLOWED_TASKS = [
  "product-categorize", "product-tags", "factory-code-infer",
  "name-en-fill", "customer-summary", "stale-order-alert", "hs-check",
];

// ── MiniMax 调用 ──────────────────────────────────────────────
async function callMM(prompt, expectJson = true) {
  if (!MM_KEY) throw new Error("MINIMAX_API_KEY not set");
  var body = {
    model: MM_MODEL,
    messages: [{ role: "user", content: prompt }],
  };
  if (expectJson) body.response_format = { type: "json_object" };
  var r = await fetch(MM_URL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + MM_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  var j = await r.json();
  var text = j?.choices?.[0]?.message?.content || "{}";
  if (!expectJson) return text;
  // Robust JSON extraction: strip markdown fences, then find first {...} block
  text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(text); } catch (_) {}
  var m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// ── Task 1: 产品分类 ─────────────────────────────────────────
async function taskProductCategorize(pool, limit, dryRun) {
  var rows = (await pool.query(
    `SELECT id, sku, product_name, product_name_cn, brand, hs_code, declaration_name, spec
     FROM products WHERE (category IS NULL OR category = '') AND active = true LIMIT $1`,
    [limit]
  )).rows;

  var results = [];
  for (var p of rows) {
    var prompt = `你是 Sanlyn 宠物食品分类员。按下面这条产品信息判断分类：

product_name: ${p.product_name || "—"}
中文名: ${p.product_name_cn || "—"}
品牌: ${p.brand || "—"}
SKU: ${p.sku || "—"}
HS 编码: ${p.hs_code || "—"}
报关品名: ${p.declaration_name || "—"}
规格: ${p.spec || "—"}

只能返回以下 4 类之一：
- dry   = 干粮、膨化粮、烘焙粮、kibble、dry food
- wet   = 湿粮、罐头、餐盒、肉条、wet food、pouch、can
- treat = 零食、奖励、洁齿、咀嚼、肉干、treat、jerky、chew
- acc   = 用品、用具、玩具、笼具、清洁、carrier、bag、bowl

输出 JSON: {"category":"dry|wet|treat|acc","confidence":0.0-1.0,"reason":"一句话"}`;

    var ans = await callMM(prompt);
    if (!ans || !["dry","wet","treat","acc"].includes(ans.category)) {
      results.push({ id: p.id, sku: p.sku, status: "skipped", reason: "AI 没给有效结果" });
      continue;
    }
    if (!dryRun) {
      await pool.query("UPDATE products SET category = $1 WHERE id = $2", [ans.category, p.id]);
    }
    results.push({ id: p.id, sku: p.sku, category: ans.category, confidence: ans.confidence });
  }
  return { task: "product-categorize", scanned: rows.length, written: dryRun ? 0 : results.filter(r => r.category).length, results };
}

// ── Task 2: AI 标签 ──────────────────────────────────────────
async function taskProductTags(pool, limit, dryRun) {
  var rows = (await pool.query(
    `SELECT id, sku, product_name, product_name_cn, brand, spec
     FROM products WHERE (ai_tags IS NULL OR ai_tags::text = '[]') AND active = true LIMIT $1`,
    [limit]
  )).rows;

  var results = [];
  for (var p of rows) {
    var prompt = `给宠物食品产品打 3-6 个英文小写标签（描述口味/形态/适用阶段/特性）。

product_name: ${p.product_name || "—"}
brand: ${p.brand || "—"}
spec: ${p.spec || "—"}
中文名: ${p.product_name_cn || "—"}

输出 JSON: {"tags":["salmon","kibble","puppy","grain-free"]}
只用英文小写，词组用连字符。`;

    var ans = await callMM(prompt);
    if (!ans || !Array.isArray(ans.tags)) {
      results.push({ id: p.id, sku: p.sku, status: "skipped" });
      continue;
    }
    if (!dryRun) {
      await pool.query("UPDATE products SET ai_tags = $1::jsonb WHERE id = $2",
        [JSON.stringify(ans.tags.slice(0, 6)), p.id]);
    }
    results.push({ id: p.id, sku: p.sku, tags: ans.tags });
  }
  return { task: "product-tags", scanned: rows.length, written: dryRun ? 0 : results.filter(r => r.tags).length, results };
}

// ── Task 3: factory_code 推断 ────────────────────────────────
async function taskFactoryCodeInfer(pool, limit, dryRun) {
  // 取已知工厂列表
  var fc = (await pool.query(
    "SELECT DISTINCT factory_name, factory_code FROM products WHERE factory_code IS NOT NULL AND factory_code != ''"
  )).rows;
  var knownByName = {};
  fc.forEach(r => { if (r.factory_name) knownByName[r.factory_name] = r.factory_code; });

  // CANONICAL-CODE GUARD (2026-06-13): factory_code 只允许写 companies.code 已注册值。
  // 历史病根：AI 自造 2 字母简码（ZS/ZC/TD）与 companies 编码脱钩，导致 orders JOIN 挂空。
  var canonByUpper = {};
  (await pool.query("SELECT code FROM companies WHERE active IS NOT FALSE")).rows
    .forEach(r => { canonByUpper[String(r.code).toUpperCase()] = r.code; });

  var rows = (await pool.query(
    `SELECT id, sku, product_name, brand, factory_name
     FROM products WHERE (factory_code IS NULL OR factory_code = '') AND active = true LIMIT $1`,
    [limit]
  )).rows;

  var results = [];
  for (var p of rows) {
    // Quick path: factory_name 已知 → 直接映射
    if (p.factory_name && knownByName[p.factory_name]) {
      var code = knownByName[p.factory_name];
      if (!dryRun) await pool.query("UPDATE products SET factory_code = $1 WHERE id = $2", [code, p.id]);
      results.push({ id: p.id, sku: p.sku, factory_code: code, source: "lookup" });
      continue;
    }
    // Fallback: AI 推断（少见，多数 factory_name 都有值）
    var prompt = `从产品信息推断工厂代号。只能从下面「已注册编码」中选择一个；无法确定就返回空 code。

product_name: ${p.product_name}
brand: ${p.brand}
factory_name: ${p.factory_name || "—"}
sku: ${p.sku}

已注册编码: ${Object.values(canonByUpper).join(" / ")}

输出 JSON: {"code":"已注册编码之一或空","confidence":0.0-1.0}`;
    var ans = await callMM(prompt);
    // 写库前强校验：必须命中 companies 注册码（大小写归一到注册原样），否则跳过
    var canonCode = ans && ans.code ? canonByUpper[String(ans.code).trim().toUpperCase()] : null;
    if (canonCode && ans.confidence >= 0.7) {
      if (!dryRun) await pool.query("UPDATE products SET factory_code = $1 WHERE id = $2", [canonCode, p.id]);
      results.push({ id: p.id, sku: p.sku, factory_code: canonCode, source: "ai", confidence: ans.confidence });
    } else {
      results.push({ id: p.id, sku: p.sku, status: "skipped", reason: ans && ans.code ? "AI 给出未注册编码 " + ans.code : "AI 信心不足" });
    }
  }
  return { task: "factory-code-infer", scanned: rows.length, written: dryRun ? 0 : results.filter(r => r.factory_code).length, results };
}

// ── Task 4: 英文名补全 ──────────────────────────────────────
async function taskNameEnFill(pool, limit, dryRun) {
  var rows = (await pool.query(
    `SELECT id, name, name_cn, country FROM customers WHERE (name_en IS NULL OR name_en = '') LIMIT $1`,
    [limit]
  )).rows;
  var results = [];
  for (var c of rows) {
    var prompt = `把这家公司的中文名翻译为英文公司名（用于外贸单据）。
中文: ${c.name_cn || c.name}
国家: ${c.country || "—"}

规则：
- 用规范的英文翻译，不音译
- 后缀按公司类型加：Co., Ltd. / LLC / GmbH / Inc.
- 不知道就根据国家给合适后缀

输出 JSON: {"name_en":"..."}`;
    var ans = await callMM(prompt);
    if (ans && ans.name_en) {
      if (!dryRun) await pool.query("UPDATE customers SET name_en = $1 WHERE id = $2", [ans.name_en, c.id]);
      results.push({ id: c.id, name_en: ans.name_en });
    }
  }
  return { task: "name-en-fill", scanned: rows.length, written: dryRun ? 0 : results.length, results };
}

// ── Task 5: 客户画像 ────────────────────────────────────────
async function taskCustomerSummary(pool, limit, dryRun) {
  var rows = (await pool.query(
    `SELECT c.id, c.company_code, c.name, c.country, c.role,
       (SELECT COUNT(*) FROM orders o WHERE o.company_code = c.company_code) AS order_count,
       (SELECT COALESCE(SUM(total_amount),0) FROM orders o WHERE o.company_code = c.company_code) AS total_value,
       (SELECT MAX(created_at) FROM orders o WHERE o.company_code = c.company_code) AS last_order_at,
       (SELECT array_agg(DISTINCT brand) FROM orders o WHERE o.company_code = c.company_code AND brand IS NOT NULL) AS brands
     FROM customers c WHERE c.ai_summary IS NULL OR c.ai_summary = '' LIMIT $1`,
    [limit]
  )).rows;

  var results = [];
  for (var c of rows) {
    var prompt = `给这家客户写一句话画像（30 字内中文）。

公司: ${c.name}
国家: ${c.country || "—"}
角色: ${c.role}
历史订单: ${c.order_count} 单，总金额 ¥${c.total_value || 0}
偏好品牌: ${(c.brands || []).join(", ") || "—"}
最后下单: ${c.last_order_at || "从未"}

输出 JSON: {"summary":"PETSOME 偏好 DIBAQ 干粮，月均 ¥120K，活跃买家"}`;
    var ans = await callMM(prompt);
    if (ans && ans.summary) {
      if (!dryRun) await pool.query("UPDATE customers SET ai_summary = $1 WHERE id = $2", [ans.summary, c.id]);
      results.push({ id: c.id, company: c.name, summary: ans.summary });
    }
  }
  return { task: "customer-summary", scanned: rows.length, written: dryRun ? 0 : results.length, results };
}

// ── Task 6: 订单卡死告警 ────────────────────────────────────
async function taskStaleOrderAlert(pool, limit, dryRun) {
  // 找：状态在 pending_confirm / pending_quote / draft 超过 3 天没动的
  var rows = (await pool.query(
    `SELECT id, order_no, status, company_code, factory_code, created_at,
       EXTRACT(EPOCH FROM (NOW() - GREATEST(created_at, updated_at))) / 86400 AS days_stale
     FROM orders
     WHERE status IN ('draft','pending_confirm','pending_quote')
       AND GREATEST(created_at, updated_at) < NOW() - INTERVAL '3 days'
     ORDER BY days_stale DESC LIMIT $1`,
    [limit]
  )).rows;

  var results = [];
  for (var o of rows) {
    var prompt = `订单 ${o.order_no} 卡在状态 "${o.status}" 已 ${Math.floor(o.days_stale)} 天。
客户: ${o.company_code}, 工厂: ${o.factory_code || "未设"}.
请用一句话生成给运营看的提醒（中文，30 字内，要可执行的动作）。

输出 JSON: {"msg":"...","severity":"low|medium|high"}`;
    var ans = await callMM(prompt);
    if (ans && ans.msg) {
      var alert = {
        type: "stale_order",
        msg: ans.msg,
        severity: ans.severity || "medium",
        days_stale: Math.floor(o.days_stale),
        at: new Date().toISOString(),
      };
      if (!dryRun) {
        await pool.query(
          "UPDATE orders SET ai_alerts = COALESCE(ai_alerts, '[]'::jsonb) || $1::jsonb WHERE id = $2",
          [JSON.stringify(alert), o.id]
        );
      }
      results.push({ order_no: o.order_no, alert });
    }
  }
  return { task: "stale-order-alert", scanned: rows.length, written: dryRun ? 0 : results.length, results };
}

// ── Handler ──────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  if (!req.user || (req.user.role !== "admin" && req.user.role !== "super_admin")) {
    return res.status(403).json({ error: "admin only" });
  }

  var pool  = getPool();
  var task  = (req.body || {}).task;
  var limit = Math.min(parseInt((req.body || {}).limit) || 50, 500);
  var dryRun = !!(req.body || {}).dry_run;

  if (!ALLOWED_TASKS.includes(task)) {
    return res.status(400).json({ error: "unknown task", allowed: ALLOWED_TASKS });
  }

  var t0 = Date.now();
  try {
    var result;
    if (task === "product-categorize")  result = await taskProductCategorize(pool, limit, dryRun);
    if (task === "product-tags")        result = await taskProductTags(pool, limit, dryRun);
    if (task === "factory-code-infer")  result = await taskFactoryCodeInfer(pool, limit, dryRun);
    if (task === "name-en-fill")        result = await taskNameEnFill(pool, limit, dryRun);
    if (task === "customer-summary")    result = await taskCustomerSummary(pool, limit, dryRun);
    if (task === "stale-order-alert")   result = await taskStaleOrderAlert(pool, limit, dryRun);
    return res.status(200).json({
      success: true,
      duration_ms: Date.now() - t0,
      dry_run: dryRun,
      ...result,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message, stack: e.stack });
  }
}
