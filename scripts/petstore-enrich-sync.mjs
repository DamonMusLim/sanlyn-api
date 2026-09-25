import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';

import {
  SUPP_FIELDS,
  buildPlan,
  parseTsv,
} from './petstore-enrich-values.mjs';

const DEFAULT_INPUT = '/opt/rank-patrol-data/mini_enrich.tsv';

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    commit: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--commit') {
      args.commit = true;
    } else if (arg === '--dry-run') {
      args.commit = false;
    } else if (arg === '--input') {
      args.input = argv[++i];
    } else if (arg.startsWith('--input=')) {
      args.input = arg.slice('--input='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function loadTencent(client) {
  const [externalIds, supp, master, barcodeCount] = await Promise.all([
    client.query(`
      -- Claude 修：product_external_ids 的门店编码列名是 external_product_code
      SELECT external_product_code AS product_code, barcode
      FROM product_external_ids
      WHERE is_current = true AND source_system = 'jelly_orange'
    `),
    client.query(`
      SELECT product_code, brand, pet_type, shelf_life_days, expire_date_batch,
             compliance_status, shelf_location
      FROM petstore_sku_supp
    `),
    // Claude 修：product_master 没有 product_code 列（主键是 product_id），
    // 门店编码在 product_external_ids.external_product_code。今天第 4 次同一处错。
    client.query(`
      SELECT e.external_product_code AS product_code
      FROM product_master m
      JOIN product_external_ids e
        ON e.product_id = m.product_id AND e.is_current
      WHERE e.source_system = 'jelly_orange'
    `),
    client.query(`
      SELECT count(*)::int AS count
      FROM product_external_ids
      WHERE is_current = true
        AND source_system = 'jelly_orange'
        AND NULLIF(trim(barcode), '') IS NOT NULL
    `),
  ]);

  return {
    externalIds: externalIds.rows,
    supp: supp.rows,
    master: master.rows,
    barcodeNonempty: barcodeCount.rows[0].count,
  };
}

async function applyPlan(client, plan) {
  for (const row of plan.barcodeAdds) {
    await client.query(
      `
        -- Claude 修：写路径同样要用 external_product_code（dry-run 不执行所以没暴露）
        UPDATE product_external_ids
        SET barcode = $2
        WHERE external_product_code = $1
          AND is_current = true
          AND source_system = 'jelly_orange'
          AND NULLIF(trim(coalesce(barcode, '')), '') IS NULL
      `,
      [row.product_code, row.barcode],
    );
  }

  for (const row of plan.barcodeConflicts) {
    await client.query(
      `
        INSERT INTO petstore_sku_sync_conflicts
          (product_code, field, tencent_value, mini_value, resolution, note)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (product_code, field) DO UPDATE
        SET tencent_value = EXCLUDED.tencent_value,
            mini_value = EXCLUDED.mini_value,
            resolution = EXCLUDED.resolution,
            note = EXCLUDED.note,
            created_at = now()
      `,
      [
        row.product_code,
        row.field,
        row.tencent_value,
        row.mini_value,
        row.resolution,
        'pet-sku-enrich-sync-0816: barcode conflict; not auto-written',
      ],
    );
  }

  for (const row of plan.suppUpdates) {
    await client.query(
      `
        INSERT INTO petstore_sku_supp
          (product_code, brand, pet_type, shelf_life_days, expire_date_batch,
           compliance_status, shelf_location, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())
        ON CONFLICT (product_code) DO UPDATE
        SET brand = coalesce(petstore_sku_supp.brand, EXCLUDED.brand),
            pet_type = coalesce(petstore_sku_supp.pet_type, EXCLUDED.pet_type),
            shelf_life_days = coalesce(petstore_sku_supp.shelf_life_days, EXCLUDED.shelf_life_days),
            expire_date_batch = coalesce(petstore_sku_supp.expire_date_batch, EXCLUDED.expire_date_batch),
            compliance_status = coalesce(petstore_sku_supp.compliance_status, EXCLUDED.compliance_status),
            shelf_location = coalesce(petstore_sku_supp.shelf_location, EXCLUDED.shelf_location),
            synced_at = now()
      `,
      [
        row.product_code,
        row.brand ?? null,
        row.pet_type ?? null,
        row.shelf_life_days ?? null,
        row.expire_date_batch ?? null,
        row.compliance_status ?? null,
        row.shelf_location ?? null,
      ],
    );
  }

  for (const row of plan.imageUpdates) {
    await client.query(
      `
        -- Claude 修：同上，product_master 只能按 product_id 定位
        UPDATE product_master
        SET image_urls = $2,
            image_ocr_text = $3
        WHERE product_id = (
          SELECT product_id FROM product_external_ids
          WHERE external_product_code = $1
            AND is_current AND source_system = 'jelly_orange'
          LIMIT 1
        )
      `,
      [row.product_code, row.image_urls, row.image_ocr_text],
    );
  }
}

function printStats(plan, barcodeNonempty) {
  const expectedBarcodeNonempty = barcodeNonempty + plan.stats.barcode.addable;

  console.log(`mode: ${process.env.PETSTORE_SYNC_COMMIT === '1' ? 'commit' : 'dry-run'}`);
  console.log(`条码 可新增: ${plan.stats.barcode.addable}`);
  console.log(`条码 一致: ${plan.stats.barcode.consistent}`);
  console.log(`条码 冲突: ${plan.stats.barcode.conflict}`);
  console.log(`条码 冲突 keep_tencent: ${plan.stats.barcode.keep_tencent}`);
  console.log(`条码 冲突 prefer_mini: ${plan.stats.barcode.prefer_mini}`);
  console.log(`条码 冲突 needs_damon: ${plan.stats.barcode.needs_damon}`);

  for (const field of SUPP_FIELDS) {
    console.log(`${field} 可补: ${plan.stats.supp[field].fillable}`);
    if (field === 'shelf_life_days' || field === 'expire_date_batch') {
      console.log(`${field} 跳过脏值: ${plan.stats.supp[field].dirty}`);
    }
    console.log(`${field} 不一致: ${plan.stats.supp[field].inconsistent}`);
  }

  console.log(`图片 可写 image_urls: ${plan.stats.images.image_urls}`);
  console.log(`图片 可写 image_ocr_text: ${plan.stats.images.image_ocr_text}`);
  console.log(`预计写后 product_external_ids barcode 非空总数: ${expectedBarcodeNonempty}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.env.PETSTORE_SYNC_COMMIT = args.commit ? '1' : '0';

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const miniRows = parseTsv(await readFile(args.input, 'utf8'));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const tencent = await loadTencent(client);
    const plan = buildPlan(miniRows, tencent.externalIds, tencent.supp, tencent.master);
    printStats(plan, tencent.barcodeNonempty);

    if (!args.commit) return;

    await client.query('BEGIN');
    try {
      await applyPlan(client, plan);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
