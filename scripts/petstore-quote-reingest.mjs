#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Client } from 'pg';
import { QTY_RE, buildProduct, isTitleTruncated, parseQty } from './petstore-quote-parse.mjs';
import {
  STATUS_VALUES,
  calculateExcludeReason,
  isComparable,
  matchQuote,
} from './petstore-quote-match.mjs';

export const STORE_CODE = '63350001';
export const SOURCE = 'meituan_local';
export const SOURCE_TIER = '本地外卖';
export const RULE_VERSION = 'truth_exclusion_v2026.08.16-1';

const QUOTE_FILES = [
  ['linxiaohu_mp.jsonl', '邻小虎'],
  ['hani_mp.jsonl', '哈妮'],
  ['chongzz_mp.jsonl', '宠壮壮'],
  ['aishang_mp.jsonl', '爱尚宠家'],
  ['duoen_mp.jsonl', '多恩'],
];

function norm(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '');
}

function parseMoney(value) {
  if (value == null || value === '') return null;
  const match = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function parseInteger(value) {
  if (value == null || value === '') return null;
  const match = String(value).replace(/,/g, '').match(/-?\d+/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function rowValue(row, names) {
  for (const name of names) {
    if (row[name] != null && row[name] !== '') return row[name];
  }
  return null;
}

export async function loadProducts(client) {
  const { rows } = await client.query(`
    SELECT e.external_product_code AS product_code,
           m.standard_product_name,
           m.pos_product_name,
           m.brand,
           m.pos_brand,
           m.standard_spec,
           m.pos_spec
    FROM product_master m
    JOIN product_external_ids e
      ON e.product_id = m.product_id AND e.is_current
    WHERE e.source_system = 'jelly_orange'
  `);
  return rows.map(buildProduct).filter((p) => p.product_code && p.qty_g != null);
}

function normalizeQuoteRow(row) {
  const title = String(rowValue(row, ['title', '商品名称', 'name', 'product_name']) || '').trim();
  return {
    title,
    price: parseMoney(rowValue(row, ['price', '到手价', '售价', 'sale_price'])),
    orig_price: parseMoney(rowValue(row, ['orig_price', '原价', '划线价', 'original_price'])),
    monthly_sales: parseInteger(rowValue(row, ['monthly_sales', '月销量', 'sales'])),
    captured_at: parseDate(rowValue(row, ['captured_at', '采集时间', 'created_at'])) || new Date(),
    source_tier: String(rowValue(row, ['source_tier', '店铺层级', 'tier']) || ''),
    competitor_name: String(rowValue(row, ['competitor_name', '店铺名', 'shop_name']) || ''),
    raw_key: String(rowValue(row, ['raw_key', 'id', 'item_id']) || ''),
    raw_payload: row,
  };
}

function readJsonlQuotes() {
  const dir = process.env.RANK_PATROL_DIR || path.join(os.homedir(), 'rank-patrol');
  const out = [];
  for (const [file, competitorName] of QUOTE_FILES) {
    const filePath = path.join(dir, file);
    const capturedAt = fs.statSync(filePath).mtime;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const price = parseMoney(row.price);
      const sold = parseInteger(row.sold);
      out.push({
        title: String(row.name || '').trim(),
        price: price == null ? parseMoney(row.first_item) : price,
        orig_price: parseMoney(row.orig),
        monthly_sales: sold == null ? null : Math.min(sold, 100),
        captured_at: capturedAt,
        source_tier: SOURCE_TIER,
        competitor_name: competitorName,
        raw_key: '',
        raw_payload: row,
      });
    }
  }
  return out;
}

function dedupeQuotes(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row.title) continue;
    const key = [norm(row.title), row.price, row.orig_price, row.monthly_sales, row.competitor_name].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function pct(n, d) {
  return d === 0 ? '0.00%' : `${((n / d) * 100).toFixed(2)}%`;
}

function sqlIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function batchDate(batchId) {
  const compact = String(batchId).match(/(\d{8})/);
  if (compact) return compact[1];
  const dashed = String(batchId).match(/(\d{4})[.-](\d{2})[.-](\d{2})/);
  if (dashed) return `${dashed[1]}${dashed[2]}${dashed[3]}`;
  throw new Error(`batch_id must contain a date: ${batchId}`);
}

function defaultBatchId() {
  return `reingest-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-1`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const argSet = new Set(args);
  const batchIdIndex = args.indexOf('--batch-id');
  return {
    commit: argSet.has('--commit'),
    batchId: batchIdIndex >= 0 && args[batchIdIndex + 1] ? args[batchIdIndex + 1] : defaultBatchId(),
  };
}

async function insertRaw(client, batchId, quote, match) {
  await client.query(
    `INSERT INTO petstore_market_quotes_raw
      (batch_id, source, source_tier, competitor_name, raw_key, title, price, orig_price,
       monthly_sales, captured_at, qty_g, product_code, match_status, match_rule,
       match_confidence, parsed_brand, parsed_unit_count, parsed_unit_qty_g,
       parsed_flavors, is_title_truncated, raw_payload)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      batchId,
      SOURCE,
      quote.source_tier,
      quote.competitor_name,
      quote.raw_key,
      quote.title,
      quote.price,
      quote.orig_price,
      quote.monthly_sales,
      quote.captured_at,
      match.qty_g,
      match.product_code,
      match.match_status,
      match.match_rule,
      match.match_confidence,
      match.parsed_brand,
      match.parsed_unit_count,
      match.parsed_unit_qty_g,
      match.parsed_flavors == null ? null : [...match.parsed_flavors],
      match.is_title_truncated,
      JSON.stringify(quote.raw_payload),
    ],
  );
}

async function insertMatchedQuote(client, batchId, quote, match, baseNow) {
  const excludeReason = calculateExcludeReason({ ...quote, qty_g: match.qty_g }, baseNow);
  const specText = match.spec_text ?? String(quote.title || '').match(QTY_RE)?.[0] ?? null;
  const { rows } = await client.query(
    `INSERT INTO petstore_market_quotes
      (product_code, source, source_tier, store_name, matched_title, spec_text,
       price, orig_price, monthly_sales, captured_at, qty_g, unit_price,
       match_conf, exclude_reason, is_comparable, rule_version)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
       CASE WHEN $11::numeric > 0 AND $7::numeric IS NOT NULL THEN $7::numeric / ($11::numeric / 1000) ELSE NULL END,
       'high',$12,$13,$14)
     RETURNING id, product_code, store_name, source_tier, price, orig_price, spec_text,
       qty_g, unit_price, monthly_sales, match_conf, captured_at, is_comparable,
       exclude_reason, rule_version`,
    [
      match.product_code,
      SOURCE,
      quote.source_tier,
      quote.competitor_name,
      quote.title,
      specText,
      quote.price,
      quote.orig_price,
      quote.monthly_sales,
      quote.captured_at,
      match.qty_g,
      excludeReason,
      isComparable(excludeReason),
      RULE_VERSION,
    ],
  );
  return rows[0];
}

export async function appendHistoryAndChangeEvent(client, quoteRow) {
  const prev = (await client.query(
    `SELECT id, quote_id, price, captured_at
     FROM petstore_market_quote_history
     WHERE product_code = $1
       AND rule_version = $2
       AND captured_at::date < $3::date
       AND COALESCE(store_name, '') = COALESCE($4, '')
       AND COALESCE(spec_text, '') = COALESCE($5, '')
     ORDER BY captured_at DESC, id DESC
     LIMIT 1`,
    [quoteRow.product_code, quoteRow.rule_version, quoteRow.captured_at, quoteRow.store_name, quoteRow.spec_text],
  )).rows[0] || null;

  const insertedHistory = await client.query(
    `INSERT INTO petstore_market_quote_history
      (product_code, quote_id, store_name, source_tier, price, orig_price, spec_text,
       qty_g, unit_price, monthly_sales, match_conf, captured_at, is_comparable,
       exclude_reason, rule_version, day_key)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14,$15,$12::date)
     ON CONFLICT (product_code, COALESCE(store_name, ''), COALESCE(spec_text, ''), day_key) DO NOTHING`,
    [
      quoteRow.product_code,
      quoteRow.id,
      quoteRow.store_name,
      quoteRow.source_tier,
      quoteRow.price,
      quoteRow.orig_price,
      quoteRow.spec_text,
      quoteRow.qty_g,
      quoteRow.unit_price,
      quoteRow.monthly_sales,
      quoteRow.match_conf,
      quoteRow.captured_at,
      quoteRow.is_comparable,
      quoteRow.exclude_reason,
      quoteRow.rule_version,
    ],
  );

  if (insertedHistory.rowCount === 0) return null;

  if (!prev) {
    await client.query(
      `INSERT INTO petstore_market_change_events
        (product_code, store_name, change_type, old_value, new_value, delta, delta_pct,
         from_quote_id, to_quote_id, from_captured_at, to_captured_at, rule_version)
       VALUES ($1,$2,'NEW_LISTING',NULL,$3,NULL,NULL,NULL,$4,NULL,$5,$6)`,
      [quoteRow.product_code, quoteRow.store_name, quoteRow.price, quoteRow.id, quoteRow.captured_at, quoteRow.rule_version],
    );
    return 'NEW_LISTING';
  }

  if (prev.price == null || quoteRow.price == null || Number(prev.price) === Number(quoteRow.price)) return null;

  const delta = Number(quoteRow.price) - Number(prev.price);
  const changeType = delta > 0 ? 'PRICE_UP' : 'PRICE_DOWN';
  const deltaPct = Number(prev.price) === 0 ? null : (delta / Number(prev.price)) * 100;
  await client.query(
    `INSERT INTO petstore_market_change_events
      (product_code, store_name, change_type, old_value, new_value, delta, delta_pct,
       from_quote_id, to_quote_id, from_captured_at, to_captured_at, rule_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      quoteRow.product_code,
      quoteRow.store_name,
      changeType,
      prev.price,
      quoteRow.price,
      delta,
      deltaPct,
      prev.quote_id,
      quoteRow.id,
      prev.captured_at,
      quoteRow.captured_at,
      quoteRow.rule_version,
    ],
  );
  return changeType;
}

