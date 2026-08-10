import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test, before } from "node:test";

let handler;
let queries = [];

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

function mockReq(overrides = {}) {
  return {
    method: "GET",
    headers: {},
    query: {},
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
  };
}

before(async () => {
  const mockKey = `__dailyCheckMocks_${randomUUID().replaceAll("-", "_")}`;
  globalThis[mockKey] = {
    setCors: () => {},
    getPool: () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return {
          rows: [{
            job_key: "hb_watch",
            name: "每日体检巡检",
            machine: "mini",
            schedule: "daily",
            category: "infra",
            status: "ok",
            message: "ok",
            last_run: "2026-08-10T01:00:00.000Z",
            updated_at: "2026-08-10T01:00:00.000Z",
          }],
        };
      },
    }),
  };

  const handlerPath = new URL("../api/console-daily-check.js", import.meta.url);
  const source = await readFile(handlerPath, "utf8");
  const injected = source.replace(
    'import { getPool, setCors } from "./db.js";',
    `const { getPool, setCors } = globalThis["${mockKey}"];`
  );
  const mod = await import(`data:text/javascript;base64,${Buffer.from(injected).toString("base64")}#${mockKey}`);
  handler = mod.default;
});

test("rejects public forwarded callers before querying DB", async () => {
  queries = [];
  const res = mockRes();

  await handler(mockReq({
    headers: { "x-forwarded-for": "203.0.113.10" },
    socket: { remoteAddress: "127.0.0.1" },
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "loopback only");
  assert.equal(queries.length, 0);
});

test("allows loopback and returns watchdog rows grouped by Shanghai day", async () => {
  queries = [];
  const res = mockRes();

  await handler(mockReq({ query: { days: "99" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.days, 14);
  assert.equal(res.body.latest[0].job_key, "hb_watch");
  assert.equal(res.body.by_day["2026-08-10"][0].state, "ok");
  assert.equal(queries.length, 1);
});
