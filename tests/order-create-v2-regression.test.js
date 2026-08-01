import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const HANDLER_PATH = new URL("../api/db/order-create-v2.js", import.meta.url);
const CUSTOMER_ADDRESSES_PATH = new URL("../api/db/customer-addresses.js", import.meta.url);

async function loadOrderCreateHandler(pool) {
  const mockKey = `__orderCreateV2Mocks_${randomUUID().replaceAll("-", "_")}`;
  globalThis[mockKey] = {
    db: {
      getPool: () => pool,
      setCors: (_req, res, methods = "GET, POST, OPTIONS") => {
        res.setHeader("Access-Control-Allow-Methods", methods);
      },
    },
    auth: {
      requireAuth: () => true,
    },
    gate: {
      enforceOrderIntakeGate: async () => ({ ok: true }),
    },
    collab: {
      ensureOrderCollabOpen: async () => {},
    },
  };

  const source = await readFile(HANDLER_PATH, "utf8");
  const injected = source
    .replace('import { getPool, setCors } from "../db.js";', `const { getPool, setCors } = globalThis.${mockKey}.db;`)
    .replace('import { requireAuth } from "../auth.js";', `const { requireAuth } = globalThis.${mockKey}.auth;`)
    .replace('import { enforceOrderIntakeGate } from "../lib/order-intake-gate.js";', `const { enforceOrderIntakeGate } = globalThis.${mockKey}.gate;`)
    .replace('import { ensureOrderCollabOpen } from "./lib/collab-auto-links.js";', `const { ensureOrderCollabOpen } = globalThis.${mockKey}.collab;`);

  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(injected).toString("base64")}#${mockKey}`)).default;
  } finally {
    delete globalThis[mockKey];
  }
}

async function loadCustomerAddressesHandler(pool) {
  const mockKey = `__customerAddressesMocks_${randomUUID().replaceAll("-", "_")}`;
  globalThis[mockKey] = {
    db: {
      getPool: () => pool,
      setCors: (_req, res, methods = "GET, POST, PUT, DELETE, OPTIONS") => {
        res.setHeader("Access-Control-Allow-Methods", methods);
      },
    },
    auth: {
      requireAuth: () => true,
    },
  };

  const source = await readFile(CUSTOMER_ADDRESSES_PATH, "utf8");
  const injected = source
    .replace('import { getPool, setCors } from "../db.js";', `const { getPool, setCors } = globalThis.${mockKey}.db;`)
    .replace('import { requireAuth } from "../auth.js";', `const { requireAuth } = globalThis.${mockKey}.auth;`);

  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(injected).toString("base64")}#${mockKey}`)).default;
  } finally {
    delete globalThis[mockKey];
  }
}

function req(opts) {
  return { method: "GET", headers: {}, query: {}, body: {}, ...opts };
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

test("routes-core registers /api/db/customer-addresses", async () => {
  const { registerCoreRoutes } = await import("../routes-core.js");
  const mounted = [];
  const app = {
    all(route) {
      mounted.push(route);
    },
  };

  registerCoreRoutes(app, (route) => mounted.push(route));

  assert.ok(mounted.includes("/api/db/customer-addresses"));
});

test("customer-addresses GET lists saved addresses", async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/CREATE TABLE IF NOT EXISTS customer_addresses/.test(sql)) return { rows: [] };
      if (/FROM customer_addresses/.test(sql)) {
        assert.deepEqual(params, ["CN-00048"]);
        return {
          rows: [{
            id: 7,
            company_code: "CN-00048",
            label: "Warehouse",
            country: "Malaysia",
            city: "Kajang",
            address: "Lot 1",
            phone: "",
            email: "",
            is_default: true,
            created_at: "2026-07-25T00:00:00.000Z",
          }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const handler = await loadCustomerAddressesHandler(pool);
  const out = res();

  await handler(req({
    query: { companyCode: "CN-00048" },
  }), out);

  assert.equal(out.statusCode, 200);
  assert.equal(out.body.success, true);
  assert.equal(out.body.count, 1);
  assert.equal(out.body.data[0].address, "Lot 1");
  assert.equal(
    calls.some((call) => /CREATE TABLE IF NOT EXISTS customer_addresses/.test(call.sql)),
    true
  );
});

test("factory-by-buyer falls back from empty sub-entity relations to parent buyer relations", async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/CREATE TABLE IF NOT EXISTS order_line_items/.test(sql)) return { rows: [] };
      if (/SELECT id, sub_entities FROM customers/.test(sql)) {
        return {
          rows: [{
            id: 48,
            sub_entities: [{ code: "SEVEN", name: "SEVEN SEAS" }],
          }],
        };
      }
      if (/FROM partner_relationships pr/.test(sql)) {
        if (params[0] === "SEVEN") return { rows: [] };
        if (params[0] === "CN-00048") {
          return { rows: [{ code: "FAC_A", role_at_hop: "factory" }] };
        }
      }
      if (/FROM factories f/.test(sql)) {
        return {
          rows: [{
            company_code: "FAC_A",
            name_cn: "Factory A",
            name_en: "Factory A EN",
            name_short: "FA",
            po_prefix: "FA",
            ports: ["NINGBO"],
            address: "Factory address",
            currency: "CNY",
          }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const handler = await loadOrderCreateHandler(pool);
  const out = res();

  await handler(req({
    user: { role: "customer", companyCodes: ["CN-00048"] },
    query: {
      action: "factory-by-buyer",
      buyerCode: "CN-00048",
      subEntityCode: "SEVEN",
    },
  }), out);

  assert.equal(out.statusCode, 200);
  assert.equal(out.body.success, true);
  assert.equal(out.body.authorizedCount, 1);
  assert.equal(out.body.factories[0].companyCode, "FAC_A");
  assert.deepEqual(
    calls
      .filter((call) => /FROM partner_relationships pr/.test(call.sql))
      .map((call) => call.params[0]),
    ["SEVEN", "CN-00048"]
  );
});
