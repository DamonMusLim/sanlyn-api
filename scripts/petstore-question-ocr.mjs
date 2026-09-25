import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const dryRun = !commit;
const limitArg = args.findIndex((arg) => arg === '--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 20;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

if (!process.env.MINIMAX_API_KEY) {
  console.error('MINIMAX_API_KEY is required');
  process.exit(1);
}

if (!Number.isInteger(limit) || limit <= 0) {
  console.error('--limit must be a positive integer');
  process.exit(1);
}

const MINIMAX_URL = 'https://api.minimaxi.com/anthropic/v1/messages';
const MODEL = 'MiniMax-M3';

const OCR_PROMPT = `你是商品包装图片OCR助手。请只读取图片上实际印着的文字，读不到就写 UNKNOWN，绝不编造、绝不根据常识补全。

必须把「适用宠物体重」与「商品规格」分开：
- 商品规格只写包装、容量、净含量、每盒/每包数量等，例如 0.75ml*3管/盒。
- 适用宠物体重只写宠物体重区间，例如 2.6-7.5kg。
- 不要把适用宠物体重当成商品规格。

只输出一个 JSON 对象，不要 Markdown，不要解释。字段固定为：
{
  "brand": "品牌或 UNKNOWN",
  "product_name": "品名或 UNKNOWN",
  "spec_text": "商品规格或 UNKNOWN",
  "pet_weight": "适用宠物体重或 UNKNOWN",
  "barcode": "条形码或 UNKNOWN",
  "confidence": "高/中/低",
  "raw_text": "你从图上读到的关键原文，读不到写 UNKNOWN"
}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUnknown(value) {
  const text = String(value ?? '').trim();
  return text === '' || /^UNKNOWN$/i.test(text);
}

function mediaTypeFromUrl(url, response) {
  const header = response.headers.get('content-type');
  if (header?.startsWith('image/')) return header.split(';')[0];
  if (/\.png(?:\?|$)/i.test(url)) return 'image/png';
  if (/\.webp(?:\?|$)/i.test(url)) return 'image/webp';
  return 'image/jpeg';
}

async function fetchImageAsBase64(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`image fetch failed ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    data: buffer.toString('base64'),
    mediaType: mediaTypeFromUrl(url, response),
  };
}

function extractText(responseJson) {
  const content = responseJson?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('\n')
      .trim();
  }
  return String(responseJson?.text ?? '').trim();
}

function parseModelJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('model response did not contain JSON');
    return JSON.parse(match[0]);
  }
}

async function callMiniMax({ imageBase64, mediaType }) {
  const response = await fetch(MINIMAX_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: OCR_PROMPT },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64,
              },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`MiniMax failed ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  const text = extractText(json);
  return {
    parsed: parseModelJson(text),
    raw: text,
  };
}

async function withRetries(fn) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

function pickSuggestion(question, parsed) {
  if (question.field === 'brand') return parsed.brand;
  if (question.field === 'product_name') return parsed.product_name;
  if (question.field === 'barcode') return parsed.barcode;
  return parsed.spec_text;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let processed = 0;
  let succeeded = 0;
  let unknown = 0;

  try {
    const { rows } = await client.query(
      `
        SELECT
          q.id,
          q.product_code,
          q.field,
          q.question_type,
          q.current_value,
          ops.pic_url
        FROM petstore_product_questions q
        JOIN petstore_ops_row ops
          ON ops.product_code = q.product_code
        WHERE q.status = 'pending_ocr'
          AND NULLIF(BTRIM(ops.pic_url), '') IS NOT NULL
        ORDER BY q.created_at, q.id
        LIMIT $1
      `,
      [limit]
    );

    for (const row of rows) {
      processed += 1;

      try {
        const image = await withRetries(() => fetchImageAsBase64(row.pic_url));
        const model = await withRetries(() =>
          callMiniMax({ imageBase64: image.data, mediaType: image.mediaType })
        );

        const suggestion = pickSuggestion(row, model.parsed);
        const nextStatus = isUnknown(suggestion) ? 'no_source' : 'pending_damon';
        const proposedValue = nextStatus === 'pending_damon' ? String(suggestion).trim() : null;
        const confidence = nextStatus === 'pending_damon'
          ? String(model.parsed.confidence ?? '中').trim()
          : null;
        const evidence = JSON.stringify({
          image_url: row.pic_url,
          model: MODEL,
          raw_response: model.raw,
        });

        if (nextStatus === 'pending_damon') succeeded += 1;
        else unknown += 1;

        console.log([
          row.product_code,
          `现值=${row.current_value ?? ''}`,
          `建议值=${proposedValue ?? 'UNKNOWN'}`,
          `置信度=${confidence ?? ''}`,
          `状态流转=pending_ocr -> ${nextStatus}`,
        ].join(' | '));

        if (!commit) continue;

        await client.query(
          `
            UPDATE petstore_product_questions
               -- Claude 修：$1 既裸用又进 CASE，Postgres 推不出统一类型
               -- （报 could not determine data type of parameter $1）。四个参数显式标 text。
               SET proposed_value = $1::text,
                   proposed_by = CASE WHEN $1::text IS NULL THEN proposed_by ELSE 'ocr' END,
                   confidence = $2::text,
                   evidence = $3::text,
                   status = $4::text
             WHERE id = $5
               AND status = 'pending_ocr'
          `,
          [proposedValue, confidence, evidence, nextStatus, row.id]
        );
      } catch (error) {
        console.error(`${row.product_code} | OCR失败 | ${error.message}`);
      }
    }

    console.log(`处理${processed}条，成功补${succeeded}条，UNKNOWN ${unknown}条。`);
    if (dryRun) console.log('当前为 --dry-run，未写库；加 --commit 才更新 questions 表。');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
