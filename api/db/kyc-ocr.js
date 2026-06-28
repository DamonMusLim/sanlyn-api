// kyc-ocr.js
// AI 读营业执照 — 4 国精模板 + 全球通用兜底
// 蓝图 §10 + 老板拍板"OCR 预填，老板点确认"
//
// POST /api/db/kyc-ocr
//   body: { url, country?, doc_type? }
//   country: CN / MY / SG / HK / OTHER
//   doc_type: business_license (默认) / bank / iso22000 / haccp / fda / msds / en71
//   返回: { extracted: {...}, model_confidence, prompt_used, raw_response }
//
// 模型: MiniMax 视觉模型 (支持 image_url)
// 失败兜底: 返回 null 字段，前端引导手填

import { setCors } from "../db.js";

var MM_URL   = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1/text/chatcompletion_v2";
var MM_KEY   = process.env.MINIMAX_API_KEY  || "";
var MM_MODEL = process.env.MINIMAX_VISION_MODEL || "MiniMax-VL-01"; // 视觉模型，可换 GPT-4V / Qwen-VL

// ─── 4 国营业执照 OCR Prompt ───────────────────────────────

var PROMPTS = {
  // ═══ 中国大陆 ═══ 国家企业信用信息公示系统 / 五证合一
  CN: {
    business_license: `你是工商注册文档识别专家。这张图是中国大陆的"统一社会信用代码营业执照"。请提取以下字段，逐字照抄不要纠正：

{
  "country": "CN",
  "company_name_cn": "公司全称(中文)",
  "registration_no": "统一社会信用代码(18位字母数字)",
  "company_type": "公司类型(如有限责任公司/股份/个体工商户)",
  "legal_rep": "法定代表人姓名",
  "registered_capital": "注册资本(含币种)",
  "incorporation_date": "成立日期(YYYY-MM-DD)",
  "valid_from": "有效期自(YYYY-MM-DD,可能写'长期')",
  "valid_to": "有效期至(YYYY-MM-DD,'长期'返回null)",
  "registered_address": "注册地址",
  "business_scope": "经营范围(完整文本)",
  "issuing_authority": "登记机关",
  "registration_date": "登记日期(YYYY-MM-DD)"
}

找不到的字段返回 null。模糊或涂改的字段加 _uncertain:true。只返回 JSON。`,
  },

  // ═══ 马来西亚 ═══ SSM 公司证书 (Form 8/9/49 系列, 2017+ 改 SSM-MyCoID)
  MY: {
    business_license: `You are an expert at reading Malaysian SSM (Suruhanjaya Syarikat Malaysia) company registration certificates. Extract these fields verbatim, do not auto-correct:

{
  "country": "MY",
  "company_name": "Full company name in English (e.g. PETSOME SDN BHD)",
  "registration_no": "New 12-digit registration number (e.g. 201801001234)",
  "old_registration_no": "Old format registration if shown (e.g. 1234567-A)",
  "company_type": "SDN BHD / BHD / ENTERPRISE / PARTNERSHIP",
  "incorporation_date": "Date of Incorporation (YYYY-MM-DD)",
  "registered_address": "Registered office address",
  "business_address": "Principal business address (if different)",
  "directors": ["array of director names"],
  "issuing_authority": "Companies Commission of Malaysia (SSM)",
  "issue_date": "Certificate issue date (YYYY-MM-DD)"
}

Return null for missing fields. JSON only.`,
  },

  // ═══ 新加坡 ═══ ACRA Bizfile (UEN 证书)
  SG: {
    business_license: `You are an expert at reading Singapore ACRA Bizfile / Business Profile documents. Extract these fields verbatim:

{
  "country": "SG",
  "company_name": "Entity Name",
  "uen": "Unique Entity Number (e.g. 201234567A)",
  "entity_type": "PRIVATE COMPANY LIMITED BY SHARES / SOLE PROPRIETORSHIP / etc",
  "incorporation_date": "Registration Date (YYYY-MM-DD)",
  "principal_activities": "Primary SSIC code + description",
  "registered_address": "Registered Office",
  "directors": ["array of director names"],
  "shareholders": ["array if listed"],
  "issuing_authority": "Accounting and Corporate Regulatory Authority (ACRA)",
  "issue_date": "Profile/extract date (YYYY-MM-DD)"
}

Return null for missing. JSON only.`,
  },

  // ═══ 香港 ═══ 公司注册处 CR / 商业登记 BR
  HK: {
    business_license: `You are an expert at reading Hong Kong Companies Registry (CR) certificates and Business Registration (BR) certificates. Extract verbatim:

{
  "country": "HK",
  "company_name_en": "English company name",
  "company_name_cn": "Chinese company name (中文公司名)",
  "cr_no": "Companies Registry Number (e.g. 2345678)",
  "br_no": "Business Registration Number (e.g. 12345678-000-04-25-3)",
  "incorporation_date": "Date of Incorporation (YYYY-MM-DD)",
  "valid_from": "BR Valid From (YYYY-MM-DD)",
  "valid_to": "BR Valid To (YYYY-MM-DD,香港 BR 通常 1 年)",
  "registered_address": "Registered Office Address",
  "business_nature": "Nature of Business",
  "issuing_authority": "Companies Registry / Inland Revenue Department"
}

Return null for missing. JSON only.`,
  },

  // ═══ 通用兜底 (其他国家 / 国家未知) ═══
  OTHER: {
    business_license: `You are an expert document reader. Extract company registration / business license fields from the image. Best effort, return null for missing fields:

{
  "country": "ISO 2-letter code if identifiable, else null",
  "company_name": "Full legal name",
  "registration_no": "Any registration / tax / company number",
  "company_type": "LLC / Inc / Co Ltd / etc",
  "incorporation_date": "Date of incorporation (YYYY-MM-DD)",
  "valid_from": "Validity start (YYYY-MM-DD) or null",
  "valid_to": "Validity end (YYYY-MM-DD) or null",
  "registered_address": "Registered address",
  "directors": ["names"],
  "issuing_authority": "Authority name",
  "issue_date": "Document issue date (YYYY-MM-DD)"
}

JSON only.`,
  },
};

