import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const HANDLER_PATH = new URL("../api/tasks-ingest.js", import.meta.url);

async function loadHandler(pool) {
  const mockKey = `__tasksIngestMocks_${randomUUID().replaceAll("-", "_")}`;
  globalThis[mockKey] = {
    db: {
      getPool: () => pool,
      setCors: (_req, res, methods) => {
        res.setHeader("access-control-allow-methods", methods);
      },
    },
  };

  const source = await readFile(HANDLER_PATH, "utf8");
  const injected = source.replace(
    'import { getPool, setCors } from "./db.js";',
    `const { getPool, setCors } = globalThis.${mockKey}.db;`
  );

  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(injected).toString("base64")}#${mockKey}`)).default;
  } finally {
    delete globalThis[mockKey];
  }
}

function req(body) {
  return {
    method: "POST",
    headers: { "x-task-ingest-secret": "secret" },
    body: {
      source: "test-source",
      dedupe_key: "test-key",
      title: "Test task",
      ...body,
    },
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

function capturePool() {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/INSERT INTO tasks/.test(sql)) {
        return { rows: [{ id: "task-1", status: "open", created: true }] };
      }
      return { rows: [] };
    },
    releaseCalled: false,
    release() { this.releaseCalled = true; },
  };
  return {
    client,
    queries,
    async connect() { return client; },
  };
}

async function ingest(body) {
  const oldSecret = process.env.TASK_INGEST_SECRET;
  process.env.TASK_INGEST_SECRET = "secret";
  const pool = capturePool();
  const handler = await loadHandler(pool);
  const out = res();

  try {
    await handler(req(body), out);
  } finally {
    if (oldSecret === undefined) {
      delete process.env.TASK_INGEST_SECRET;
    } else {
      process.env.TASK_INGEST_SECRET = oldSecret;
    }
  }

  assert.equal(out.statusCode, 200);
  assert.equal(pool.client.releaseCalled, true);
  const insert = pool.queries.find((q) => /INSERT INTO tasks/.test(q.sql));
  assert.ok(insert, "tasks insert should run");
  return insert;
}

test("writes holder verifier domain and raw origin_machine from ingest payload", async () => {
  const insert = await ingest({
    raw_extra: {
      owner_staff_no: "HY-02",
      reviewer_staff_no: "HY-03",
      domain: "海运",
      origin_machine: "mini",
    },
  });

  assert.match(insert.sql, /current_holder, verifier, domain/);
  assert.match(insert.sql, /current_holder = COALESCE\(NULLIF\(tasks\.current_holder, ''\), EXCLUDED\.current_holder\)/);
  assert.equal(insert.params[15], "HY-02");
  assert.equal(insert.params[16], "HY-02");
  assert.equal(insert.params[17], "HY-03");
  assert.equal(insert.params[18], "海运");

  const raw = JSON.parse(insert.params[11]);
  assert.equal(raw.origin_machine, "mini");
});

test("missing optional holder verifier domain origin_machine stays null and raw unchanged", async () => {
  const insert = await ingest({});

  assert.equal(insert.params[15], null);
  assert.equal(insert.params[16], null);
  assert.equal(insert.params[17], null);
  assert.equal(insert.params[18], null);

  const raw = JSON.parse(insert.params[11]);
  assert.equal(Object.hasOwn(raw, "origin_machine"), false);
  assert.deepEqual(raw.raw_extra, {});
});
