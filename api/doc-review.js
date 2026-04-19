// /api/doc-review.js
// AI contract review using Alibaba Cloud Bailian (qwen-max / qwen-plus)
// Compares generated SC/contract content against order DB data.
// POST { contractUrl, contractNo }
// Returns { ok, findings: [{level, field, note}], keyTerms, summary, riskScore }

import { getPool } from "./db.js";

const DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

async function callQwen(systemPrompt, userPrompt) {
  const res = await fetch(DASHSCOPE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.QWEN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "qwen-plus",          // cheap text model, no vision needed
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.1,            // low temp → deterministic extraction
    }),
  });
  if (!res.ok) throw new Error(`Qwen HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON in response: " + text.slice(0, 200));
  return JSON.parse(m[0]);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { contractUrl, contractNo } = req.body || {};
  if (!contractUrl && !contractNo) {
    return res.status(400).json({ error: "contractUrl or contractNo required" });
  }

  try {
    // ── 1. Fetch contract HTML ──────────────────────────────────────────
    const url = contractUrl ||
      `${process.env.API_BASE || "https://api.sanlyn.cn"}/api/db/documents?type=sc&id=${encodeURIComponent(contractNo)}`;
    const docRes = await fetch(url, { headers: { "User-Agent": "SanlynReview/1.0" } });
    if (!docRes.ok) throw new Error(`Could not fetch contract: HTTP ${docRes.status}`);
    const html = await docRes.text();

    // Strip HTML tags → plain text (keep content, drop markup)
    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 40000);   // qwen-plus 32k context, leave room for prompt

    // ── 2. Load order data from DB for comparison ───────────────────────
    let orderContext = "";
    if (contractNo) {
      const pool = getPool();
      const r = await pool.query(
        "SELECT raw FROM orders WHERE contract_no = $1 LIMIT 1",
        [contractNo]
      );
      if (r.rows.length) {
        const raw = r.rows[0].raw || {};
        orderContext = `
Order DB reference (ground truth):
- Contract No: ${contractNo}
- Customer PO: ${raw.customerPO || "—"}
- Product: ${raw.productName || "—"}
- Total Boxes: ${raw.totalBoxes || "—"}
- Total QTY: ${raw.totalQty || "—"}
- Unit Price: ${raw.unitPrice || "—"} ${raw.currency || "USD"}
- Total Amount: ${raw.totalAmount || "—"}
- Incoterms: ${raw.deliveryTerms || "—"}
- POL: ${raw.portOfLoading || "—"}
- POD: ${raw.portOfDischarge || "—"}
- Delivery Date: ${raw.deliveryDate || raw.actDelivery || "—"}
- Payment Terms: ${raw.paymentTerms || "—"}
- Seller Company: ${raw.issuingCompanyEN || "—"}
- Buyer Company: ${raw.companyNameEN || "—"}
`;
      }
    }

    // ── 3. Call Qwen ────────────────────────────────────────────────────
    const SYSTEM = `You are a trade document review assistant for Sanlyn OS, a supply chain platform.
Your job: extract key contract terms from a Sales Contract (SC) document, compare them against the
order database reference if provided, and identify any discrepancies or missing clauses.
Return ONLY valid JSON — no markdown, no extra text.`;

    const USER = `
Review this Sales Contract and return a JSON review report.

${orderContext}

Contract text:
${text}

Return exactly this JSON structure:
{
  "summary": "one-sentence description of what this contract is for",
  "parties": {
    "seller": "seller company name from contract",
    "buyer": "buyer company name from contract"
  },
  "keyTerms": {
    "contractNo": "contract/PI number from document",
    "product": "product name",
    "quantity": "total quantity with unit",
    "unitPrice": "unit price with currency",
    "totalAmount": "total amount with currency",
    "currency": "currency code",
    "incoterms": "delivery terms e.g. CIF / FOB",
    "portOfLoading": "POL",
    "portOfDischarge": "POD",
    "deliveryDate": "expected delivery date",
    "paymentTerms": "payment terms e.g. 30% deposit, 70% before shipment"
  },
  "findings": [
    {
      "level": "ok",
      "field": "Price",
      "note": "USD 18.50/unit — matches order"
    }
  ],
  "riskScore": "low",
  "missingClauses": ["list any standard clauses that appear to be missing"]
}

Finding levels:
- "ok": value present and matches DB reference
- "warn": value present but differs from DB, or is unusual
- "error": critical field missing or major mismatch (price, company name, qty)

If no DB reference is available, still extract all terms and flag any missing standard trade clauses.
Respond in English only.`;

    const result = await callQwen(SYSTEM, USER);

    return res.json({ ok: true, data: result, contractNo });

  } catch (err) {
    console.error("[doc-review] error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
