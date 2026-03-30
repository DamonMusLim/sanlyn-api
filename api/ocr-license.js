// /api/ocr-license.js
// 营业执照 OCR — 阿里云百炼 qwen-vl-plus 识别营业执照图片
// 输入: ossUrl (营业执照图片的 OSS URL)
// 输出: { companyName, taxId, address, legalPerson, registeredCapital, businessScope }

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function recognizeLicense(ossUrl) {
  const apiKey = process.env.QWEN_API_KEY || "sk-465c7b0cd9414362912e58fdb7762439";
  const res = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "qwen-vl-plus",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: ossUrl },
            },
            {
              type: "text",
              text: `请识别这张营业执照图片，提取以下信息并以JSON格式返回（只返回JSON，不要其他文字）：
{
  "companyName": "公司名称",
  "taxId": "统一社会信用代码",
  "address": "注册地址",
  "legalPerson": "法定代表人",
  "registeredCapital": "注册资本",
  "businessScope": "经营范围（前50字）"
}
如果某个字段无法识别，请填空字符串。`,
            },
          ],
        },
      ],
    }),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  // Parse JSON from response (might have markdown fences)
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return { raw: text, error: "Failed to parse OCR result" };
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { ossUrl } = req.body || {};
    if (!ossUrl) return res.status(400).json({ error: "ossUrl required" });

    const result = await recognizeLicense(ossUrl);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
