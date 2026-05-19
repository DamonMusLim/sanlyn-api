// product-factory-writein.smoke.mjs — Factory Write-in V1 (2026-05-20)
//
// Run: node api/__smoke__/product-factory-writein.smoke.mjs
//
// Covers Damon's 12 verification cases for the PATCH
// /api/db/products/:sku/factory-profile endpoint. Pure-function level —
// tests the canWriteFactoryProfile helper + the body whitelist constants.
// Read/write semantics of the handler itself are covered by manual smoke
// against staging (DB-dependent), not here.

import {
  canWriteFactoryProfile,
  FACTORY_PROFILE_WRITABLE_KEYS,
  FACTORY_PROFILE_REJECTED_KEYS,
  applyProductFieldWhitelist,
  resolvePartyAlias,
} from "../lib/product-scope.js";

let pass = 0, fail = 0;
const fails = [];
function check(label, ok) {
  if (ok) { pass++; process.stdout.write(`  ✔ ${label}\n`); }
  else    { fail++; fails.push(label); process.stdout.write(`  ✘ ${label}\n`); }
}

// ─── §1: canWriteFactoryProfile permission gate ─────────────────────────────
process.stdout.write("\n§1 canWriteFactoryProfile\n");
{
  // No req.user → forbidden
  const a = canWriteFactoryProfile(null);
  check("null reqUser → ok=false", a.ok === false);

  // Customer → forbidden
  const c1 = canWriteFactoryProfile({ role: "customer", companyCode: "CN-00040" }, "CN-00001");
  check("customer → ok=false", c1.ok === false);

  // Buyer → forbidden
  const c2 = canWriteFactoryProfile({ role: "buyer", companyCode: "CN-00040" }, "CN-00001");
  check("buyer → ok=false", c2.ok === false);

  // Unknown role → forbidden
  const u = canWriteFactoryProfile({ role: "wizard" }, "CN-00001");
  check("unknown role → ok=false", u.ok === false);

  // Admin without target → forbidden (must supply target for proxy write)
  const adminNoTarget = canWriteFactoryProfile({ role: "admin" }, "");
  check("admin without target → ok=false (proxy write requires target)", adminNoTarget.ok === false);

  // Admin with target → allowed
  const admin = canWriteFactoryProfile({ role: "admin" }, "CN-00001");
  check("admin with target → ok=true", admin.ok === true && admin.targetFactoryCompanyCode === "CN-00001");

  // Logistics with target → allowed
  const log = canWriteFactoryProfile({ role: "logistics" }, "CN-00001");
  check("logistics with target → ok=true", log.ok === true && log.targetFactoryCompanyCode === "CN-00001");

  // Finance with target → allowed
  const fin = canWriteFactoryProfile({ role: "finance" }, "CN-00001");
  check("finance with target → ok=true", fin.ok === true);

  // Platform_finance (canonical) with target → allowed
  const pf = canWriteFactoryProfile({ role: "platform_finance" }, "CN-00001");
  check("platform_finance with target → ok=true", pf.ok === true);

  // Factory writes own code → allowed, target locked to own
  const fac1 = canWriteFactoryProfile({ role: "factory", companyCode: "CN-00001" }, undefined);
  check("factory no target → ok=true, locked to own", fac1.ok === true && fac1.targetFactoryCompanyCode === "CN-00001");

  const fac2 = canWriteFactoryProfile({ role: "factory", companyCode: "CN-00001" }, "CN-00001");
  check("factory target=own → ok=true", fac2.ok === true && fac2.targetFactoryCompanyCode === "CN-00001");

  // Factory tries to write OTHER factory's code → forbidden
  const fac3 = canWriteFactoryProfile({ role: "factory", companyCode: "CN-00001" }, "CN-00099");
  check("factory target=OTHER → ok=false (cross-factory write blocked)", fac3.ok === false);

  // Factory without company_code → forbidden
  const facNoCode = canWriteFactoryProfile({ role: "factory" }, "CN-00001");
  check("factory without companyCode → ok=false", facNoCode.ok === false);

  // Trader / sales / operator / customs → forbidden (not on factory profile gate)
  const t = canWriteFactoryProfile({ role: "trader" }, "CN-00001");
  check("trader → ok=false", t.ok === false);
  const s = canWriteFactoryProfile({ role: "sales" }, "CN-00001");
  check("sales → ok=false", s.ok === false);
  const op = canWriteFactoryProfile({ role: "operator" }, "CN-00001");
  check("operator → ok=false", op.ok === false);
  const cu = canWriteFactoryProfile({ role: "customs" }, "CN-00001");
  check("customs → ok=false", cu.ok === false);
}

