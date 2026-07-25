import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const tmpRoot = new URL("./.test-tmp/api/", import.meta.url);
await rm(new URL("./.test-tmp/", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("db/", tmpRoot), { recursive: true });
await writeFile(
  new URL("db/product-insurance-pref.js", tmpRoot),
  await readFile(new URL("./product-insurance-pref.js", import.meta.url), "utf8"),
);
await writeFile(new URL("db.js", tmpRoot), `
export function getPool() { throw new Error("pool must be injected"); }
export function setCors(req, res, methods = "GET, POST, OPTIONS") {
  res.setHeader("Access-Control-Allow-Methods", methods);
}
`);
await writeFile(new URL("auth.js", tmpRoot), `
export function extractUser(req) { return req.user || null; }
`);

const { handleProductInsurancePref } = await import("./.test-tmp/api/db/product-insurance-pref.js");

function res() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(s) { this.statusCode = s; return this; },
    json(p) { this.body = p; return this; },
    end() { this.ended = true; return this; },
  };
}

async function call(req, pool) {
  const out = res();
  await handleProductInsurancePref({
    headers: {},
    query: {},
    body: {},
    user: { role: "admin", username: "alice" },
    ...req,
  }, out, pool);
  return out;
}

function poolWith(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params);
    },
  };
}

async function testGetDefault() {
  const pool = poolWith(() => ({ rows: [] }));
  const r = await call({
    method: "GET",
    query: { product_key: "SKU-1", customer_id: "C001" },
  }, pool);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.preference.insurer, "人保");
  assert.equal(r.body.preference.markup_pct, 110);
  assert.equal(r.body.preference.cover, "ICC-A");
  assert.equal(r.body.preference.is_default, true);
  assert.equal("rate" in r.body.preference, false);
  assert.equal("cost" in r.body.preference, false);
  assert.equal("premium" in r.body.preference, false);
}

async function testGetExisting() {
  const pool = poolWith(() => ({ rows: [{
    product_key: "HS-1",
    customer_id: "42",
    last_insurer: "太保",
    last_cover: "ICC-C",
    last_markup_pct: "125.5",
    last_special_cargo: "battery",
    updated_by: "bob",
    updated_at: "2026-07-25T00:00:00.000Z",
  }] }));
  const r = await call({
    method: "GET",
    query: { product_key: "HS-1", customer_id: "42" },
  }, pool);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.preference.insurer, "太保");
  assert.equal(r.body.preference.markup_pct, 125.5);
  assert.equal(r.body.preference.special_cargo, "battery");
  assert.equal(r.body.preference.is_default, false);
}

async function testPostUpsert() {
  const pool = poolWith((sql, params) => {
    assert.match(sql, /ON CONFLICT \(product_key, customer_id\) DO UPDATE/);
    assert.match(sql, /INSERT INTO product_insurance_pref/);
    assert.deepEqual(params.slice(0, 7), ["SKU-9", "C009", "平安", "ICC-A", 118, "fragile", "alice"]);
    return { rows: [{
      product_key: params[0],
      customer_id: params[1],
      last_insurer: params[2],
      last_cover: params[3],
      last_markup_pct: params[4],
      last_special_cargo: params[5],
      updated_by: params[6],
      updated_at: "now",
    }] };
  });
  const r = await call({
    method: "POST",
    body: { product_key: "SKU-9", customer_id: "C009", insurer: "平安", cover: "ICC-A", markup_pct: 118, special_cargo: "fragile" },
  }, pool);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.preference.insurer, "平安");
  assert.equal(r.body.preference.updated_by, "alice");
}

async function testMarkupOutOfRange() {
  const pool = poolWith(() => { throw new Error("should not query"); });
  const r = await call({
    method: "POST",
    body: { product_key: "SKU-1", customer_id: "C001", markup_pct: 301 },
  }, pool);
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_markup_pct");
}

async function testMissingProductKey() {
  const pool = poolWith(() => { throw new Error("should not query"); });
  const r = await call({
    method: "POST",
    body: { customer_id: "C001" },
  }, pool);
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "product_key_and_customer_id_required");
}

async function testRateCostIgnored() {
  const pool = poolWith((sql, params) => {
    assert.equal(sql.includes(" rate"), false);
    assert.equal(sql.includes("cost"), false);
    assert.equal(sql.includes("premium"), false);
    assert.equal(params.includes(0.0003), false);
    assert.equal(params.includes(12.34), false);
    assert.equal(params.includes(56.78), false);
    return { rows: [{
      product_key: params[0],
      customer_id: params[1],
      last_insurer: params[2],
      last_cover: params[3],
      last_markup_pct: params[4],
      last_special_cargo: params[5],
      updated_by: params[6],
      updated_at: "now",
    }] };
  });
  const r = await call({
    method: "POST",
    body: {
      product_key: "SKU-2",
      customer_id: "C002",
      rate: 0.0003,
      cost: 12.34,
      premium: 56.78,
    },
  }, pool);
  assert.equal(r.statusCode, 200);
  assert.equal("rate" in r.body.preference, false);
}

await testGetDefault();
await testGetExisting();
await testPostUpsert();
await testMarkupOutOfRange();
await testMissingProductKey();
await testRateCostIgnored();
await rm(new URL("./.test-tmp/", import.meta.url), { recursive: true, force: true });
console.log("product-insurance-pref tests passed");
