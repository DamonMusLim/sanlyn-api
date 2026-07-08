import { setCors } from "./db.js";
import { visionOcr } from "./lib/minimax-vl.js";

// POST /api/ddp-ocr-extract
// Body: { imageData: "data:image/jpeg;base64,..." }  OR  { imageUrl: "https://..." }
// Returns: { success: true, data: { customerName, country, product, qtyBoxes, ... } }

const QWEN_OCR_PROMPT = `你是一个货运单据识别助手，专门为 DDP（门到门）报价服务提取货物运输关键信息。
请从这张图片中仔细识别所有文字，然后严格只返回如下JSON格式，不要任何其他文字、解释或markdown：
{
  "customerName": "客户/发件公司名称，找不到返回null",
  "country": "目的国家（标准英文名，如Malaysia/Singapore/UAE），找不到返回null",
  "subRegion": "目的地区（如West Malaysia/East Coast）或目的城市，找不到返回null",
  "product": "货物名称/品名（英文优先），找不到返回null",
  "qtyBoxes": 箱数或件数（整数，无单位），找不到返回null,
  "weightKg": 重量公斤数（数字，不含单位），找不到返回null,
  "lengthCm": 单箱长度cm（数字），找不到返回null,
  "widthCm": 单箱宽度cm（数字），找不到返回null,
  "heightCm": 单箱高度cm（数字），找不到返回null,
  "pickupAddress": "取货地址或工厂地址，找不到返回null",
  "deliveryAddress": "送货地址，找不到返回null",
  "hsCode": "HS编码（6-10位数字），找不到返回null",
  "transportMode": "运输方式air/sea/truck，能判断则填，找不到返回null",
  "specialReqs": "特殊要求如含电池/冷链/危险品/Halal/感温等，找不到返回null",
  "notes": "其他有用信息，找不到返回null"
}
规则：找不到的字段返回null，不要猜测，数字不加引号，单位已统一为cm和kg。`;

async function callQwenVL(imageInput) {
  // imageInput 可为 data:base64 或 https URL，helper 都能处理
  const json = await visionOcr(imageInput, QWEN_OCR_PROMPT);
  const raw = json.choices?.[0]?.message?.content || "";

  // Strip markdown fences if present
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from the text
    const match = cleaned.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Could not parse Qwen response: ${cleaned.slice(0, 300)}`);
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { imageData, imageUrl } = req.body || {};

  if (!imageData && !imageUrl) {
    return res.status(400).json({
      success: false,
      error: "Provide imageData (base64 data URL) or imageUrl (https URL)",
    });
  }

  // Validate base64 size — Qwen VL limit ~10MB
  if (imageData) {
    const bytes = imageData.length * 0.75;
    if (bytes > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: "Image too large (max 10MB)" });
    }
  }

  try {
    const extracted = await callQwenVL(imageData || imageUrl);
    return res.status(200).json({ success: true, data: extracted });
  } catch (err) {
    console.error("[ddp-ocr-extract]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