// ─── §2: Body whitelist constants ───────────────────────────────────────────
process.stdout.write("\n§2 Writable-key allow-list\n");
{
  const required = [
    "factory_product_code", "factory_product_name", "factory_spec",
    "moq", "lead_time_days", "production_status",
    "package_requirement", "material_requirement", "qc_requirement",
    "factory_notes",
  ];
  for (const k of required) {
    check(`writable: ${k}`, FACTORY_PROFILE_WRITABLE_KEYS.includes(k));
  }
  check("writable list length = 10", FACTORY_PROFILE_WRITABLE_KEYS.length === 10);

  // Frozen — cannot be mutated at runtime
  let frozenOK = true;
  try { FACTORY_PROFILE_WRITABLE_KEYS.push("hacked"); frozenOK = false; }
  catch (_) { /* expected */ }
  check("writable list is frozen", frozenOK && !FACTORY_PROFILE_WRITABLE_KEYS.includes("hacked"));
}

process.stdout.write("\n§3 Rejected-key deny-list\n");
{
  const banned = [
    "factory_price", "sanlyn_price", "sales_price", "customs_declared_price",
    "invoice_price", "tax_rebate_rate", "tax_rate", "rebate_rate",
    "profit", "margin", "pricing",
    "customer_sku", "customer_alias",
    "aliases", "factory_profile", "raw", "id", "sku", "active",
  ];
  for (const k of banned) {
    check(`rejected: ${k}`, FACTORY_PROFILE_REJECTED_KEYS.includes(k));
  }
}

// ─── §4: GET-side visibility after write (no DB; uses scope resolvers) ──────
// Simulate a product row where someone has already populated raw.factory_profile
// + raw.aliases.factory. Verify GET-time scope still hides correctly.
process.stdout.write("\n§4 Post-write GET visibility\n");
{
  function row() {
    return {
      id: 1, sku: "WP-62", product_name: "x", brand: "PETSOME",
      factory_code: "CN-00001",
      factory_price: 12.5,    // top-level pricing must still be stripped for non-admin
      raw: {
        factory_profile: {
          factory_company_code: "CN-00001",
          factory_product_code: "FX-001",
          factory_product_name: "工厂内部名",
          moq: 50,
          lead_time_days: 21,
          updated_by_user_id: "u1",
          source: "factory_writein_v1",
        },
        aliases: {
          factory: {
            "CN-00001": { code: "FX-001", name: "工厂内部名", source: "factory_writein_v1" },
            "CN-00099": { code: "FX-OTHER", name: "其他工厂", source: "factory_writein_v1" },
          },
          customer: {
            "CN-00040": { sku: "ZC-16", name: "Petsome", is_orderable: true },
          },
        },
      },
    };
  }

  // (Case 10) customer GET: must not see factory_profile internals
  const custRow = row();
  applyProductFieldWhitelist([custRow], { role: "customer", companyCode: "CN-00040" });
  resolvePartyAlias(custRow, { role: "customer", companyCode: "CN-00040" });
  const custJson = JSON.stringify(custRow);
  check("customer GET: no FX-001 (factory alias)", custJson.indexOf("FX-001") === -1);
  check("customer GET: no FX-OTHER (other factory)", custJson.indexOf("FX-OTHER") === -1);
  check("customer GET: own alias ZC-16 visible", custJson.indexOf("ZC-16") !== -1);
  check("customer GET: no factory_price",      custJson.indexOf("factory_price") === -1);
  // factory_profile lives under raw.factory_profile. CUSTOMER_HIDE_FIELDS
  // includes "factory_profile" (added 2026-05-20) so the entire struct is
  // stripped from customer responses.
  check("customer GET: raw.factory_profile stripped",
        !isPresent(custRow, "raw", "factory_profile"));
  check("customer GET: no factory_product_code anywhere",
        custJson.indexOf("factory_product_code") === -1);

  // (Case 11) factory A GET: only own alias, never other factory's alias
  const facRow = row();
  applyProductFieldWhitelist([facRow], { role: "factory", companyCode: "CN-00001" });
  resolvePartyAlias(facRow, { role: "factory", companyCode: "CN-00001" });
  const facJson = JSON.stringify(facRow);
  check("factory A GET: own alias FX-001 visible",   facJson.indexOf("FX-001") !== -1);
  check("factory A GET: no FX-OTHER (cross-factory)", facJson.indexOf("FX-OTHER") === -1);
  check("factory A GET: no ZC-16 (customer alias)",   facJson.indexOf("ZC-16") === -1);

  // (Case 12) admin GET: full factory_profile + full aliases map
  const adminRow = row();
  applyProductFieldWhitelist([adminRow], { role: "admin" });
  resolvePartyAlias(adminRow, { role: "admin" });
  check("admin GET: factory_profile present",        adminRow.raw.factory_profile && adminRow.raw.factory_profile.factory_product_code === "FX-001");
  check("admin GET: aliases.factory map full",       adminRow.raw.aliases && adminRow.raw.aliases.factory["CN-00001"] && adminRow.raw.aliases.factory["CN-00099"]);
}

function isPresent(obj, ...path) {
  let cur = obj;
  for (const p of path) {
    if (cur == null || typeof cur !== "object") return false;
    cur = cur[p];
  }
  return cur !== undefined;
}

// ─── Summary ────────────────────────────────────────────────────────────────
process.stdout.write(`\nResults: ${pass} pass, ${fail} fail\n`);
if (fail) {
  process.stdout.write("\nFailed:\n");
  for (const f of fails) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
