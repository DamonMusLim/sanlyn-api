import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const isCommit = process.argv.includes('--commit');
const runMode = isCommit ? 'commit' : 'dry-run';

const TABLES = [
  {
    name: 'petstore_skus',
    columns: ['product_name', 'category', 'spec', 'supplier'],
  },
  {
    name: 'petstore_pricing_log',
    columns: [
      'product_name',
      'category',
      'spec',
      'supplier',
      'old_product_name',
      'new_product_name',
      'raw_product_name',
      'sku_name',
    ],
  },
];

const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');

function qident(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function backupName(table) {
  return `${table}_charnorm_backup_${today}`;
}

async function existingTextColumns(client, table, wantedColumns) {
  const res = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = ANY($2)
        AND data_type IN ('text', 'character varying', 'character')
      ORDER BY ordinal_position
    `,
    [table, wantedColumns],
  );
  return res.rows.map((row) => row.column_name);
}

function dirtyPredicate(columns) {
  return columns
    .map((column) => `${qident(column)} IS DISTINCT FROM petstore_normalize_text(${qident(column)})`)
    .join(' OR ');
}

async function scanTable(client, table, columns) {
  const predicate = dirtyPredicate(columns);
  const scanned = await client.query(`SELECT count(*)::int AS n FROM ${qident(table)}`);
  const dirty = await client.query(`SELECT count(*)::int AS n FROM ${qident(table)} WHERE ${predicate}`);

  const sampleSelects = columns
    .map(
      (column) => `
        SELECT
          ${JSON.stringify(table)}::text AS table_name,
          ${JSON.stringify(column)}::text AS column_name,
          ${qident(column)} AS before_value,
          petstore_normalize_text(${qident(column)}) AS after_value
        FROM ${qident(table)}
        WHERE ${qident(column)} IS DISTINCT FROM petstore_normalize_text(${qident(column)})
      `,
    )
    .join(' UNION ALL ');

  const samples = await client.query(`${sampleSelects} LIMIT 5`);
  return {
    scanned: scanned.rows[0].n,
    dirty: dirty.rows[0].n,
    samples: samples.rows,
  };
}

async function createBackup(client, table, columns) {
  const backup = backupName(table);
  const predicate = dirtyPredicate(columns);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${qident(backup)} AS SELECT * FROM ${qident(table)} WHERE ${predicate}`,
  );
  return backup;
}

async function updateTable(client, table, columns) {
  const assignments = columns
    .map((column) => `${qident(column)} = petstore_normalize_text(${qident(column)})`)
    .join(', ');
  const predicate = dirtyPredicate(columns);
  const res = await client.query(`UPDATE ${qident(table)} SET ${assignments} WHERE ${predicate}`);
  return res.rowCount;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new Client({ connectionString });
  await client.connect();

  console.log(`mode=${runMode}`);
  console.log('product_master will not be modified');

  try {
    await client.query('BEGIN');

    let totalScanned = 0;
    let totalDirty = 0;
    let totalChanged = 0;

    for (const tableSpec of TABLES) {
      const columns = await existingTextColumns(client, tableSpec.name, tableSpec.columns);
      if (columns.length === 0) {
        console.log(`${tableSpec.name}: no configured text columns found, skipped`);
        continue;
      }

      const scan = await scanTable(client, tableSpec.name, columns);
      totalScanned += scan.scanned;
      totalDirty += scan.dirty;

      console.log(`${tableSpec.name}: columns=${columns.join(', ')}`);
      console.log(`${tableSpec.name}: scanned=${scan.scanned} need_normalize=${scan.dirty}`);

      if (scan.samples.length > 0) {
        console.log(`${tableSpec.name}: samples`);
        for (const row of scan.samples) {
          console.log(`  [${row.column_name}] ${row.before_value} -> ${row.after_value}`);
        }
      }

      if (isCommit && scan.dirty > 0) {
        const backup = await createBackup(client, tableSpec.name, columns);
        console.log(`${tableSpec.name}: backup=${backup}`);
        const changed = await updateTable(client, tableSpec.name, columns);
        totalChanged += changed;
        console.log(`${tableSpec.name}: changed=${changed}`);
      }
    }

    console.log(`total: scanned=${totalScanned} need_normalize=${totalDirty} changed=${totalChanged}`);

    if (isCommit) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
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
