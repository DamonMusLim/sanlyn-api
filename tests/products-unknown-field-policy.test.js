/**
 * P1-A Smoke Test: Products Unknown Field Policy
 *
 * Verifies that PUT /api/db/products and PATCH /api/db/products reject
 * requests containing unrecognised field names with 400 UNKNOWN_FIELD.
 *
 * Does NOT touch DB schema, real data, or deploy anything.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const HANDLER_PATH = new URL("../api/db/products.js", import.meta.url);

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeMockPool({ rows = [], rowCount = 1 } = {}) {
  return {
    query: async () => ({ rows, rowCount }),
  };
}

async function loadHandler(pool) {
  const mockKey = `__productsMock_${randomUUID().replaceAll("-", "_")}`;
  globalThis[mockKey] = {
    getPool: () => pool,
    setCors: () => {},
  };

  const source = await readFile(HANDLER_PATH, "utf8");
  const injected = source.replace(
    'import { getPool, setCors } from "../db.js";',
    `const { getPool, setCors } = globalThis.${mockKey};`
  );

  try {
    return (
      await import(
        `data:text/javascript;base64,${Buffer.from(injected).toString("base64")}#${mockKey}`
      )
    ).default;
  } finally {
    delete globalThis[mockKey];
  }
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
    setHeader() {},
    end() {},
  };
  return res;
}

function makeReq(method, body, { user = { role: "admin" }, query = {}, params = {} } = {}) {
  return { method, body, user, query, params, headers: {} };
}

// ── Load handler once ─────────────────────────────────────────────────────────

// Pool that simulates a successful single-row update (for accepted-field tests)
const mockPool = makeMockPool({ rows: [{ id: 1, sku: "TEST-001" }], rowCount: 1 });
let handler;

test("load products handler", async () => {
  handler = await loadHandler(mockPool);
  assert.ok(typeof handler === "function");
});

// ── PUT: canonical fields accepted ───────────────────────────────────────────

test("PUT: canonical fields (cbm, net_weight, gross_weight) are accepted", async () => {
  const req = makeReq("PUT", {
    sku: "TEST-001",
    cbm: 0.042,
    net_weight: 10.0,
    gross_weight: 12.5,
    product_name: "Test Product",
  });
  const res = makeRes();
  await handler(req, res);
  // Should not be 400 UNKNOWN_FIELD — may be 200 or 404 depending on mock row
  assert.notEqual(res._status, 400, `Expected non-400 but got: ${JSON.stringify(res._body)}`);
  assert.notEqual(res._body?.error, "UNKNOWN_FIELD");
});

test("PUT: hs_code, declaration_name, declaration_elements are accepted", async () => {
  const req = makeReq("PUT", {
    sku: "TEST-001",
    hs_code: "23091000",
    declaration_name: "宠物食品",
    declaration_elements: "成分：鱼",
  });
  const res = makeRes();
  await handler(req, res);
  assert.notEqual(res._status, 400);
  assert.notEqual(res._body?.error, "UNKNOWN_FIELD");
});

// ── PUT: legacy alias fields rejected ────────────────────────────────────────

test("PUT: cbm_per_ctn is rejected with 400 UNKNOWN_FIELD", async () => {
  const req = makeReq("PUT", { sku: "TEST-001", cbm_per_ctn: 0.042 });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body?.error, "UNKNOWN_FIELD");
  assert.ok(res._body?.unknown_fields?.includes("cbm_per_ctn"), "unknown_fields must list cbm_per_ctn");
});

test("PUT: nw_per_ctn is rejected with 400 UNKNOWN_FIELD", async () => {
  const req = makeReq("PUT", { sku: "TEST-001", nw_per_ctn: 10.0 });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body?.error, "UNKNOWN_FIELD");
  assert.ok(res._body?.unknown_fields?.includes("nw_per_ctn"));
});

test("PUT: gw_per_ctn is rejected with 400 UNKNOWN_FIELD", async () => {
  const req = makeReq("PUT", { sku: "TEST-001", gw_per_ctn: 12.5 });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body?.error, "UNKNOWN_FIELD");
  assert.ok(res._body?.unknown_fields?.includes("gw_per_ctn"));
});

test("PUT: cbm_per_unit is rejected with 400 UNKNOWN_FIELD", async () => {
  const req = makeReq("PUT", { sku: "TEST-001", cbm_per_unit: 0.042 });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body?.error, "UNKNOWN_FIELD");
  assert.ok(res._body?.unknown_fields?.includes("cbm_per_unit"));
});

test("PUT: kg_per_unit is rejected with 400 UNKNOWN_FIELD", async () => {
  const req = makeReq("PUT", { sku: "TEST-001", kg_per_unit: 10.0 });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body?.error, "UNKNOWN_FIELD");
  assert.ok(res._body?.unknown_fields?.includes("kg_per_unit"));
});

test("PUT: multiple unknown fields are all listed in unknown_fields array", async () => {
  const req = makeReq("PUT", {
    sku: "TEST-001",
    cbm_per_ctn: 0.042,
    nw_per_ctn: 10.0,
    gw_per_ctn: 12.5,
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body?.error, "UNKNOWN_FIELD");
  assert.ok(Array.isArray(res._body?.unknown_fields));
  assert.equal(res._body.unknown_fields.length, 3);
  assert.ok(res._body.unknown_fields.includes("cbm_per_ctn"));
  assert.ok(res._body.unknown_fields.includes("nw_per_ctn"));
  assert.ok(res._body.unknown_fields.includes("gw_per_ctn"));
});

test("PUT: response includes non-empty allowed_fields list", async () => {
  const req = makeReq("PUT", { sku: "TEST-001", some_random_field: "x" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(Array.isArray(res._body?.allowed_fields), "allowed_fields must be an array");
  assert.ok(res._body.allowed_fields.length > 0, "allowed_fields must be non-empty");
  // Canonical fields must appear in allowed_fields
  assert.ok(res._body.allowed_fields.includes("cbm"));
  assert.ok(res._body.allowed_fields.includes("net_weight"));
  assert.ok(res._body.allowed_fields.includes("gross_weight"));
  assert.ok(res._body.allowed_fields.includes("hs_code"));
});

test("PUT: error message is human-readable string", async () => {
  const req = makeReq("PUT", { sku: "TEST-001", origin_country: "CN" });
  const res = makeRes();
  await handler(req, res);
  // origin_country is not in the PUT whitelist
  assert.equal(res._status, 400);
  assert.equal(typeof res._body?.message, "string");
  assert.ok(res._body.message.length > 0);
});

// ── PATCH: accepted camelCase fields pass through ─────────────────────────────

test("PATCH: hsCode is accepted (camelCase canonical PATCH field)", async () => {
  // Pool must return rowCount > 0 for PATCH to succeed
  const patchPool = makeMockPool({ rows: [{ id: 42 }], rowCount: 1 });
  const patchHandler = await loadHandler(patchPool);

  const req = makeReq(
    "PATCH",
    { id: "42", hsCode: "23091000" },
    { user: { role: "admin" } }
  );
  const res = makeRes();
  await patchHandler(req, res);
  assert.notEqual(res._status, 400, `Expected non-400 but got: ${JSON.stringify(res._body)}`);
  assert.notEqual(res._body?.error, "UNKNOWN_FIELD");
});

// ── PATCH: snake_case alias rejected ─────────────────────────────────────────

test("PATCH: hs_code (snake_case) is rejected — PATCH only accepts camelCase hsCode", async () => {
  const req = makeReq(
    "PATCH",
    { id: "42", hs_code: "23091000" },
    { user: { role: "admin" } }
  );
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body?.error, "UNKNOWN_FIELD");
  assert.ok(res._body?.unknown_fields?.includes("hs_code"), "hs_code must appear in unknown_fields for PATCH");
});

test("PATCH: declarationName, declarationElements are accepted", async () => {
  const patchPool = makeMockPool({ rows: [{ id: 42 }], rowCount: 1 });
  const patchHandler = await loadHandler(patchPool);
  const req = makeReq(
    "PATCH",
    { id: "42", declarationName: "宠物食品", declarationElements: "成分：鸡" },
    { user: { role: "admin" } }
  );
  const res = makeRes();
  await patchHandler(req, res);
  assert.notEqual(res._body?.error, "UNKNOWN_FIELD");
});

test("PATCH: cbm_per_unit is rejected", async () => {
  const req = makeReq(
    "PATCH",
    { id: "42", cbm_per_unit: 0.042 },
    { user: { role: "admin" } }
  );
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body?.error, "UNKNOWN_FIELD");
});

test("PATCH: kg_per_unit is rejected", async () => {
  const req = makeReq(
    "PATCH",
    { id: "42", kg_per_unit: 10.0 },
    { user: { role: "admin" } }
  );
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body?.error, "UNKNOWN_FIELD");
});

// ── Safety guarantees ─────────────────────────────────────────────────────────

test("PUT: missing sku still returns 400 (pre-existing guard, not broken by P1-A)", async () => {
  const req = makeReq("PUT", { cbm: 0.042 }); // no sku, but cbm is valid
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  // Must be sku error not UNKNOWN_FIELD
  assert.ok(res._body?.error === "sku required" || res._body?.error !== "UNKNOWN_FIELD");
});
