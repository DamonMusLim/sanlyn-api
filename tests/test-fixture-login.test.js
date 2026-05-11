// tests/test-fixture-login.test.js
// TOOLCHAIN-TEST-ACCOUNT-FIXTURE-001 — 13 test cases
//
// Run: node --test tests/test-fixture-login.test.js
//
// Tests are pure unit tests (no network, no DB, no real JWT_SECRET required).
// The handler is loaded once with mocked auth.js / db.js.
// Each test overrides process.env for the call, then restores.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test, before } from "node:test";

// ── Mock helpers ───────────────────────────────────────────────────────────────

function mockRes() {
  return {
    statusCode: 200,
    _headers:   {},
    _body:      undefined,
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this._body = payload; return this; },
    end() { return this; },
  };
}

function mockReq({ method = "POST", body = {}, headers = {} } = {}) {
  return { method, body, headers, query: {} };
}

// ── Shared state ───────────────────────────────────────────────────────────────

// generatedToken is replaced per-test to allow capture
let generatedToken = () => "stub-token-" + randomUUID();

let handler; // loaded once in before()

before(async () => {
  const mockKey = `__fixtureLoginMocks_${randomUUID().replaceAll("-", "_")}`;

  globalThis[mockKey] = {
    setCors: () => {},
    // Delegate to the per-test replaceable function
    generateToken: (payload) => generatedToken(payload),
  };

  const handlerPath = new URL("../api/db/test-fixture-login.js", import.meta.url);
  const source = await readFile(handlerPath, "utf8");

  const injected = source
    .replace('import { setCors } from "../db.js";',
      `const { setCors } = globalThis["${mockKey}"];`)
    .replace('import { generateToken } from "../auth.js";',
      `const generateToken = globalThis["${mockKey}"].generateToken;`);

  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(injected).toString("base64")}#${mockKey}`
  );
  handler = mod.default;
});

