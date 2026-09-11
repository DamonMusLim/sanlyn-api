import fs from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;

const STORE_CODES = new Set(['63350001', '63350002', '63350003']);
const BATCH_SIZE = 500;
const apply = process.argv.includes('--apply');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function createPool() {
  return new Pool({
    host: requireEnv('PG_HOST'),
    port: Number(process.env.PG_PORT || 5432),
    database: requireEnv('PG_DATABASE'),
    user: requireEnv('PG_USER'),
    password: requireEnv('PG_PASSWORD'),
    max: 3,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=30000',
  });
}

function assertPayload(json) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(json.obs_date || '')) {
    throw new Error('拒绝: obs_date 必须是 YYYY-MM-DD');
  }
  if (!Array.isArray(json.rows)) {
    throw new Error('拒绝: rows 不是数组');
  }
  if (json.rows.length === 0) {
    throw new Error('拒绝: rows 为空数组');
  }

  const seen = new Set();
  const duplicates = new Set();

  for (const [index, row] of json.rows.entries()) {
    if (!STORE_CODES.has(row.store_code)) {
      throw new Error(`拒绝: 第 ${index + 1} 行 store_code 非法: ${row.store_code}`);
    }
    if (!Number.isInteger(row.price_fen) || row.price_fen <= 0) {
      throw new Error(`拒绝: 第 ${index + 1} 行 price_fen 必须是 >0 整数`);
    }
    if (!String(row.product_code || '').trim()) {
      throw new Error(`拒绝: 第 ${index + 1} 行 product_code 为空`);
    }

    const key = `${row.store_code}|${row.product_code}`;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }

  if (duplicates.size > 0) {
    throw new Error(`拒绝: rows 里有重复 store_code/product_code: ${[...duplicates].slice(0, 20).join(', ')}`);
  }
}

function storeDistribution(rows) {
  const counts = Object.fromEntries([...STORE_CODES].map((code) => [code, 0]));
  for (const row of rows) counts[row.store_code] += 1;
  return counts;
}

async function upsertBatch(client, obsDate, collectedAt, batch) {
  const columns = 9;
  const params = [];
  const placeholders = batch.map((row, rowIndex) => {
    const base = rowIndex * columns;
    params.push(
      obsDate,
      row.store_code,
      row.product_code,
      row.product_name || '',
      row.spec || '',
      row.barcode || null,
      row.price_fen,
      Boolean(row.in_stock),
      collectedAt,
    );
    return `(${Array.from({ length: columns }, (_, col) => `$${base + col + 1}`).join(',')})`;
  });

  const sql = `
    INSERT INTO petstore_price_observation
      (obs_date, store_code, product_code, product_name, spec, barcode, price_fen, in_stock, collected_at)
    VALUES ${placeholders.join(',')}
    ON CONFLICT (obs_date, store_code, product_code) DO UPDATE SET
      product_name=EXCLUDED.product_name,
      spec=EXCLUDED.spec,
      barcode=EXCLUDED.barcode,
      price_fen=EXCLUDED.price_fen,
      in_stock=EXCLUDED.in_stock,
      collected_at=EXCLUDED.collected_at
    RETURNING (xmax = 0) AS inserted
  `;

  const result = await client.query(sql, params);
  return result.rows.reduce(
    (counts, row) => {
      if (row.inserted) counts.inserted += 1;
      else counts.updated += 1;
      return counts;
    },
    { inserted: 0, updated: 0 },
  );
}

async function upsertObservations(client, obsDate, collectedAt, rows) {
  const counts = { inserted: 0, updated: 0 };

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batchCounts = await upsertBatch(client, obsDate, collectedAt, rows.slice(offset, offset + BATCH_SIZE));
    counts.inserted += batchCounts.inserted;
    counts.updated += batchCounts.updated;
  }

  return counts;
}

async function loadSpreadSummary(client) {
  const sql = `
    SELECT
      count(*)::int                                    AS all_three_count,
      count(*) FILTER (WHERE same_all)::int            AS all_three_same_count,
      count(*) FILTER (WHERE diff_fen > 0)::int        AS jinfang_more_expensive_count,
      count(*) FILTER (WHERE diff_fen < 0)::int        AS jinfang_cheaper_count
    FROM v_petstore_price_spread
  `;
  const { rows } = await client.query(sql);
  return rows[0];
}

async function runTransaction(pool, json) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const counts = await upsertObservations(client, json.obs_date, json.collected_at, json.rows);
    const summary = await loadSpreadSummary(client);

    if (apply) await client.query('COMMIT');
    else await client.query('ROLLBACK');

    return { ...counts, summary };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  let pool;

  try {
    const inputPath = process.argv[2];

    if (!inputPath) {
      console.error('Missing JSON file path');
      process.exitCode = 2;
      return;
    }

    const raw = await fs.readFile(inputPath, 'utf8');
    const json = JSON.parse(raw);
    assertPayload(json);

    pool = createPool();

    const result = await runTransaction(pool, json);
    const distribution = storeDistribution(json.rows);

    console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
    console.log(`rows=${json.rows.length}`);
    console.log(`inserted=${result.inserted}`);
    console.log(`updated=${result.updated}`);
    console.log(`by_store=${JSON.stringify(distribution)}`);
    console.log(`all_three_count=${result.summary.all_three_count}`);
    console.log(`all_three_same_count=${result.summary.all_three_same_count}`);
    console.log(`jinfang_more_expensive_count=${result.summary.jinfang_more_expensive_count}`);
    console.log(`jinfang_cheaper_count=${result.summary.jinfang_cheaper_count}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = process.exitCode || 1;
  } finally {
    if (pool) await pool.end();
  }
}

await main();
