// booking-collab-view-ai.js — AI 建议 handler（拆自 booking-collab-view.js 2026-07-13）
import { NON_EMPTY, arr, parseRaw, resolvePlan, companyName } from "./booking-collab-view-lib.js";

// POST /ai-fill-from-docs — 单据识别（OCR 待接，先返回空建议不报错）
export async function handleAiFillFromDocs(req, res) {
  const body = req.body || {};
  const files = arr(body.files).filter(f => f && f.base64);
  if (!files.length) return res.json({ ok: true, suggestions: {}, note: "无文件" });
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return res.json({ ok: true, suggestions: {}, note: "MINIMAX_API_KEY 未配置" });
  const PROMPT = '这是一张提单(Bill of Lading)或出口报关单图片。严格只返回如下JSON,不要任何其他文字或markdown:\n{"release_type":"SWB或OBL(Sea Waybill=SWB,Original Bill=OBL,电放=SWB)","freight_term":"成交/运费方式 FOB/CIF/CFR/EXW/DDP","bl_no":"提单号","vessel":"船名","carrier_code":"船公司如COSCO/MSC/OOCL","pol":"起运港英文","pod":"目的港英文","container_no":"柜号逗号分隔"}';
  const merged = {};
  for (const f of files.slice(0, 4)) {
    try {
      const mmRes = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "MiniMax-M3", max_tokens: 1500,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: f.mime || "image/jpeg", data: f.base64 } },
            { type: "text", text: PROMPT },
          ] }],
        }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await mmRes.json();
      if (!mmRes.ok) continue;
      const rawText = (data.content && data.content[0] && data.content[0].text) || "";
      const s = rawText.indexOf("{"), e = rawText.lastIndexOf("}");
      if (s < 0 || e <= s) continue;
      const fields = JSON.parse(rawText.slice(s, e + 1));
      for (const k of Object.keys(fields)) {
        if (NON_EMPTY(fields[k]) && !NON_EMPTY(merged[k])) merged[k] = String(fields[k]).trim();
      }
    } catch (err) { /* skip file */ }
  }
  const suggestions = {};
  if (NON_EMPTY(merged.freight_term)) {
    const v = String(merged.freight_term).toUpperCase().replace(/[^A-Z]/g, "");
    if (["FOB","CIF","CFR","EXW","DDP","DAP","FCA"].includes(v))
      suggestions.freight_term = { value: v, confidence: "high", source: "单据OCR", reason: "从上传单据识别" };
  }
  if (NON_EMPTY(merged.release_type)) {
    const v = /SWB|电放|WAYBILL/i.test(merged.release_type) ? "SWB" : /OBL|ORIGINAL|正本/i.test(merged.release_type) ? "OBL" : "";
    if (v) suggestions.release_type = { value: v, confidence: "high", source: "单据OCR", reason: "从上传单据识别" };
  }
  return res.json({ ok: true, suggestions, ocr: merged, note: Object.keys(suggestions).length ? "已识别" : "未识别到可用字段" });
}

