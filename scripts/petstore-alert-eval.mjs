#!/usr/bin/env node
import 'dotenv/config';
import process from 'node:process';
import { Client } from 'pg';

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return { commit: args.has('--commit') };
}

export function compareObserved(observed, comparison, threshold) {
  if (observed == null || threshold == null) return false;
  const left = Number(observed);
  const right = Number(threshold);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (comparison === '>') return left > right;
  if (comparison === '>=') return left >= right;
  if (comparison === '<') return left < right;
  if (comparison === '<=') return left <= right;
  if (comparison === '=') return left === right;
  throw new Error(`unsupported comparison: ${comparison}`);
}

async function metricMarketDataAgeDays(client, nowValue) {
  const { rows } = await client.query(
    `SELECT CASE
       WHEN max(captured_at) IS NULL THEN NULL
       ELSE extract(epoch FROM ($1::timestamptz - max(captured_at))) / 86400.0
     END AS observed
     FROM petstore_market_quotes`,
    [nowValue],
  );
  return rows[0].observed == null ? null : Number(rows[0].observed);
}

async function metricCompetitorPriceDropPct(client) {
  const { rows } = await client.query(
    `WITH latest_batch AS (
       SELECT max(to_captured_at)::date AS day_key
       FROM petstore_market_change_events
       WHERE to_captured_at IS NOT NULL
     )
     SELECT max(abs(delta_pct)) AS observed
     FROM petstore_market_change_events e
     CROSS JOIN latest_batch b
     WHERE e.change_type = 'PRICE_DOWN'
       AND e.delta_pct IS NOT NULL
       AND e.to_captured_at::date = b.day_key`,
  );
  return rows[0].observed == null ? null : Number(rows[0].observed);
}

async function metricComparableProductCount(client) {
  const { rows } = await client.query(
    `SELECT count(DISTINCT product_code)::numeric AS observed
     FROM petstore_valid_quotes`,
  );
  return rows[0].observed == null ? null : Number(rows[0].observed);
}

export async function observeMetric(client, metric, nowValue = new Date()) {
  if (metric === 'market_data_age_days') return metricMarketDataAgeDays(client, nowValue);
  if (metric === 'competitor_price_drop_pct') return metricCompetitorPriceDropPct(client);
  if (metric === 'comparable_product_count') return metricComparableProductCount(client);
  throw new Error(`unsupported metric: ${metric}`);
}

export async function evaluateAlertRules(client, { commit = false, nowValue = new Date() } = {}) {
  const { rows: rules } = await client.query(
    `SELECT rule_key, rule_name, metric, threshold, comparison, action, scope
     FROM petstore_alert_rules
     WHERE active
     ORDER BY id`,
  );
  const results = [];

  for (const rule of rules) {
    const observed = await observeMetric(client, rule.metric, nowValue);
    const triggered = observed == null ? false : compareObserved(observed, rule.comparison, rule.threshold);
    const result = {
      rule_key: rule.rule_key,
      metric: rule.metric,
      observed,
      threshold: Number(rule.threshold),
      comparison: rule.comparison,
      triggered,
    };
    results.push(result);

    if (triggered && commit) {
      await client.query(
        `INSERT INTO petstore_alert_events
          (rule_key, metric, observed, threshold, comparison, detail)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          rule.rule_key,
          rule.metric,
          observed,
          rule.threshold,
          rule.comparison,
          JSON.stringify({
            rule_name: rule.rule_name,
            action: rule.action,
            scope: rule.scope,
          }),
        ],
      );
    }
  }

  return results;
}

function fmt(value) {
  return value == null ? 'NULL' : Number(value).toFixed(4);
}

async function main() {
  const { commit } = parseArgs(process.argv);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const results = await evaluateAlertRules(client, { commit });
    for (const r of results) {
      console.log([
        `rule_key=${r.rule_key}`,
        `metric=${r.metric}`,
        `observed=${fmt(r.observed)}`,
        `threshold=${r.threshold}`,
        `comparison=${r.comparison}`,
        `triggered=${r.triggered}`,
      ].join(' '));
    }
    console.log(commit ? 'commit: alert events written for triggered rules' : 'dry-run: no alert events written');
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
