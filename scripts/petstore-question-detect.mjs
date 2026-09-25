import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const args = new Set(process.argv.slice(2));
const commit = args.has('--commit');
const dryRun = !commit;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const COUNT_ONLY_RE = /^\s*\d+(?:\.\d+)?\s*(盒|个|件|瓶|袋|包|罐|支|只|板|组|套|箱)\s*$/u;
const CAPACITY_RE = /\d+(?:\.\d+)?\s*(ml|mL|ML|Ml|毫升|l|L|g|G|克|kg|KG|Kg|千克)\b/u;
const PET_WEIGHT_RE = /\d+(?:\.\d+)?\s*(?:-|~|—|至|到)\s*\d+(?:\.\d+)?\s*(?:kg|KG|Kg|千克|公斤)\b/u;
const UNIT_TYPO_RE = /\b\d+(?:\.\d+)?\s*(mI|ML|Ml)\b/g;
// Claude 修：原来把整个 U+3000 区(CJK标点)都当异常，把正常的【】误报了 76 条。
// 实测：真·康熙部首/CJK部首补充污染 234 条（多为「适⼝性好」里的 ⼝ U+2F1D）。
// 只认这两个部首区，正常全角标点【】（）放过。
const BAD_CHAR_RE = /[\u2F00-\u2FDF\u2E80-\u2EFF]/u;

function normalizeUnit(value) {
  return String(value ?? '').replace(UNIT_TYPO_RE, (match) =>
    match.replace(/mI|ML|Ml/g, 'ml')
  );
}

function normalizeBadChars(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\u3000/g, ' ')
    .replace(/[〜〰]/g, '~')
    .replace(/[〡〢〣]/g, '');
}

function isBlank(value) {
  return String(value ?? '').trim() === '';
}

function hasPic(row) {
  return !isBlank(row.pic_url);
}

function targetStatus({ proposedValue, confidence, row }) {
  if (!isBlank(proposedValue) && confidence === '高') return 'pending_damon';
  if (hasPic(row)) return 'pending_ocr';
  return 'no_source';
}

function addQuestion(list, row, question) {
  const status = targetStatus({
    proposedValue: question.proposed_value,
    confidence: question.confidence,
    row,
  });

  list.push({
    product_code: row.product_code,
    field: question.field,
    question_type: question.question_type,
    current_value: question.current_value,
    proposed_value: isBlank(question.proposed_value) ? null : question.proposed_value,
    proposed_by: question.proposed_by ?? 'rule',
    confidence: question.confidence ?? null,
    evidence: question.evidence,
    status,
  });
}

function detectRow(row) {
  const questions = [];
  const spec = String(row.spec_text ?? '');
  const name = String(row.product_name ?? '');

  if (isBlank(spec)) {
    addQuestion(questions, row, {
      field: 'spec_text',
      question_type: 'SPEC_MISSING',
      current_value: row.spec_text,
      evidence: 'rule: spec_text blank',
    });
  }

  if (!isBlank(spec) && COUNT_ONLY_RE.test(spec) && !CAPACITY_RE.test(spec)) {
    addQuestion(questions, row, {
      field: 'spec_text',
      question_type: 'SPEC_ONLY_COUNT',
      current_value: row.spec_text,
      evidence: 'rule: spec_text only has package count, no capacity or weight',
    });
  }

  if (PET_WEIGHT_RE.test(name) && !CAPACITY_RE.test(spec)) {
    addQuestion(questions, row, {
      field: 'spec_text',
      question_type: 'PETWEIGHT_AS_SPEC',
      current_value: row.spec_text,
      evidence: `rule: product_name contains pet weight range: ${name.match(PET_WEIGHT_RE)?.[0] ?? ''}`,
    });
  }

  for (const [field, value] of [
    ['spec_text', spec],
    ['product_name', name],
  ]) {
    if (UNIT_TYPO_RE.test(value)) {
      UNIT_TYPO_RE.lastIndex = 0;
      addQuestion(questions, row, {
        field,
        question_type: 'UNIT_TYPO',
        current_value: value,
        proposed_value: normalizeUnit(value),
        proposed_by: 'rule',
        confidence: '高',
        evidence: 'rule: normalize mI/ML/Ml to ml',
      });
    }
    UNIT_TYPO_RE.lastIndex = 0;

    if (BAD_CHAR_RE.test(value)) {
      const normalized = normalizeBadChars(value);
      addQuestion(questions, row, {
        field,
        question_type: 'BAD_CHAR',
        current_value: value,
        proposed_value: normalized === value ? null : normalized,
        proposed_by: 'rule',
        confidence: normalized === value ? null : '高',
        evidence: 'rule: normalize Kangxi radicals or suspicious U+3000 block characters',
      });
    }
  }

  return questions;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query(`
      -- Claude 修：codex 编了 pei.product_code / pei.platform / pei.external_product_id
      -- 三个不存在的列（是我这轮 brief 漏了给正确 join）。真实结构：
      --   product_master 主键是 product_id，没有 product_code
      --   门店编码在 product_external_ids.external_product_code
      --   平台字段叫 source_system，值是 jelly_orange（下划线）
      SELECT DISTINCT ON (pei.external_product_code)
        pei.external_product_code AS product_code,
        COALESCE(NULLIF(pm.standard_product_name,''), pm.pos_product_name, '') AS product_name,
        COALESCE(NULLIF(pm.standard_spec,''), pm.pos_spec, '') AS spec_text,
        COALESCE(NULLIF(pm.brand,''), pm.pos_brand, '') AS brand,
        ops.pic_url
      FROM product_master pm
      JOIN product_external_ids pei
        ON pei.product_id = pm.product_id
       AND pei.is_current
       AND pei.source_system = 'jelly_orange'
      LEFT JOIN petstore_ops_row ops
        ON ops.product_code = pei.external_product_code
      ORDER BY pei.external_product_code, ops.pic_url NULLS LAST
    `);

    const questions = rows.flatMap(detectRow);
    let inserted = 0;

    for (const q of questions) {
      console.log([
        dryRun ? '[dry-run]' : '[commit]',
        q.product_code,
        q.field,
        q.question_type,
        `status=${q.status}`,
        `current=${q.current_value ?? ''}`,
        `proposed=${q.proposed_value ?? ''}`,
      ].join(' | '));

      if (!commit) continue;

      const result = await client.query(
        `
          INSERT INTO petstore_product_questions (
            product_code,
            field,
            question_type,
            current_value,
            proposed_value,
            proposed_by,
            confidence,
            evidence,
            status
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (product_code, field, question_type) DO NOTHING
        `,
        [
          q.product_code,
          q.field,
          q.question_type,
          q.current_value,
          q.proposed_value,
          q.proposed_by,
          q.confidence,
          q.evidence,
          q.status,
        ]
      );

      inserted += result.rowCount;
    }

    console.log(`扫描${rows.length}个商品，发现${questions.length}条疑问，写入${inserted}条。`);
    if (dryRun) console.log('当前为 --dry-run，未写库；加 --commit 才写 questions 表。');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
