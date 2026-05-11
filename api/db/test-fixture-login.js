// api/db/test-fixture-login.js — Dev-only test auth fixture
// TOOLCHAIN-TEST-ACCOUNT-FIXTURE-001
//
// ⚠️  PRODUCTION BEHAVIOUR: returns 404. This endpoint is a dead-end in prod.
//
// Purpose:
//   Allow A/B automation agents (Composer, order-recording) to obtain a valid JWT
//   without requiring Damon to manually paste tokens or credentials.
//
// Guards (both must be satisfied to return a token):
//   1. NODE_ENV !== 'production'
//   2. ENABLE_TEST_AUTH === '1'
//
// Usage:
//   POST /api/db/test-fixture-login
//   Body: { "account": "test_admin" }
//   Returns: { success: true, token: "...", user: { username, role, ... } }
//
// Fixture accounts (no DB query, no password required):
//   test_admin            → role: admin  (maps to platform_admin canonical)
//   test_finance          → role: finance (maps to platform_finance canonical)
//   test_operator         → role: internal (maps to internal_operator canonical)
//   test_platform_admin   → alias for test_admin
//   test_platform_finance → alias for test_finance
//
// Security properties:
//   ✅ Returns 404 in production (NODE_ENV === 'production')
//   ✅ Returns 403 if ENABLE_TEST_AUTH !== '1'
//   ✅ Returns 400 for unknown fixture accounts
//   ✅ Uses generateToken() — never reads JWT_SECRET directly
//   ✅ Does NOT write to DB
//   ✅ Does NOT print token to console / logs
//   ✅ Does NOT expose JWT_SECRET in response
//   ✅ Fixture UIDs are non-conflicting (negative integers, never valid DB rows)
//
// NOT for use in production. NOT an alternative to real login.
// Controlled by ENABLE_TEST_AUTH env var; never set in pm2 prod env.

import { setCors } from "../db.js";
import { generateToken } from "../auth.js";

// ── Fixture account registry ──────────────────────────────────────────────────
// Negative UIDs ensure these never collide with real account rows.
// Role strings use the OLD canonical names (matching accounts.role in DB).
// The canonicalRole() shim in financePreviewGate maps these to F-layer names.
const FIXTURE_ACCOUNTS = {
  test_admin: {
    uid:      -1,
    username: 'test_admin',
    role:     'admin',
    company:  'SANLYN TEST',
    companyCode: 'SANLYN_TEST',
    companyCodes: ['SANLYN_TEST'],
    supplierRole: null,
    access:   [],
  },
  test_platform_admin: null,          // alias → resolved below

  test_finance: {
    uid:      -2,
    username: 'test_finance',
    role:     'finance',
    company:  'SANLYN TEST',
    companyCode: 'SANLYN_TEST',
    companyCodes: ['SANLYN_TEST'],
    supplierRole: null,
    access:   [],
  },
  test_platform_finance: null,        // alias → resolved below

  test_operator: {
    uid:      -3,
    username: 'test_operator',
    role:     'internal',
    company:  'SANLYN TEST',
    companyCode: 'SANLYN_TEST',
    companyCodes: ['SANLYN_TEST'],
    supplierRole: null,
    access:   [],
  },
};

// Resolve aliases
FIXTURE_ACCOUNTS.test_platform_admin   = FIXTURE_ACCOUNTS.test_admin;
FIXTURE_ACCOUNTS.test_platform_finance = FIXTURE_ACCOUNTS.test_finance;

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Guard 1: production fail-closed ──────────────────────────────────────
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }

  // ── Guard 2: feature flag ─────────────────────────────────────────────────
  if (process.env.ENABLE_TEST_AUTH !== "1") {
    return res.status(403).json({
      error:  "test_auth_disabled",
      detail: "Set ENABLE_TEST_AUTH=1 in your local .env to enable fixture login.",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { account } = req.body || {};

  // ── Guard 3: known fixture account only ──────────────────────────────────
  const fixture = account ? FIXTURE_ACCOUNTS[String(account).trim()] : null;
  if (!fixture) {
    return res.status(400).json({
      error:   "unknown_fixture_account",
      detail:  `'${account}' is not a known fixture account.`,
      allowed: Object.keys(FIXTURE_ACCOUNTS).filter(k => FIXTURE_ACCOUNTS[k] !== null && FIXTURE_ACCOUNTS[k] !== FIXTURE_ACCOUNTS.test_admin || k === 'test_admin' || k === 'test_finance' || k === 'test_operator'),
    });
  }

  // ── Generate token (via standard generateToken — does not expose JWT_SECRET) ──
  // Token payload mirrors the shape produced by auth-login.js so the frontend
  // and all downstream middleware treats it identically.
  const token = generateToken({
    uid:          fixture.uid,
    username:     fixture.username,
    role:         fixture.role,
    company:      fixture.company,
    supplierRole: fixture.supplierRole,
    companyCode:  fixture.companyCode,
    companyCodes: fixture.companyCodes,
    access:       fixture.access,
    _fixture:     true,   // audit marker — lets logs flag fixture sessions
  });

  // ── Respond — same shape as auth-login.js ────────────────────────────────
  // token is returned to caller for localStorage injection.
  // ⚠️ Never log the token value; only the username is safe to log.
  return res.status(200).json({
    success: true,
    _dev:    "fixture",   // marks response as fixture — callers can warn UI
    token:   token,
    user: {
      uid:          fixture.uid,
      username:     fixture.username,
      role:         fixture.role,
      company:      fixture.company,
      supplierRole: fixture.supplierRole,
      companyCode:  fixture.companyCode,
      companyCodes: fixture.companyCodes,
      access:       fixture.access,
      _fixture:     true,
    },
  });
}
