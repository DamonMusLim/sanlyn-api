// /api/bl-ocr.js — MiniMax M3 提单/报关单 OCR 提取
// POST { image_base64: "...", media_type: "image/jpeg", doc_type: "bl"|"customs" }
// Returns { success, fields, raw_text, model }

const ALLOWED = [
  "https://damon.sanlyn.cn", "https://ai.sanlyn.cn",
  "http://localhost:5173", "http://localhost:5188", "http://localhost:3000",
];
function setCors(req, res) {
  const o = req.headers.origin || "";
  if (ALLOWED.includes(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary","Origin");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization");
}

const BL_PROMPT = `这是一张提单（Bill of Lading / Sea Waybill）图片。
请仔细识别所有文字，严格只返回如下 JSON，不要任何其他文字或 markdown：
{
  "bl_no": "提单号，如 COAU9503264600",
  "vessel": "船名，如 MSC ELBA III",
  "voyage": "航次，如 HV618A",
  "carrier_code": "船公司代码，如 MSC/COSCO/YML/OOCL",
  "pol": "起运港英文，如 XIAMEN, CHINA",
  "pod": "目的港英文，如 PORT KLANG, MALAYSIA",
  "etd": "装船日期 YYYY-MM-DD，On Board Date",
  "eta": "预计到港 YYYY-MM-DD，如有",
  "container_no": "柜号，多柜用逗号分隔，如 MSDU1234567,MSDU7654321",
  "seal_no": "封签号，多个用逗号分隔",
  "container_type": "箱型，如 40HQ/20GP/40GP",
  "gross_weight_kg": 毛重公斤数字如45000,
  "total_cartons": 箱数整数,
  "total_cbm": 体积立方米数字如82.5,
  "shipper": "发货人名称（Shipper）",
  "consignee": "收货人名称（Consignee）",
  "notify_party": "通知方，如有",
  "release_type": "SWB或OBL，Sea Waybill=SWB，Original Bill=OBL",
  "cargo_description": "货描/品名，前50字"
}`;

const CUSTOMS_PROMPT = `这是一张中国出口报关单（海关申报单）图片。
请仔细识别所有文字，严格只返回如下 JSON，不要任何其他文字或 markdown：
{
  "customs_no": "报关单号，如 310220260050XXXX",
  "shipper": "境内发货人/申报单位",
  "consignee": "境外收货人",
  "bl_no": "提运单号",
  "container_no": "集装箱号",
  "contract_no": "合同号",
  "port_of_loading": "装货港",
  "port_of_discharge": "卸货港",
  "trade_terms": "成交方式 FOB/CIF/CFR/DDP",
  "total_packages": 件数整数,
  "gross_weight_kg": 毛重公斤数字,
  "net_weight_kg": 净重公斤数字,
  "items": [{"hs_code":"HS编码","description":"品名","qty":数量,"unit":"单位","unit_price":单价,"total":"总价"}]
}`;

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method_not_allowed" });

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: "MINIMAX_API_KEY not configured" });

  const { image_base64, media_type = "image/jpeg", doc_type = "bl" } = req.body || {};
  if (!image_base64) return res.status(400).json({ success: false, error: "image_base64 required" });

  const prompt = doc_type === "customs" ? CUSTOMS_PROMPT : BL_PROMPT;

  try {
    console.log(`[bl-ocr] calling MiniMax M3, doc_type=${doc_type}, image size=${image_base64.length}`);

    const mmRes = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "MiniMax-M3",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type, data: image_base64 },
            },
            { type: "text", text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(60000),
    });

    const data = await mmRes.json();
    console.log(`[bl-ocr] M3 status=${mmRes.status} usage=${JSON.stringify(data.usage||{})}`);

    if (!mmRes.ok) {
      return res.json({ success: false, error: data.error?.message || JSON.stringify(data).slice(0,200), http_status: mmRes.status });
    }

    const rawText = data.content?.[0]?.text || "";
    console.log(`[bl-ocr] raw: ${rawText.slice(0,300)}`);

    // Parse JSON from response
    let fields = {};
    try {
      const start = rawText.indexOf("{"), end = rawText.lastIndexOf("}");
      if (start >= 0 && end > start) {
        fields = JSON.parse(rawText.slice(start, end + 1));
      }
    } catch (e) {
      console.warn("[bl-ocr] JSON parse failed:", e.message);
      fields = { _parse_error: true, raw: rawText.slice(0, 500) };
    }

    return res.json({
      success: true,
      doc_type,
      fields,
      raw_text: rawText.slice(0, 1000),
      model: "MiniMax-M3",
      usage: data.usage,
    });

  } catch (e) {
    console.error("[bl-ocr] error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
}
