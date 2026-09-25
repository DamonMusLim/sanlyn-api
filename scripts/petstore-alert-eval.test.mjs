#!/usr/bin/env node
import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import { compareObserved, evaluateAlertRules } from './petstore-alert-eval.mjs';

async function withClient(fn) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

async function installTempMarketObjects(client) {
  await client.query(`
    CREATE TEMP TABLE petstore_market_quotes (
      id bigserial PRIMARY KEY,
      product_code text NOT NULL,
      store_name text,
      price numeric,
      captured_at timestamptz,
      rule_version text NOT NULL
    ) ON COMMIT DROP;

    CREATE TEMP TABLE petstore_market_quote_history (
      id bigserial PRIMARY KEY,
      product_code text NOT NULL,
      quote_id bigint,
      store_name text,
      price numeric,
      captured_at timestamptz,
      rule_version text NOT NULL,
      day_key date
    ) ON COMMIT DROP;

    CREATE TEMP TABLE petstore_market_change_events (
      id bigserial PRIMARY KEY,
      product_code text NOT NULL,
      store_name text,
      change_type text NOT NULL,
      old_value numeric,
      new_value numeric,
      delta numeric,
      delta_pct numeric,
      from_quote_id bigint,
      to_quote_id bigint,
      from_captured_at timestamptz,
      to_captured_at timestamptz,
      rule_version text NOT NULL,
      detected_at timestamptz NOT NULL DEFAULT now()
    ) ON COMMIT DROP;

    CREATE TEMP VIEW petstore_market_quote_change_current AS
    SELECT
      q.id AS quote_id,
      prev.quote_id AS prev_quote_id,
      prev.price AS market_price_prev,
      CASE WHEN prev.price IS NULL THEN NULL ELSE round((q.price - prev.price)::numeric, 2) END AS market_price_delta,
      CASE
        WHEN prev.price IS NULL OR prev.price = 0 THEN NULL
        ELSE round(((q.price - prev.price) / prev.price * 100.0)::numeric, 2)
      END AS market_price_delta_pct,
      CASE
        WHEN prev.price IS NULL THEN NULL
        WHEN q.price = prev.price THEN (q.captured_at::date - prev.captured_at::date)::integer
        ELSE 0
      END AS market_days_unchanged
    FROM petstore_market_quotes q
    LEFT JOIN LATERAL (
      SELECT h.quote_id, h.price, h.captured_at
      FROM petstore_market_quote_history h
      WHERE h.product_code = q.product_code
        AND h.rule_version = q.rule_version
        AND h.captured_at::date < q.captured_at::date
      ORDER BY h.captured_at DESC, h.id DESC
      LIMIT 1
    ) prev ON true;

    CREATE TEMP VIEW petstore_ops_row AS
    SELECT
      q.product_code,
      q.price AS market_price,
      q.store_name AS market_store,
      q.captured_at AS market_captured_at,
      ch.market_price_prev,
      ch.market_price_delta,
      ch.market_price_delta_pct,
      ch.market_days_unchanged
    FROM petstore_market_quotes q
    LEFT JOIN petstore_market_quote_change_current ch ON ch.quote_id = q.id;
  `);
}

async function runTempChangeDetector(client, quoteId) {
  await client.query(
    `WITH cur AS (
       SELECT * FROM petstore_market_quotes WHERE id = $1
     ),
     prev AS (
       SELECT h.*
       FROM petstore_market_quote_history h
       JOIN cur q ON q.product_code = h.product_code
        AND q.rule_version = h.rule_version
        AND h.captured_at::date < q.captured_at::date
       ORDER BY h.captured_at DESC, h.id DESC
       LIMIT 1
     )
     INSERT INTO petstore_market_change_events
       (product_code, store_name, change_type, old_value, new_value, delta, delta_pct,
        from_quote_id, to_quote_id, from_captured_at, to_captured_at, rule_version)
     SELECT
       q.product_code,
       q.store_name,
       CASE
         WHEN p.id IS NULL THEN 'NEW_LISTING'
         WHEN q.price > p.price THEN 'PRICE_UP'
         ELSE 'PRICE_DOWN'
       END AS change_type,
       p.price AS old_value,
       q.price AS new_value,
       CASE WHEN p.id IS NULL THEN NULL ELSE q.price - p.price END AS delta,
       CASE WHEN p.id IS NULL OR p.price IS NULL OR p.price = 0 THEN NULL ELSE (q.price - p.price) / p.price * 100.0 END AS delta_pct,
       p.quote_id AS from_quote_id,
       q.id AS to_quote_id,
       p.captured_at AS from_captured_at,
       q.captured_at AS to_captured_at,
       q.rule_version
     FROM cur q
     LEFT JOIN prev p ON true
     WHERE p.id IS NULL OR q.price IS DISTINCT FROM p.price`,
    [quoteId],
  );
}

