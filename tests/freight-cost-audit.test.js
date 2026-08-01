import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const HANDLER_PATH = new URL("../api/db/freight-cost-audit.js", import.meta.url);

async function loadHandler(pool) {
  const key = "__freightCostAuditMocks_" + randomUUID().replaceAll("-", "_");
  globalThis[key] = {
    db: {
      getPool: () => pool,
      setCors: (_req, res, methods) => res.setHeader("access-control-allow-methods", methods),
    },
  };

  const source = await readFile(HANDLER_PATH, "utf8");
  const injected = source.replace(
    'import { getPool, setCors } from "../db.js";',
    `const { getPool, setCors } = globalThis.${key}.db;`
  );

  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(injected).toString("base64")}#${key}`)).default;
  } finally {
    delete globalThis[key];
  }
}

function req(extra) {
  return {
    method: "GET",
    query: {},
    body: {},
    user: { role: "finance", username: "tester" },
    ...extra,
  };
}

function res() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

test("GET sums freight cost from amount and keeps currencies separate", async () => {
  let sqlSeen = "";
  const handler = await loadHandler({
    async query(sql, params) {
      sqlSeen = sql;
      assert.deepEqual(params, ["BL-1"]);
      return {
        rows: [
          { id: "1", bl_no: "BL-1", amount: "100", cost_amount: "100", sale_amount: "130", currency: "USD" },
          { id: "2", bl_no: "BL-1", amount: "50", cost_amount: "50", sale_amount: "60", currency: "CNY" },
        ],
      };
    },
  });
  const out = res();

  await handler(req({ query: { bl_no: "BL-1" } }), out);

  assert.equal(out.statusCode, 200);
  assert.equal(out.body.summary.by_currency.USD.cost, 100);
  assert.equal(out.body.summary.by_currency.USD.sale, 130);
  assert.equal(out.body.summary.by_currency.CNY.cost, 50);
  assert.equal(out.body.summary.cost_cny, 50);
  assert.equal(out.body.checks.some((c) => c.code === "MIXED_CURRENCY"), true);
  assert.match(sqlSeen, /amount AS cost_amount/);
  assert.doesNotMatch(sqlSeen, /SELECT\s+id,\s+bl_no,\s+cost_amount,/);
});

test("POST set_par writes sale_amount from amount, not cost_amount", async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/UPDATE freight_supplier_bills/.test(sql)) return { rowCount: 2, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const handler = await loadHandler({ connect: async () => client });
  const out = res();

  await handler(req({
    method: "POST",
    body: { bl_no: "BL-2", action: "set_par", confirmed: true },
  }), out);

  assert.equal(out.statusCode, 200);
  assert.equal(out.body.rows_updated, 2);
  const update = queries.find((q) => /UPDATE freight_supplier_bills/.test(q.sql));
  assert.match(update.sql, /SET sale_amount = amount/);
  assert.doesNotMatch(update.sql, /cost_amount/);
});
