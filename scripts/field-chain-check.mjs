#!/usr/bin/env node

const DEFAULT_BASE = "https://ai.sanlyn.cn";
const MODULES = [
  "shipping_plans",
  "orders",
  "products",
  "order_line_items",
  "companies",
  "customers",
  "countries",
  "ports",
  "container_bookings",
  "customs",
];

const base = (process.env.SANLYN_BASE || DEFAULT_BASE).replace(/\/+$/, "");
const username = process.env.SANLYN_USER;
const password = process.env.SANLYN_PASS;
const modulesArg = process.argv.find(arg => arg.startsWith("--modules="));
const stampArg = process.argv.find(arg => arg.startsWith("--stamp=") || arg.startsWith("--timestamp="));
const positionalStamp = process.argv.slice(2).find(arg => !arg.startsWith("--"));
const stamp = stampArg ? stampArg.split("=").slice(1).join("=") : positionalStamp;
const modules = modulesArg
  ? modulesArg.slice("--modules=".length).split(",").map(v => v.trim()).filter(Boolean)
  : MODULES;

if (!username || !password) {
  console.error("FAIL config SANLYN_USER and SANLYN_PASS are required");
  process.exit(2);
}

if (!stamp) {
  console.error("FAIL config timestamp required: pass --stamp=<string> or a positional stamp");
  process.exit(2);
}

function stableString(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.keys(input).sort().reduce((acc, key) => {
        acc[key] = normalize(input[key]);
        return acc;
      }, {});
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function request(path, options = {}, token = "") {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    body = null;
  }
  if (!res.ok || body?.success === false) {
    const reason = body?.error || body?.message || res.statusText || "request failed";
    throw new Error(`HTTP ${res.status} ${reason}`);
  }
  return body;
}

async function login() {
  const body = await request("/api/db/auth-login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!body?.token) throw new Error("login returned no token");
  return body.token;
}

async function getLayout(moduleKey, token) {
  return request(`/api/db/field-layout?module_key=${encodeURIComponent(moduleKey)}`, {}, token);
}

async function patchLayout(moduleKey, layoutJson, token) {
  return request(`/api/db/field-layout?module_key=${encodeURIComponent(moduleKey)}`, {
    method: "PATCH",
    body: JSON.stringify({ module_key: moduleKey, layout_json: layoutJson }),
  }, token);
}

async function restore(moduleKey, original, token) {
  if (!original || typeof original !== "object" || Array.isArray(original)) return;
  await patchLayout(moduleKey, original, token);
}

async function checkModule(moduleKey, token) {
  let original = null;
  try {
    const first = await getLayout(moduleKey, token);
    original = first.layout_json;
    const firstBytes = byteSize(original);
    const versionText = first.version == null ? "version=null" : `version=${first.version}`;
    const updatedText = first.updated_at ? `updated_at=${first.updated_at}` : "updated_at=null";

    if (!original || typeof original !== "object" || Array.isArray(original)) {
      console.log(`${moduleKey} PASS get empty ${versionText} ${updatedText} bytes=${firstBytes}`);
      return true;
    }

    console.log(`${moduleKey} PASS get ${versionText} ${updatedText} bytes=${firstBytes}`);
    const marked = clone(original);
    marked.__chain_check = stamp;
    await patchLayout(moduleKey, marked, token);
    console.log(`${moduleKey} PASS patch marker=${stamp}`);

    const afterWrite = await getLayout(moduleKey, token);
    if (afterWrite.layout_json?.__chain_check !== stamp) {
      throw new Error("__chain_check missing after readback");
    }
    console.log(`${moduleKey} PASS readback marker=${stamp}`);

    await patchLayout(moduleKey, original, token);
    console.log(`${moduleKey} PASS restore patch`);

    const afterRestore = await getLayout(moduleKey, token);
    if (stableString(afterRestore.layout_json) !== stableString(original)) {
      throw new Error("restore readback differs from original");
    }
    console.log(`${moduleKey} PASS restored bytes=${byteSize(afterRestore.layout_json)}`);
    return true;
  } catch (error) {
    try {
      await restore(moduleKey, original, token);
      console.log(`${moduleKey} RESTORE best-effort attempted`);
    } catch (restoreError) {
      console.log(`${moduleKey} RESTORE failed ${restoreError.message}`);
    }
    console.log(`${moduleKey} FAIL ${error.message}`);
    return false;
  }
}

let passed = 0;
let token = "";
try {
  token = await login();
  console.log(`LOGIN PASS base=${base} modules=${modules.join(",")}`);
} catch (error) {
  console.log(`LOGIN FAIL ${error.message}`);
  console.log(`CHAIN-CHECK RESULT: 0/${modules.length} PASS`);
  process.exit(1);
}

for (const moduleKey of modules) {
  if (!MODULES.includes(moduleKey)) {
    console.log(`${moduleKey} FAIL module not whitelisted`);
    continue;
  }
  if (await checkModule(moduleKey, token)) passed += 1;
}

console.log(`CHAIN-CHECK RESULT: ${passed}/${modules.length} PASS`);
process.exit(passed === modules.length ? 0 : 1);

/*
Change log:
- L1-L36: Added env/argv parsing for base URL, credentials, module list, and caller-provided stamp.
- L60-L149: Added login, GET/PATCH/readback/restore chain check that only mutates __chain_check.
- L154-L174: Added compact PASS/FAIL summary and exit code for cron/CI use.
*/
