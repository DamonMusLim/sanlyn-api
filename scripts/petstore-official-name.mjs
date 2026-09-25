import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const MINIMAX_URL = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';
const MODEL = 'MiniMax-M3';
const MAX_TOKENS = 6000;

const PROMPT = `只从 OCR 文字里提取**印在包装上的**品牌与商品名，组合成官方品名
输出一行：官方品名=<值>|依据=<OCR原文片段>|置信度=<高/中/低>
⛔ OCR 里没有就输出 官方品名=UNKNOWN，绝不用商品名去猜、绝不编造
⛔ 不要把「适用宠物体重」「广告语」「促销词」当成品名的一部分
   （如"推荐用于2.6-7.5kg""适口性好""高蛋白"这些都不是品名）
⛔ 不要把规格写进品名（规格另有字段）`;

const args = parseArgs(process.argv.slice(2));
const dryRun = !args.commit;
const limit = args.limit ?? 50;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.MINIMAX_API_KEY) throw new Error('MINIMAX_API_KEY is required');

const client = new Client({ connectionString: process.env.DATABASE_URL });
const report = newReport();

try {
  await client.connect();

  const rows = await fetchTargets(client, limit);
  console.log(`mode=${dryRun ? 'dry-run' : 'commit'} limit=${limit} targets=${rows.length}`);

  for (const row of rows) {
    const extracted = await extractOfficialName(row.image_ocr_text);
    const official = extracted.officialName;
    const src = `ocr_text: ${extracted.evidence}; confidence=${extracted.confidence}`;

    if (official === 'UNKNOWN') report.unknown += 1;
    else report.success += 1;

    if (!dryRun) {
      await client.query(
        `UPDATE product_master
         SET official_name = $2,
             official_name_src = $3
         WHERE product_id = $1`,
        [row.product_id, official, src],
      );
    }

    addComparison(report, {
      code: row.product_code ?? String(row.product_id),
      ours: row.our_name ?? '',
      official,
    });

    console.log(`${row.product_code ?? row.product_id}: ${official}`);
  }

  printReport(report);
} finally {
  await client.end();
}

function parseArgs(argv) {
  const parsed = { commit: false, limit: undefined };

  for (const arg of argv) {
    if (arg === '--commit') parsed.commit = true;
    else if (arg === '--dry-run') parsed.commit = false;
    else if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      if (!Number.isInteger(value) || value < 1) throw new Error(`bad --limit: ${arg}`);
      parsed.limit = value;
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  return parsed;
}

async function fetchTargets(db, rowLimit) {
  const result = await db.query(
    `SELECT
       pm.product_id,
       pei.external_product_code AS product_code,
       COALESCE(NULLIF(pm.standard_product_name, ''), NULLIF(pm.pos_product_name, '')) AS our_name,
       pm.image_ocr_text
     FROM product_master pm
     LEFT JOIN LATERAL (
       SELECT external_product_code
       FROM product_external_ids pei
       WHERE pei.product_id = pm.product_id
         AND pei.is_current
       ORDER BY pei.last_seen_at DESC NULLS LAST, pei.id DESC
       LIMIT 1
     ) pei ON true
     WHERE NULLIF(pm.image_ocr_text, '') IS NOT NULL
       AND pm.official_name IS NULL
     ORDER BY pm.product_id
     LIMIT $1`,
    [rowLimit],
  );

  return result.rows;
}

async function extractOfficialName(ocrText) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: `OCR文字：\n${ocrText}` },
    ],
    temperature: 0,
    max_tokens: MAX_TOKENS,
  };

  const res = await fetch(MINIMAX_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`MiniMax HTTP ${res.status}: ${text}`);

  const data = JSON.parse(text);
  const choice = data.choices?.[0];
  const content = choice?.message?.content?.trim() ?? '';
  const finishReason = choice?.finish_reason ?? data.finish_reason;

  if (finishReason === 'length' && !content) {
    throw new Error('MiniMax returned finish_reason=length with empty content; keep max_tokens high');
  }

  return parseMiniMaxLine(content);
}

function parseMiniMaxLine(content) {
  const line = content.split(/\r?\n/).find((x) => x.includes('官方品名=')) ?? content;
  const officialName = pickField(line, '官方品名') || 'UNKNOWN';
  const evidence = pickField(line, '依据') || '';
  const confidence = pickField(line, '置信度') || '低';

  return {
    officialName: officialName.trim() || 'UNKNOWN',
    evidence: evidence.trim(),
    confidence: confidence.trim(),
  };
}

function pickField(line, key) {
  const re = new RegExp(`${key}=([^|]*)`);
  return line.match(re)?.[1]?.trim();
}

function newReport() {
  return {
    success: 0,
    unknown: 0,
    exact: 0,
    different: 0,
    buckets: {
      promo: [],
      ad: [],
      brand: [],
      spec: [],
      other: [],
    },
  };
}

function addComparison(report, item) {
  if (item.official === 'UNKNOWN') return;

  if (normalizeName(item.ours) === normalizeName(item.official)) {
    report.exact += 1;
    return;
  }

  report.different += 1;
  const bucket = classifyDifference(item.ours, item.official);
  if (report.buckets[bucket].length < 3) report.buckets[bucket].push(item);
}

function classifyDifference(ours, official) {
  if (hasOnlyInOurs(ours, official, /(临期特惠|特价|清仓|手慢无)/)) return 'promo';
  if (hasOnlyInOurs(ours, official, /(适口性好|高蛋白|爆款)/)) return 'ad';
  if (brandToken(ours) && brandToken(official) && brandToken(ours) !== brandToken(official)) return 'brand';
  if (hasOnlyInOurs(ours, official, /\d+(?:\.\d+)?\s*(?:g|kg|克|千克|斤|ml|mL|L|升|粒|片|支|管|包|袋|罐|盒|瓶)\b/i)) return 'spec';
  return 'other';
}

function hasOnlyInOurs(ours, official, re) {
  return re.test(ours ?? '') && !re.test(official ?? '');
}

function brandToken(name) {
  const cleaned = normalizeName(name);
  return cleaned.split(/\s+/)[0] || '';
}

function normalizeName(name) {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[|｜]/g, '')
    .trim()
    .toLowerCase();
}

function printReport(r) {
  console.log('\n比对报告');
  console.log(`提取成功数: ${r.success}`);
  console.log(`UNKNOWN 数: ${r.unknown}`);
  console.log(`完全一致: ${r.exact}`);
  console.log(`不一致: ${r.different}`);

  printBucket('我方多了促销词', r.buckets.promo);
  printBucket('我方多了广告语', r.buckets.ad);
  printBucket('品牌不一致', r.buckets.brand);
  printBucket('规格写进了品名', r.buckets.spec);
  printBucket('其它差异', r.buckets.other);
}

function printBucket(title, items) {
  console.log(`\n${title}: ${items.length}`);
  for (const item of items) {
    console.log(`- ${item.code} / 我方=${item.ours} / 官方=${item.official}`);
  }
}