// POST /ai-suggest — 从客户历史 + forwarder_partner 文本推断建议（只读，不写库）
export async function handleAiSuggest(req, res, pool) {
  const body = req.body || {};
  const plan = await resolvePlan(pool, body.plan_id);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });
  const suggestions = {};
  // 本票订单派生(优先级最高)——本票自己的订单里明明就有的,别绕去查历史
  {
    const { rows: own } = await pool.query(
      `SELECT trade_terms FROM orders
        WHERE shipping_plan_id = $1 AND (status IS NULL OR status NOT IN ('cancelled'))`,
      [plan.id]);
    const terms = [...new Set(own.map(r => r.trade_terms).filter(NON_EMPTY).map(s => String(s).trim().toUpperCase()))];
    if (!NON_EMPTY(plan.freight_term) && terms.length) {
      suggestions.freight_term = terms.length === 1
        ? { value: terms[0], confidence: "high", source: "本票订单", reason: `本票 ${own.length} 个订单均为 ${terms[0]}` }
        : { value: terms[0], confidence: "low", source: "本票订单", reason: `本票订单交易方式不一致(${terms.join("/")})请人工确认` };
    }
  }
  const cust = plan.customer || plan.customer_en;
  if (NON_EMPTY(cust)) {
    const { rows } = await pool.query(
      `SELECT release_type, freight_term, trucking_company_id, customs_broker_id
         FROM shipping_plans
        WHERE id <> $1 AND (customer = $2 OR customer_en = $2)
        ORDER BY updated_at DESC NULLS LAST LIMIT 40`,
      [plan.id, cust]);
    const mode = (field) => {
      const cnt = {}; let total = 0;
      for (const r of rows) { const v = r[field]; if (NON_EMPTY(v)) { cnt[v] = (cnt[v] || 0) + 1; total++; } }
      let best = null, n = 0; for (const [k, c] of Object.entries(cnt)) if (c > n) { best = k; n = c; }
      return best ? { value: best, count: n, total } : null;
    };
    if (!NON_EMPTY(plan.release_type)) {
      const m = mode("release_type");
      if (m) suggestions.release_type = { value: m.value, confidence: m.count >= 3 ? "high" : "medium", source: "客户历史", reason: `该客户 ${m.total} 票中 ${m.count} 票用 ${m.value}` };
    }
    if (!NON_EMPTY(plan.freight_term) && !suggestions.freight_term) {
      const m = mode("freight_term");
      if (m) suggestions.freight_term = { value: m.value, confidence: m.count >= 3 ? "high" : "medium", source: "客户历史", reason: `该客户 ${m.count} 票用 ${m.value}` };
    }
    if (!NON_EMPTY(plan.trucking_company_id)) {
      const m = mode("trucking_company_id");
      if (m) { const nm = await companyName(pool, m.value); if (nm) suggestions.trucking = { company_id: Number(m.value), company_cn: nm, confidence: m.count >= 3 ? "high" : "medium", source: "客户历史", reason: `该客户 ${m.count} 票用 ${nm}` }; }
    }
    if (!NON_EMPTY(plan.customs_broker_id)) {
      const m = mode("customs_broker_id");
      if (m) { const nm = await companyName(pool, m.value); if (nm) suggestions.broker = { company_id: Number(m.value), company_cn: nm, confidence: m.count >= 3 ? "high" : "medium", source: "客户历史", reason: `该客户 ${m.count} 票用 ${nm}` }; }
    }
  }
  const fp = plan.forwarder_partner || "";
  if (NON_EMPTY(fp)) {
    const rawp = parseRaw(plan.raw);
    const parts = fp.split(/[×xX*、,，\/／&+]/).map(s => s.trim()).filter(s => s.length >= 2);
    for (const p of parts) {
      const { rows } = await pool.query(
        `SELECT id, COALESCE(name_cn, name_en) AS n FROM companies
          WHERE (name_cn ILIKE $1 OR name_en ILIKE $1) AND (active IS NOT FALSE)
          ORDER BY (type = 'forwarder') DESC, length(COALESCE(name_cn, name_en)) ASC LIMIT 3`,
        [`%${p}%`]);
      if (!rows.length) continue;
      const isBaby = /洋宝宝|宝宝|OCEANBABY/i.test(rows[0].n);
      const key = isBaby ? "intermediary" : "ocean";
      const already = key === "ocean" ? NON_EMPTY(plan.forwarder_company_id) : NON_EMPTY(rawp.intermediary_company_id);
      if (suggestions[key] || already) continue;
      suggestions[key] = rows.length === 1
        ? { company_id: rows[0].id, company_cn: rows[0].n, confidence: "medium", source: "forwarder_partner 解析", reason: `来自 "${fp}"` }
        : { company_id: rows[0].id, company_cn: rows[0].n, confidence: "low", source: "forwarder_partner 解析", reason: `"${p}" 命中多家(${rows.map(r => r.n).join("/")})请人工确认` };
    }
  }
  return res.json({ ok: true, suggestions });
}
