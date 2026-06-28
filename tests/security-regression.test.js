import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const HANDLER_PATH = new URL("../api/db/loading-collab-sheets.js", import.meta.url);

async function loadHandler({ pool }) {
  const mockKey = `__loadingCollabSheetsMocks_${randomUUID().replaceAll("-", "_")}`;
  globalThis[mockKey] = {
    db: {
      getPool: () => pool,
      setCors: (_req, res, methods = "GET, POST, OPTIONS") => {
        res.setHeader("Access-Control-Allow-Methods", methods);
      },
    },
    viewmodel: {
      isInternalRole: (role) =>
        new Set(["admin", "internal", "boss", "finance", "platform_admin", "system"])
          .has(String(role || "").toLowerCase()),
      roleFromAuth: (req) => req?.user?.role ? String(req.user.role).toLowerCase() : "anonymous",
      sendError: (res, status, code, detail) =>
        res.status(status).json({ error: code, detail: detail || undefined }),
    },
  };

  const source = await readFile(HANDLER_PATH, "utf8");
  const injected = source
    .replace('import { getPool, setCors } from "../db.js";', `const { getPool, setCors } = globalThis.${mockKey}.db;`)
    .replace('import { isInternalRole, roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";', `const { isInternalRole, roleFromAuth, sendError } = globalThis.${mockKey}.viewmodel;`);

  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(injected).toString("base64")}#${mockKey}`)).default;
  } finally {
    delete globalThis[mockKey];
  }
}

function req(opts) {
  return { headers: {}, query: {}, body: {}, ...opts };
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

function poolForOrder(orderRow, onInsert) {
  const client = {
    released: false,
    async query(sql, params = []) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (/FROM orders WHERE id = \$1/.test(sql)) return { rows: orderRow ? [orderRow] : [] };
      if (/INSERT INTO loading_collab_sheets/.test(sql)) {
        onInsert?.(params);
        return { rows: [{ id: 1, loading: JSON.parse(params[5]) }] };
      }
      if (/UPDATE shipping_plans/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { this.released = true; },
  };
  return { client, async connect() { return client; } };
}

test("null order factory_code -> POST returns 403 order_factory_scope_missing", async () => {
  const pool = poolForOrder({
    id: 1, order_no: "SO-1", contract_no: "C-1", products: [],
    company_code: "CUST_A", factory_code: null,
  });
  const handler = await loadHandler({ pool });
  const out = res();

  await handler(req({
    method: "POST",
    user: { role: "factory", companyCode: "FAC_A" },
    body: { order_id: 1, factory_code: "FAC_A", cargo_ready_date: "2026-05-20" },
  }), out);

  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, "order_factory_scope_missing");
  assert.equal(pool.client.released, true);
});

test("unknown viewer role -> GET returns 403 role_not_permitted_for_this_resource", async () => {
  const handler = await loadHandler({
    pool: { query: async () => assert.fail("query should not run") },
  });
  const out = res();

  await handler(req({
    method: "GET",
    user: { role: "viewer", companyCode: "CUST_A" },
    query: { order_id: "1" },
  }), out);

  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, "role_not_permitted_for_this_resource");
});

test("forged body customer_code is ignored; factory JWT uses factory path", async () => {
  let loadingPayload;
  const pool = poolForOrder({
    id: 1, order_no: "SO-1", contract_no: "C-1", products: [],
    company_code: "CUST_DB", factory_code: "FAC_JWT",
  }, (params) => {
    loadingPayload = JSON.parse(params[5]);
  });
  const handler = await loadHandler({ pool });
  const out = res();

  await handler(req({
    method: "POST",
    user: { role: "factory", companyCode: "FAC_JWT" },
    body: {
      order_id: 1,
      factory_code: "FAC_JWT",
      customer_code: "FORGED_CUSTOMER",   // should be ignored
      cargo_ready_date: "2026-05-20",
    },
  }), out);

  assert.equal(out.statusCode, 201);
  assert.equal(loadingPayload.submitted_by_factory, true);
  assert.equal(loadingPayload.customer_code_display, "CUST_DB");  // from DB, not body
  assert.equal(JSON.stringify(loadingPayload).includes("FORGED_CUSTOMER"), false);
  assert.equal(pool.client.released, true);
});