async function backupAndDeleteOld(client, batchId) {
  const backupTable = sqlIdent(`petstore_market_quotes_bak_${batchDate(batchId)}`);
  const before = Number((await client.query(
    'SELECT count(*)::int AS n FROM petstore_market_quotes WHERE source = $1',
    [SOURCE],
  )).rows[0].n);
  await client.query(`DROP TABLE IF EXISTS ${backupTable}`);
  await client.query(
    `CREATE TABLE ${backupTable} AS SELECT * FROM petstore_market_quotes WHERE source = $1`,
    [SOURCE],
  );
  const backedUp = Number((await client.query(`SELECT count(*)::int AS n FROM ${backupTable}`)).rows[0].n);
  const deleted = Number((await client.query(
    'DELETE FROM petstore_market_quotes WHERE source = $1 RETURNING 1',
    [SOURCE],
  )).rowCount);
  console.log(`delete_pre_count=${before} backup_count=${backedUp} delete_count=${deleted}`);
  if (before !== backedUp || before !== deleted) {
    throw new Error(`backup/delete mismatch: before=${before} backup=${backedUp} deleted=${deleted}`);
  }
}

async function main() {
  const { commit, batchId } = parseArgs(process.argv);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');
    const baseNow = (await client.query('SELECT now() AS now')).rows[0].now;
    const products = await loadProducts(client);
    const rawRows = readJsonlQuotes().map(normalizeQuoteRow);
    const quotes = dedupeQuotes(rawRows);
    const stats = Object.fromEntries(STATUS_VALUES.map((s) => [s, 0]));
    const changeStats = { PRICE_UP: 0, PRICE_DOWN: 0, NEW_LISTING: 0 };
    const matchRuleStats = {};
    const matchedProductCodes = new Set();
    const truncatedCount = quotes.filter((q) => isTitleTruncated(q.title)).length;
    const specParsedCount = quotes.filter((q) => parseQty(q.title) != null).length;

    console.log(`store=${STORE_CODE} source=${SOURCE} dry_run=${!commit} raw=${rawRows.length} deduped=${quotes.length} products=${products.length}`);
    console.log(`dedupe_before=${rawRows.length} dedupe_after=${quotes.length} dedupe_removed=${rawRows.length - quotes.length}`);
    console.log(`title_truncated=${truncatedCount} title_truncated_pct=${pct(truncatedCount, quotes.length)}`);
    console.log(`spec_parsed=${specParsedCount} spec_parsed_pct=${pct(specParsedCount, quotes.length)}`);

    if (commit) await backupAndDeleteOld(client, batchId);

    for (const quote of quotes) {
      const match = matchQuote(quote, products);
      stats[match.match_status] += 1;
      if (match.match_status === 'MATCHED') {
        matchedProductCodes.add(match.product_code);
        matchRuleStats[match.match_rule] = (matchRuleStats[match.match_rule] || 0) + 1;
      }
      await insertRaw(client, batchId, quote, match);
      if (match.match_status === 'MATCHED') {
        const quoteRow = await insertMatchedQuote(client, batchId, quote, match, baseNow);
        const changeType = await appendHistoryAndChangeEvent(client, quoteRow);
        if (changeType && changeStats[changeType] != null) changeStats[changeType] += 1;
      }
    }

    console.log(JSON.stringify(stats, null, 2));
    console.log(`match_rule: ${Object.entries(matchRuleStats).map(([rule, count]) => `${rule}=${count}`).join(' ')}`);
    console.log(`matched_distinct_product_code=${matchedProductCodes.size}`);
    console.log(`change_events: PRICE_UP=${changeStats.PRICE_UP} PRICE_DOWN=${changeStats.PRICE_DOWN} NEW_LISTING=${changeStats.NEW_LISTING}`);

    if (commit) {
      await client.query('COMMIT');
      console.log(`committed batch_id=${batchId}`);
    } else {
      await client.query('ROLLBACK');
      console.log(`dry-run rolled back batch_id=${batchId}`);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