// 银行 / ISO / FDA 等其他文件 (各国通用)
var GENERIC_PROMPTS = {
  bank: `Read this bank account certificate / opening confirmation. Return:
{ "bank_name": "...", "branch": "...", "account_holder": "...", "account_number": "...", "swift_bic": "...", "currency": "...", "issue_date": "YYYY-MM-DD" }
JSON only, null for missing.`,

  iso22000: `Read this ISO 22000 (Food Safety Management) certificate. Return:
{ "cert_no": "...", "scope": "...", "issued_to": "company name", "issuer": "certification body", "issue_date": "YYYY-MM-DD", "expiry_date": "YYYY-MM-DD", "iso_version": "e.g. ISO 22000:2018" }
JSON only.`,

  haccp: `Read this HACCP certificate. Return:
{ "cert_no": "...", "scope": "...", "issued_to": "...", "issuer": "...", "issue_date": "YYYY-MM-DD", "expiry_date": "YYYY-MM-DD" }
JSON only.`,

  fda: `Read this FDA registration / facility registration. Return:
{ "registration_no": "FDA FFR number", "facility_name": "...", "address": "...", "registration_year": "YYYY", "expiry": "YYYY-MM-DD or null" }
JSON only.`,

  msds: `Read this MSDS / Safety Data Sheet (SDS) header page. Return:
{ "product_name": "...", "manufacturer": "...", "revision_date": "YYYY-MM-DD", "hazard_class": "..." }
JSON only.`,

  en71: `Read this EN71 toy safety test report. Return:
{ "report_no": "...", "test_lab": "...", "product_tested": "...", "issue_date": "YYYY-MM-DD", "test_standard": "EN71-X:YYYY", "result": "Pass/Fail" }
JSON only.`,
};

function selectPrompt(country, doc_type) {
  // business_license → 按国家选
  if (doc_type === "business_license" || !doc_type) {
    var c = (country || "OTHER").toUpperCase();
    if (PROMPTS[c]) return { prompt: PROMPTS[c].business_license, template: c };
    return { prompt: PROMPTS.OTHER.business_license, template: "OTHER" };
  }
  // 其他文件 → 通用模板
  if (GENERIC_PROMPTS[doc_type]) return { prompt: GENERIC_PROMPTS[doc_type], template: "GENERIC" };
  return { prompt: PROMPTS.OTHER.business_license, template: "FALLBACK" };
}

async function callVision(prompt, image_url) {
  if (!MM_KEY) throw new Error("MINIMAX_API_KEY not set");
  var body = {
    model: MM_MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: image_url } },
      ],
    }],
    response_format: { type: "json_object" },
  };
  var r = await fetch(MM_URL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + MM_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  var j = await r.json();
  var text = j?.choices?.[0]?.message?.content || "";
  return { text, raw: j };
}

function parseJson(text) {
  if (!text) return null;
  text = String(text).replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(text); } catch (_) {}
  var m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  var b = req.body || {};
  if (!b.url) return res.status(400).json({ error: "url required (image URL)" });

  var country = b.country || null;
  var doc_type = b.doc_type || "business_license";

  var { prompt, template } = selectPrompt(country, doc_type);

  try {
    var { text, raw } = await callVision(prompt, b.url);
    var extracted = parseJson(text);

    return res.status(200).json({
      success: true,
      doc_type,
      template,
      extracted: extracted || {},
      raw_text: text,
      model: MM_MODEL,
      hint: extracted ? null : "OCR 提取失败，请手动填写关键字段",
    });
  } catch (e) {
    return res.status(200).json({
      success: false,
      doc_type,
      template,
      extracted: {},
      error: e.message,
      hint: "OCR 服务不可用，请手动填写",
    });
  }
}
