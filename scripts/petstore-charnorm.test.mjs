import 'dotenv/config';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Client } = pg;

function qident(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function dummyValue(column) {
  const name = column.column_name;
  const type = column.data_type;

  if (name === 'product_name') return '测试适⼝性好';
  if (name === 'product_code' || name === 'sku_code' || name === 'barcode') {
    return `CHAR_NORM_TEST_${Date.now()}`;
  }
  if (type.includes('integer') || type === 'numeric' || type === 'double precision' || type === 'real') return 0;
  if (type === 'boolean') return false;
  if (type.includes('timestamp')) return new Date();
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  if (type === 'json' || type === 'jsonb') return {};
  return `charnorm_test_${name}`;
}

async function requiredInsertColumns(client) {
  const res = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'petstore_skus'
      AND is_nullable = 'NO'
      AND column_default IS NULL
      AND identity_generation IS NULL
      AND generation_expression IS NULL
    ORDER BY ordinal_position
  `);

  const names = new Set(res.rows.map((row) => row.column_name));
  if (!names.has('product_name')) {
    res.rows.push({ column_name: 'product_name', data_type: 'text' });
  }
  return res.rows;
}

async function scalar(client, sql, params = []) {
  const res = await client.query(sql, params);
  return Object.values(res.rows[0])[0];
}

async function normalizedByteHex(client, value) {
  return scalar(client, "SELECT encode(convert_to(petstore_normalize_text($1), 'SQL_ASCII'), 'hex') AS v", [
    value,
  ]);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');

    assert.equal(
      await scalar(client, 'SELECT petstore_normalize_text($1) AS v', ['适⼝性好']),
      '适口性好',
    );

    assert.equal(
      await scalar(client, 'SELECT petstore_normalize_text($1) AS v', ['适口性好']),
      '适口性好',
    );

    assert.equal(
      await scalar(client, 'SELECT petstore_normalize_text($1) AS v', ['（特惠商品）']),
      '（特惠商品）',
    );

    assert.equal(
      await scalar(client, 'SELECT petstore_normalize_text($1) AS v', ['A B']),
      'A B',
    );

    const cleanLongName = '皇家天然鲜牛犬鱼鸟鸡鸭鹅羊兔鹿肉食水毛粮草本营养均衡配方适口健康精选原料冻干益生元';
    const cleanLongNameHex = Buffer.from(cleanLongName, 'utf8').toString('hex');
    assert.equal(
      await scalar(client, 'SELECT petstore_normalize_text($1) AS v', [cleanLongName]),
      cleanLongName,
    );
    assert.equal(await normalizedByteHex(client, cleanLongName), cleanLongNameHex);

    assert.equal(
      await scalar(client, 'SELECT length(petstore_normalize_text($1)) AS v', ['适⼝性好']),
      Buffer.byteLength('适口性好', 'utf8'),
    );

    const columns = await requiredInsertColumns(client);
    const names = columns.map((column) => column.column_name);
    const values = columns.map(dummyValue);
    const placeholders = values.map((_, index) => `$${index + 1}`);

    const inserted = await client.query(
      `
        INSERT INTO petstore_skus (${names.map(qident).join(', ')})
        VALUES (${placeholders.join(', ')})
        RETURNING ctid::text AS tid, product_name
      `,
      values,
    );

    assert.equal(inserted.rows[0].product_name, '测试适口性好');

    const updated = await client.query(
      `
        UPDATE petstore_skus
        SET product_name = $1
        WHERE ctid = $2::tid
        RETURNING ctid::text AS tid, product_name
      `,
      ['再次适⼝性好', inserted.rows[0].tid],
    );

    assert.equal(updated.rows[0].product_name, '再次适口性好');

    await client.query('DELETE FROM petstore_skus WHERE ctid = $1::tid', [updated.rows[0].tid]);
    await client.query('ROLLBACK');
    console.log('petstore charnorm tests passed');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

