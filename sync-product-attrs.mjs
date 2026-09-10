#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { Pool } from 'pg';

const ENV_FILE = '/opt/sanlyn-api-test/.env';
const STRUCTURAL_ORDER_NOS = [
  '40-CP-2',
  '40-DG-2',
  '40-LL-3',
  '40-LL-4',
  '40-LL-5',
  '40-LL-6',
  '42-PBTYF-20260104',
  '48-CL-10',
];

const ATTR_FIELDS = [
  ['gw_ctn', 'gross_weight'],
  ['nw_ctn', 'net_weight'],
  ['cbm_ctn', 'cbm'],
  ['hs_code', 'hs_code'],
  ['declaration_name', 'declaration_name'],
  ['bl_description', 'bl_description'],
  ['size', 'size'],
  ['vat_rate', 'vat_rate'],
  ['tax_rebate_rate', 'rebate_rate'],
  ['product_name', 'product_name'],
  ['requires_quarantine_cert', 'quarantine_required'],
];

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!m || process.env[m[1]] != null) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

function yyyymmdd(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function flags() {
  const argv = new Set(process.argv.slice(2));
  return {
    dry: !argv.has('--commit'),
    commit: argv.has('--commit'),
    fixStructural: argv.has('--fix-structural'),
    help: argv.has('--help') || argv.has('-h'),
  };
}

const matchedCte = `
WITH ranked_products AS (
  SELECT
    oli.id AS oli_id,
    oli.order_id,
    oli.product_id,
    oli.barcode AS oli_barcode,
    oli.sku AS oli_sku,
    p.*,
    ROW_NUMBER() OVER (
      PARTITION BY oli.id
      ORDER BY
        CASE
          WHEN oli.product_id IS NOT NULL AND p.id = oli.product_id THEN 1
          WHEN NULLIF(oli.barcode, '') IS NOT NULL AND p.barcode = oli.barcode THEN 2
          WHEN NULLIF(oli.sku, '') IS NOT NULL AND p.sku = oli.sku THEN 3
          ELSE 9
        END,
        p.active DESC NULLS LAST,
        p.id
    ) AS rn
  FROM order_line_items oli
  LEFT JOIN products p
    ON (oli.product_id IS NOT NULL AND p.id = oli.product_id)
    OR (NULLIF(oli.barcode, '') IS NOT NULL AND p.barcode = oli.barcode)
    OR (NULLIF(oli.sku, '') IS NOT NULL AND p.sku = oli.sku)
),
matched AS (
  SELECT *
  FROM ranked_products
  WHERE rn = 1
)
`;

// 主表只填/纠正，绝不用 null 抹掉 OLI 已有的真值(否则报关品名会被清空)。只在主表有值且不同才算漂移。
const driftWhere = ATTR_FIELDS.map(([oli, prod]) => `(m.${prod} IS NOT NULL AND oli.${oli} IS DISTINCT FROM m.${prod})`).join('\n       OR ');

async function getOrphanRows(client) {
  const { rows } = await client.query(`
    ${matchedCte}
    SELECT
      oli.id,
      oli.order_id,
      o.order_no,
      oli.product_id,
      oli.barcode,
      oli.sku,
      oli.product_name
    FROM order_line_items oli
    JOIN orders o ON o.id = oli.order_id
    LEFT JOIN matched m ON m.oli_id = oli.id
    WHERE m.id IS NULL
    ORDER BY o.order_no NULLS LAST, oli.id
  `);
  return rows;
}

async function getAttrDiffSummary(client) {
  const pieces = ATTR_FIELDS.map(([oli, prod]) => `
    SELECT
      '${oli}' AS field,
      oli.${oli}::text AS old_value,
      m.${prod}::text AS new_value,
      COUNT(*)::int AS rows,
      COUNT(DISTINCT oli.order_id)::int AS orders
    FROM order_line_items oli
    JOIN matched m ON m.oli_id = oli.id AND m.id IS NOT NULL
    WHERE m.${prod} IS NOT NULL AND oli.${oli} IS DISTINCT FROM m.${prod}
    GROUP BY oli.${oli}::text, m.${prod}::text
  `).join('\nUNION ALL\n');

  const { rows } = await client.query(`
    ${matchedCte}
    ${pieces}
    ORDER BY field, rows DESC, old_value NULLS FIRST, new_value NULLS FIRST
  `);
  return rows;
}

async function getAffectedOrders(client, fixStructural) {
  const structuralFilter = fixStructural ? `OR o.order_no = ANY($1::text[])` : '';
  const params = fixStructural ? [STRUCTURAL_ORDER_NOS] : [];
  const { rows } = await client.query(`
    ${matchedCte}
    SELECT DISTINCT oli.order_id, o.order_no
    FROM order_line_items oli
    JOIN orders o ON o.id = oli.order_id
    JOIN matched m ON m.oli_id = oli.id AND m.id IS NOT NULL
    WHERE ${driftWhere}
       ${structuralFilter}
    ORDER BY o.order_no NULLS LAST, oli.order_id
  `, params);
  return rows;
}

async function getStructuralOrphans(client) {
  const { rows } = await client.query(`
    SELECT
      o.id AS order_id,
      o.order_no,
      op.elem->>'barcode' AS barcode,
      op.elem->>'sku' AS sku,
      op.elem->>'code' AS code,
      op.elem->>'name' AS name,
      op.ord::int AS products_index
    FROM orders o
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.products, '[]'::jsonb)) WITH ORDINALITY AS op(elem, ord)
    WHERE o.order_no = ANY($1::text[])
      AND NOT EXISTS (
        SELECT 1
        FROM order_line_items oli
        WHERE oli.order_id = o.id
          AND (
            (NULLIF(op.elem->>'barcode', '') IS NOT NULL AND oli.barcode = op.elem->>'barcode')
            OR (NULLIF(op.elem->>'sku', '') IS NOT NULL AND oli.sku = op.elem->>'sku')
            OR (NULLIF(op.elem->>'code', '') IS NOT NULL AND oli.sku = op.elem->>'code')
          )
      )
    ORDER BY o.order_no, op.ord
  `, [STRUCTURAL_ORDER_NOS]);
  return rows;
}

async function updateOliAttrs(client) {
  const setSql = ATTR_FIELDS.map(([oli, prod]) => `${oli} = COALESCE(m.${prod}, oli.${oli})`).join(',\n        ');
  const { rowCount } = await client.query(`
    ${matchedCte}
    UPDATE order_line_items oli
    SET
        ${setSql},
        updated_at = NOW()
    FROM matched m
    WHERE m.oli_id = oli.id
      AND m.id IS NOT NULL
      AND (${driftWhere})
  `);
  return rowCount;
}

async function backupOrdersProducts(client, orderIds, backupKey) {
  if (!orderIds.length) return 0;
  const { rowCount } = await client.query(`
    UPDATE orders
    SET raw = jsonb_set(
      COALESCE(raw, '{}'::jsonb),
      ARRAY[$2],
      CASE
        WHEN COALESCE(raw, '{}'::jsonb) ? $2 THEN COALESCE(raw, '{}'::jsonb)->$2
        ELSE to_jsonb(products)
      END,
      true
    )
    WHERE id = ANY($1::int[])
  `, [orderIds, backupKey]);
  return rowCount;
}

async function rebuildOrdersProducts(client, orderIds) {
  if (!orderIds.length) return 0;
  const { rowCount } = await client.query(`
    ${matchedCte},
    rebuilt AS (
      SELECT
        oli.order_id,
        jsonb_agg(
          jsonb_build_object(
            'sku', COALESCE(m.sku, oli.sku),
            'code', COALESCE(m.sku, oli.sku),
            'barcode', COALESCE(m.barcode, oli.barcode),
            'name', COALESCE(m.product_name, oli.product_name),
            'size', COALESCE(m.size, oli.size),
            'unit', COALESCE(m.unit, oli.unit),
            'brand', oli.brand,
            'hsCode', COALESCE(m.hs_code, oli.hs_code),
            'qty', oli.qty_ctn,
            'netWeight', COALESCE(m.net_weight, oli.nw_ctn),
            'grossWeight', COALESCE(m.gross_weight, oli.gw_ctn),
            'cbm', COALESCE(m.cbm, oli.cbm_ctn),
            'totalCbm', oli.qty_ctn * COALESCE(m.cbm, oli.cbm_ctn),
            'factoryPrice', COALESCE(oli.factory_price, m.factory_price),
            'factorySubtotal', oli.qty_ctn * COALESCE(oli.factory_price, m.factory_price),
            'unitPrice', oli.unit_price,
            'subtotal', oli.qty_ctn * oli.unit_price,
            'declarationName', COALESCE(m.declaration_name, oli.declaration_name),
            'blDescription', COALESCE(m.bl_description, oli.bl_description),
            'vatRate', COALESCE(m.vat_rate, oli.vat_rate),
            'taxRebateRate', COALESCE(m.rebate_rate, oli.tax_rebate_rate),
            'bgBx', COALESCE(m.bg_bx, oli.bg_bx::text),
            'sortOrder', oli.sort_order,
            'orderLineItemId', oli.id,
            'productId', m.id,
            'isOrphan', (m.id IS NULL)
          )
          ORDER BY oli.sort_order NULLS LAST, oli.id
        ) AS products
      FROM order_line_items oli
      LEFT JOIN matched m ON m.oli_id = oli.id
      WHERE oli.order_id = ANY($1::int[])
      GROUP BY oli.order_id
    )
    UPDATE orders o
    SET products = rebuilt.products
    FROM rebuilt
    WHERE rebuilt.order_id = o.id
  `, [orderIds]);
  return rowCount;
}

function printRows(title, rows, limit = 80) {
  console.log(`\n${title}: ${rows.length}`);
  for (const r of rows.slice(0, limit)) console.log(JSON.stringify(r));
  if (rows.length > limit) console.log(`... ${rows.length - limit} more`);
}

async function main() {
  const opt = flags();
  if (opt.help) {
    console.log('Usage: node sync-product-attrs.mjs [--dry] [--commit] [--fix-structural]');
    process.exit(0);
  }

  loadEnv(ENV_FILE);
  if (!process.env.DATABASE_URL) throw new Error(`DATABASE_URL missing; expected in ${ENV_FILE}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const orphanRows = await getOrphanRows(client);
    const diffSummary = await getAttrDiffSummary(client);
    const structuralOrphans = opt.fixStructural ? await getStructuralOrphans(client) : [];

    printRows('OLI orphan rows: no product_id/barcode/sku match in products; not guessed, not updated', orphanRows);
    printRows('Attribute changes old -> new grouped by field/value', diffSummary);
    if (opt.fixStructural) {
      printRows('Structural orders products-only orphan rows; marked only, not deleted', structuralOrphans);
    }

    const affectedOrders = await getAffectedOrders(client, opt.fixStructural);
    printRows('Orders to rebuild from OLI + products master', affectedOrders);

    if (opt.dry) {
      console.log('\nDRY RUN ONLY. No writes performed. Re-run with --commit after reviewing orphan rows and changes.');
      return;
    }

    await client.query('BEGIN');
    const backupKey = `_products_bak_${yyyymmdd()}`;
    const orderIds = affectedOrders.map(r => r.order_id);

    const backedUp = await backupOrdersProducts(client, orderIds, backupKey);
    const updatedOliRows = await updateOliAttrs(client);
    const rebuiltOrders = await rebuildOrdersProducts(client, orderIds);

    await client.query('COMMIT');

    console.log(JSON.stringify({
      committed: true,
      backupKey,
      backedUpOrders: backedUp,
      updatedOliRows,
      rebuiltOrders,
      affectedOrders: orderIds.length,
      orphanRows: orphanRows.length,
      structuralProductsOnlyOrphans: structuralOrphans.length,
      invariant: 'qty_ctn was never updated; orders.products.qty was rebuilt from OLI qty_ctn',
    }, null, 2));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