test('change columns: no history is NULL; same-version reverse fixture proves active delta calculation', async () => {
  await withClient(async (client) => {
    await installTempMarketObjects(client);
    const current = (await client.query(
      `INSERT INTO petstore_market_quotes (product_code, store_name, price, captured_at, rule_version)
       VALUES ('SKU-A','竞店A',90,'2026-08-16T08:00:00Z','truth_exclusion_v2026.08.16-1')
       RETURNING id`,
    )).rows[0];

    let row = (await client.query(
      `SELECT market_price_prev, market_price_delta, market_price_delta_pct, market_days_unchanged
       FROM petstore_ops_row WHERE product_code = 'SKU-A'`,
    )).rows[0];
    assert.equal(row.market_price_prev, null);
    assert.equal(row.market_price_delta, null);
    assert.equal(row.market_price_delta_pct, null);
    assert.equal(row.market_days_unchanged, null);

    await client.query(
      `INSERT INTO petstore_market_quote_history
        (product_code, quote_id, store_name, price, captured_at, rule_version, day_key)
       VALUES ('SKU-A',1001,'竞店A',100,'2026-08-15T08:00:00Z','truth_exclusion_v2026.08.16-1','2026-08-15')`,
    );
    row = (await client.query(
      `SELECT market_price_prev, market_price_delta, market_price_delta_pct, market_days_unchanged
       FROM petstore_ops_row WHERE product_code = 'SKU-A'`,
    )).rows[0];
    assert.equal(Number(row.market_price_prev), 100);
    assert.equal(Number(row.market_price_delta), -10);
    assert.equal(Number(row.market_price_delta_pct), -10);
    assert.equal(Number(row.market_days_unchanged), 0);

    await client.query('DELETE FROM petstore_market_quote_history');
    row = (await client.query(
      `SELECT market_price_prev, market_price_delta, market_price_delta_pct, market_days_unchanged
       FROM petstore_ops_row WHERE product_code = 'SKU-A'`,
    )).rows[0];
    assert.equal(row.market_price_prev, null);
    assert.equal(row.market_price_delta, null);
    assert.equal(row.market_price_delta_pct, null);
    assert.equal(row.market_days_unchanged, null);

    await runTempChangeDetector(client, current.id);
    const eventCount = Number((await client.query(
      `SELECT count(*) AS n FROM petstore_market_change_events WHERE change_type = 'NEW_LISTING'`,
    )).rows[0].n);
    assert.equal(eventCount, 1);
  });
});

test('cross rule_version history is ignored and produces no price change event', async () => {
  await withClient(async (client) => {
    await installTempMarketObjects(client);
    const current = (await client.query(
      `INSERT INTO petstore_market_quotes (product_code, store_name, price, captured_at, rule_version)
       VALUES ('SKU-B','竞店B',90,'2026-08-16T08:00:00Z','truth_exclusion_v2026.08.16-1')
       RETURNING id`,
    )).rows[0];
    await client.query(
      `INSERT INTO petstore_market_quote_history
        (product_code, quote_id, store_name, price, captured_at, rule_version, day_key)
       VALUES ('SKU-B',2001,'竞店B',100,'2026-08-15T08:00:00Z','truth_exclusion_v2026.08.15-1','2026-08-15')`,
    );

    const row = (await client.query(
      `SELECT market_price_prev, market_price_delta, market_price_delta_pct, market_days_unchanged
       FROM petstore_ops_row WHERE product_code = 'SKU-B'`,
    )).rows[0];
    assert.equal(row.market_price_prev, null);
    assert.equal(row.market_price_delta, null);
    assert.equal(row.market_price_delta_pct, null);
    assert.equal(row.market_days_unchanged, null);

    await runTempChangeDetector(client, current.id);
    const priceEvents = Number((await client.query(
      `SELECT count(*) AS n
       FROM petstore_market_change_events
       WHERE change_type IN ('PRICE_UP','PRICE_DOWN')`,
    )).rows[0].n);
    assert.equal(priceEvents, 0);
  });
});

