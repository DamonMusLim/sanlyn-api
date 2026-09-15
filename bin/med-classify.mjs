#!/usr/bin/env node
import fs from "node:fs";

const IN = arg("--in");
const OUT = arg("--out");
const API = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";
const BATCH = 15;

if (!IN || !OUT) {
  console.error("usage: med-classify.mjs --in input.json --out output.json");
  process.exit(2);
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY missing");
  process.exit(2);
}

function arg(name, def = "") {
  const eq = process.argv.find((x) => x.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function readRequiredArray(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    console.error(`INPUT_ERROR --in cannot read ${file}: ${e.message}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`INPUT_ERROR --in is not valid JSON ${file}: ${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(parsed)) {
    console.error(`INPUT_ERROR --in must be a JSON array ${file}`);
    process.exit(2);
  }
  return parsed;
}

function writeJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function timeoutSignal(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

const systemPrompt = `你是宠物店兽药合规分类器。只根据商品名、类目、规格判断:
处方药 = 含抗生素如阿莫西林/多西环素/恩诺沙星、激素、需兽医处方的,或品名/类目含「处方」。
非处方药 = 外用药、滴眼液、耳药、皮肤药、消炎护理等明确药品但非处方。
驱虫药 = 体内驱虫、体外驱虫、内外同驱、跳蚤蜱虫螨虫相关。
保健品 = 营养补充、益生菌、化毛膏、羊奶粉、关节软骨、鱼油、维生素等非药。
器械耗材 = 医疗器械、耗材、针管、棉签、伊丽莎白圈、手术服等。
不确定 = 信息不足、标题截断、无法可靠判断;confidence 必须小于 0.8。
forbid_marketing: 处方药/非处方药/驱虫药一律 true,其他按风险判断通常 false。
reason 不超过40字。只能输出 JSON: {"results":[{"product_code":"...","product_name":"...","rx_type":"处方药|非处方药|驱虫药|保健品|器械耗材|不确定","reason":"≤40字","confidence":0-1,"forbid_marketing":true|false}]}`;

function userPayload(batch) {
  return JSON.stringify({
    products: batch.map((x) => ({
      product_code: String(x.product_code || ""),
      product_name: String(x.product_name || ""),
      category_name: String(x.category_name || ""),
      spec: String(x.spec || "")
    }))
  });
}

async function callBatch(batch) {
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 3000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPayload(batch) }
    ]
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const timer = timeoutSignal(90000);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify(body),
        signal: timer.signal
      });
      timer.clear();
      if (!res.ok) throw new Error(`http_${res.status}`);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(text);
      return Array.isArray(parsed.results) ? parsed.results : [];
    } catch (e) {
      timer.clear();
      if (attempt === 2) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  return [];
}

function normalize(x, allowed) {
  const code = String(x.product_code || "");
  if (!allowed.has(code)) return null;
  const types = ["处方药", "非处方药", "驱虫药", "保健品", "器械耗材", "不确定"];
  const rxType = types.includes(x.rx_type) ? x.rx_type : "不确定";
  let confidence = Number(x.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  if (rxType === "不确定" && confidence >= 0.8) confidence = 0.79;
  return {
    product_code: code,
    product_name: String(x.product_name || "").slice(0, 120),
    rx_type: rxType,
    reason: String(x.reason || "信息不足").slice(0, 40),
    confidence,
    forbid_marketing: ["处方药", "非处方药", "驱虫药"].includes(rxType) ? true : Boolean(x.forbid_marketing)
  };
}

const input = readRequiredArray(IN);
const out = [];
let batches = 0;
let failed = 0;

for (const batch of chunks(input, BATCH)) {
  batches += 1;
  const allowed = new Set(batch.map((x) => String(x.product_code || "")));
  try {
    const rows = (await callBatch(batch)).map((x) => normalize(x, allowed)).filter(Boolean);
    const byCode = new Map(rows.map((x) => [x.product_code, x]));
    for (const p of batch) {
      const code = String(p.product_code || "");
      const row = byCode.get(code);
      if (row) out.push(row);
    }
  } catch {
    failed += 1;
  }
}

writeJson(OUT, out);
console.log(`input=${input.length}`);
console.log(`output=${out.length}`);
console.log(`api_batches=${batches}`);
console.log(`failed_batches=${failed}`);