// env management helper
function withEnv(env, fn) {
  const orig = {};
  for (const [k, v] of Object.entries(env)) {
    orig[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ── T1: Returns 404 in production ─────────────────────────────────────────────
test("T1 — production → 404 (not 403)", async () => {
  await withEnv({ NODE_ENV: "production", ENABLE_TEST_AUTH: "1" }, async () => {
    const res = mockRes();
    await handler(mockReq({ body: { account: "test_admin" } }), res);
    assert.equal(res.statusCode, 404, "production must return 404");
    assert.ok(!res._body?.token, "no token in production response");
  });
});

// ── T2: Returns 403 when ENABLE_TEST_AUTH is not set ──────────────────────────
test("T2 — ENABLE_TEST_AUTH not set → 403", async () => {
  await withEnv({ NODE_ENV: "development", ENABLE_TEST_AUTH: undefined }, async () => {
    const res = mockRes();
    await handler(mockReq({ body: { account: "test_admin" } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res._body?.error, "test_auth_disabled");
    assert.ok(!res._body?.token);
  });
});

// ── T2b: Returns 403 when ENABLE_TEST_AUTH is '0' ─────────────────────────────
test("T2b — ENABLE_TEST_AUTH='0' → 403", async () => {
  await withEnv({ NODE_ENV: "development", ENABLE_TEST_AUTH: "0" }, async () => {
    const res = mockRes();
    await handler(mockReq({ body: { account: "test_admin" } }), res);
    assert.equal(res.statusCode, 403);
    assert.ok(!res._body?.token);
  });
});

// ── T3: dev + ENABLE_TEST_AUTH=1 + valid account → 200 with token ─────────────
test("T3 — dev + ENABLE_TEST_AUTH=1 + test_admin → 200 token", async () => {
  const EXPECTED = "signed-token-" + randomUUID();
  generatedToken = () => EXPECTED;

  await withEnv({ NODE_ENV: "development", ENABLE_TEST_AUTH: "1" }, async () => {
    const res = mockRes();
    await handler(mockReq({ body: { account: "test_admin" } }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(res._body?.success);
    assert.equal(res._body?.token, EXPECTED);
    assert.equal(res._body?.user?.role, "admin");
    assert.equal(res._body?.user?.username, "test_admin");
    assert.equal(res._body?._dev, "fixture");
  });

  generatedToken = () => "stub-token-" + randomUUID();
});

// ── T3b: test_finance → finance role ──────────────────────────────────────────
test("T3b — test_finance → role: finance", async () => {
  await withEnv({ NODE_ENV: "test", ENABLE_TEST_AUTH: "1" }, async () => {
    const res = mockRes();
    await handler(mockReq({ body: { account: "test_finance" } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._body?.user?.role, "finance");
  });
});

// ── T3c: test_operator → internal role ────────────────────────────────────────
test("T3c — test_operator → role: internal", async () => {
  await withEnv({ NODE_ENV: "test", ENABLE_TEST_AUTH: "1" }, async () => {
    const res = mockRes();
    await handler(mockReq({ body: { account: "test_operator" } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._body?.user?.role, "internal");
  });
});

// ── T4: Token payload matches authMiddleware expected shape ────────────────────
test("T4 — token payload has all fields authMiddleware requires", async () => {
  let captured = null;
  generatedToken = (p) => { captured = p; return "payload-check-token"; };

  await withEnv({ NODE_ENV: "development", ENABLE_TEST_AUTH: "1" }, async () => {
    const res = mockRes();
    await handler(mockReq({ body: { account: "test_admin" } }), res);
    assert.ok(captured, "generateToken must have been called");
    assert.ok("uid"         in captured, "payload must have uid");
    assert.ok("username"    in captured, "payload must have username");
    assert.ok("role"        in captured, "payload must have role");
    assert.ok("companyCode" in captured, "payload must have companyCode");
    assert.ok("companyCodes" in captured, "payload must have companyCodes");
    assert.equal(captured._fixture, true, "payload must be marked _fixture:true");
    assert.ok(captured.uid < 0, "fixture uid must be negative (no collision with real rows)");
    // Response 200 confirms token is valid and returned
    assert.equal(res.statusCode, 200);
  });

  generatedToken = () => "stub-token-" + randomUUID();
});

// ── T5: Unknown account → 400 ─────────────────────────────────────────────────
test("T5 — unknown fixture account → 400", async () => {
  await withEnv({ NODE_ENV: "development", ENABLE_TEST_AUTH: "1" }, async () => {
    const res = mockRes();
    await handler(mockReq({ body: { account: "real_damon" } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res._body?.error, "unknown_fixture_account");
    assert.ok(!res._body?.token);
  });
});

// ── T5b: Missing account field → 400 ──────────────────────────────────────────
test("T5b — missing account field → 400", async () => {
  await withEnv({ NODE_ENV: "development", ENABLE_TEST_AUTH: "1" }, async () => {
    const res = mockRes();
    await handler(mockReq({ body: {} }), res);
    assert.equal(res.statusCode, 400);
    assert.ok(!res._body?.token);
  });
});

// ── T6: Response does not expose JWT_SECRET ────────────────────────────────────
test("T6 — response body does not expose JWT_SECRET", async () => {
  const SENTINEL = "TOP_SECRET_" + randomUUID();
  const origSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SENTINEL;
  generatedToken = () => "opaque-token";  // not the secret value

  try {
    await withEnv({ NODE_ENV: "development", ENABLE_TEST_AUTH: "1" }, async () => {
      const res = mockRes();
      await handler(mockReq({ body: { account: "test_admin" } }), res);
      const bodyStr = JSON.stringify(res._body || {});
      assert.ok(!bodyStr.includes(SENTINEL), "Response must NOT contain JWT_SECRET value");
    });
  } finally {
    if (origSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = origSecret;
    generatedToken = () => "stub-token-" + randomUUID();
  }
});

// ── T7: Handler does not console.log the token ────────────────────────────────
test("T7 — handler does not console.log the token value", async () => {
  const TOKEN = "DO-NOT-LOG-THIS-" + randomUUID();
  const logged = [];
  const origLog  = console.log;
  const origInfo = console.info;
  console.log  = (...a) => logged.push(a.join(" "));
  console.info = (...a) => logged.push(a.join(" "));
  generatedToken = () => TOKEN;

  try {
    await withEnv({ NODE_ENV: "development", ENABLE_TEST_AUTH: "1" }, async () => {
      const res = mockRes();
      await handler(mockReq({ body: { account: "test_admin" } }), res);
    });
  } finally {
    console.log  = origLog;
    console.info = origInfo;
    generatedToken = () => "stub-token-" + randomUUID();
  }

  for (const line of logged) {
    assert.ok(!line.includes(TOKEN), `Token must not appear in logs: "${line}"`);
  }
});

// ── T8: Handler does not write to DB ─────────────────────────────────────────
// The mocked module has NO db.js import at all (replaced with no-op).
// If the handler tried to call getPool() or pool.query(), it would throw because
// no pool is provided. Test passes only if handler succeeds without DB access.
test("T8 — handler completes without any DB write", async () => {
  await withEnv({ NODE_ENV: "development", ENABLE_TEST_AUTH: "1" }, async () => {
    const res = mockRes();
    await assert.doesNotReject(
      async () => handler(mockReq({ body: { account: "test_finance" } }), res),
      "Handler must not throw (i.e. not attempt DB access)"
    );
    assert.equal(res.statusCode, 200, "200 confirms no DB was needed");
  });
});

// ── T-alias: test_platform_admin is alias for test_admin ──────────────────────
test("T-alias — test_platform_admin → same as test_admin", async () => {
  await withEnv({ NODE_ENV: "test", ENABLE_TEST_AUTH: "1" }, async () => {
    const res = mockRes();
    await handler(mockReq({ body: { account: "test_platform_admin" } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._body?.user?.role, "admin");
  });
});

// ── T-options: OPTIONS → 200 ──────────────────────────────────────────────────
test("T-options — OPTIONS request → 200", async () => {
  await withEnv({ NODE_ENV: "production", ENABLE_TEST_AUTH: "0" }, async () => {
    const res = mockRes();
    await handler(mockReq({ method: "OPTIONS" }), res);
    assert.equal(res.statusCode, 200);
  });
});

// ── T-method: non-POST → 405 ──────────────────────────────────────────────────
test("T-method — GET request → 405", async () => {
  await withEnv({ NODE_ENV: "development", ENABLE_TEST_AUTH: "1" }, async () => {
    const res = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    assert.equal(res.statusCode, 405);
  });
});