test('delta_pct is NULL when previous price is 0 or NULL', async () => {
  await withClient(async (client) => {
    await installTempMarketObjects(client);
    await client.query(
      `INSERT INTO petstore_market_quotes (product_code, store_name, price, captured_at, rule_version)
       VALUES
         ('SKU-ZERO','竞店Z',50,'2026-08-16T08:00:00Z','rv1'),
         ('SKU-NULL','竞店N',50,'2026-08-16T08:00:00Z','rv1')`,
    );
    await client.query(
      `INSERT INTO petstore_market_quote_history
        (product_code, quote_id, store_name, price, captured_at, rule_version, day_key)
       VALUES
         ('SKU-ZERO',3001,'竞店Z',0,'2026-08-15T08:00:00Z','rv1','2026-08-15'),
         ('SKU-NULL',3002,'竞店N',NULL,'2026-08-15T08:00:00Z','rv1','2026-08-15')`,
    );
    const rows = (await client.query(
      `SELECT product_code, market_price_delta_pct
       FROM petstore_ops_row
       ORDER BY product_code`,
    )).rows;
    assert.equal(rows[0].market_price_delta_pct, null);
    assert.equal(rows[1].market_price_delta_pct, null);
  });
});

test('alert comparison operators obey threshold edge semantics', () => {
  assert.equal(compareObserved(10, '>', 10), false);
  assert.equal(compareObserved(10.01, '>', 10), true);
  assert.equal(compareObserved(10, '>=', 10), true);
  assert.equal(compareObserved(9.99, '>=', 10), false);
  assert.equal(compareObserved(10, '<', 10), false);
  assert.equal(compareObserved(9.99, '<', 10), true);
  assert.equal(compareObserved(10, '<=', 10), true);
  assert.equal(compareObserved(10.01, '<=', 10), false);
  assert.equal(compareObserved(10, '=', 10), true);
  assert.equal(compareObserved(10.01, '=', 10), false);
});

test('MARKET_DATA_STALE_DAYS uses max(captured_at) with real metric口径', async () => {
  await withClient(async (client) => {
    await client.query(`
      CREATE TEMP TABLE petstore_alert_rules (
        id serial PRIMARY KEY,
        rule_key text NOT NULL,
        rule_name text NOT NULL,
        metric text NOT NULL,
        threshold numeric NOT NULL,
        comparison text NOT NULL,
        action text NOT NULL,
        scope text,
        active boolean NOT NULL DEFAULT true
      ) ON COMMIT DROP;
      CREATE TEMP TABLE petstore_alert_events (
        id bigserial PRIMARY KEY,
        rule_key text NOT NULL,
        metric text NOT NULL,
        observed numeric NOT NULL,
        threshold numeric NOT NULL,
        comparison text NOT NULL,
        detail jsonb NOT NULL DEFAULT '{}'::jsonb
      ) ON COMMIT DROP;
      CREATE TEMP TABLE petstore_market_quotes (
        id bigserial PRIMARY KEY,
        product_code text,
        captured_at timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE petstore_market_change_events (
        id bigserial PRIMARY KEY,
        change_type text,
        delta_pct numeric,
        to_captured_at timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE petstore_valid_quotes (
        product_code text
      ) ON COMMIT DROP;
      INSERT INTO petstore_alert_rules
        (rule_key, rule_name, metric, threshold, comparison, action, scope)
      VALUES
        ('MARKET_DATA_STALE_DAYS','竞店报价数据超过2天未更新','market_data_age_days',2,'>','notify','store:63350001');
    `);

    await client.query(
      `INSERT INTO petstore_market_quotes (product_code, captured_at)
       VALUES ('SKU-STALE',$1::timestamptz - interval '3 days')`,
      ['2026-08-16T00:00:00Z'],
    );
    let result = (await evaluateAlertRules(client, {
      commit: false,
      nowValue: new Date('2026-08-16T00:00:00Z'),
    }))[0];
    assert.equal(result.triggered, true);

    await client.query('DELETE FROM petstore_market_quotes');
    await client.query(
      `INSERT INTO petstore_market_quotes (product_code, captured_at)
       VALUES ('SKU-FRESH',$1::timestamptz - interval '1 day')`,
      ['2026-08-16T00:00:00Z'],
    );
    result = (await evaluateAlertRules(client, {
      commit: false,
      nowValue: new Date('2026-08-16T00:00:00Z'),
    }))[0];
    assert.equal(result.triggered, false);
  });
});
