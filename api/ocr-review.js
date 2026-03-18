// /api/ocr-review.js
// Vercel Serverless Function — 阿里云百炼 qwen-vl-plus 识别水单 + JDY write-back
// 使用 OpenAI 兼容接口，无需复杂签名

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function callQwenVL(ossUrl) {
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
              text: `这是一张银行付款水单/转账凭证。请仔细识别所有文字，然后严格只返回如下JSON格式，不要任何其他文字、解释或markdown：
{"amount":金额数字或null,"currency":"币种代码如CNY/USD/MYR或null","paymentDate":"YYYY-MM-DD格式或null","bankRef":"银行参考号或流水号或null","senderName":"付款方名称或null"}`,
            },
          ],
        },
      ],
    }),
  });
  return res.json();
}

function parseQwenResponse(data) {
  try {
    const text = data?.choices?.[0]?.message?.content || "";
    console.log("[ocr-review] qwen raw text:", text.slice(0, 300));
    // 提取 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn("[ocr-review] parse error:", e.message);
    return null;
  }
}

async function updateJDY(jdyId, fields) {
  const res = await fetch("https://api.jiandaoyun.com/api/v5/app/entry/data/update", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.JDY_TOKEN || "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app_id: "689cb08a93c073210bfc772b",
      entry_id: "694a4c10c530d677dc4ca0ef",
      data_id: jdyId,
      data: fields,
    }),
  });
  return res.json();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { ossUrl, jdyId } = req.body;
    if (!ossUrl) return res.status(400).json({ success: false, error: "Missing ossUrl" });

    // 1. 调 qwen-vl-plus 识别
    const qwenData = await callQwenVL(ossUrl);
    console.log("[ocr-review] qwen response:", JSON.stringify(qwenData).slice(0, 400));

    const fields = parseQwenResponse(qwenData);
    console.log("[ocr-review] extracted:", JSON.stringify(fields));

    // 2. 写回 JDY
    let jdyUpdated = false;
    if (jdyId && fields) {
      const jdyFields = {};
      if (fields.bankRef)  jdyFields._widget_1773601903113 = { value: fields.bankRef };
      if (fields.currency) jdyFields._widget_1773601903097 = { value: fields.currency };
      if (Object.keys(jdyFields).length > 0) {
        const r = await updateJDY(jdyId, jdyFields);
        console.log("[ocr-review] JDY update:", JSON.stringify(r));
        jdyUpdated = true;
      }
    }

    return res.status(200).json({ success: true, fields, jdyUpdated });

  } catch (err) {
    console.error("[ocr-review] error:", err);
    return res.status(500).json({ success: false, error: err.message || "OCR failed" });
  }
}
