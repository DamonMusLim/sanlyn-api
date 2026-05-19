// products-put-role.smoke.mjs — P0-1 PUT /api/db/products role gate test
//
// Run: node api/__smoke__/products-put-role.smoke.mjs
//
// Unit-tests the canEditProductMasterData() helper that backs the PUT gate
// in api/db/products.js. Pure function — no DB / no auth dependency.

import { canEditProductMasterData } from "../lib/product-scope.js";

let pass = 0, fail = 0;
const fails = [];
function check(label, ok) {
  if (ok) { pass++; process.stdout.write(`  ✔ ${label}\n`); }
  else    { fail++; fails.push(label); process.stdout.write(`  ✘ ${label}\n`); }
}

process.stdout.write("\n§1 canEditProductMasterData — deny list\n");
check("null reqUser → false",                 canEditProductMasterData(null) === false);
check("undefined reqUser → false",            canEditProductMasterData(undefined) === false);
check("empty object (no role) → false",       canEditProductMasterData({}) === false);
check("customer → false",                     canEditProductMasterData({ role: "customer", companyCode: "CN-00040" }) === false);
check("buyer → false",                        canEditProductMasterData({ role: "buyer",    companyCode: "CN-00040" }) === false);
check("portal → false",                       canEditProductMasterData({ role: "portal",   companyCode: "CN-00040" }) === false);
check("external → false",                     canEditProductMasterData({ role: "external", companyCode: "CN-00040" }) === false);
check("factory → false",                      canEditProductMasterData({ role: "factory",  companyCode: "CN-00001" }) === false);
check("trader → false",                       canEditProductMasterData({ role: "trader",   companyCode: "CN-00003" }) === false);
check("sales → false (not on PUT allow-list)",canEditProductMasterData({ role: "sales" }) === false);
check("operator → false",                     canEditProductMasterData({ role: "operator" }) === false);
check("customs → false",                      canEditProductMasterData({ role: "customs" }) === false);
check("unknown role → false",                 canEditProductMasterData({ role: "wizard" }) === false);
check("system → false (cron only reads)",     canEditProductMasterData({ role: "system" }) === false);

process.stdout.write("\n§2 canEditProductMasterData — allow list\n");
check("admin → true",                         canEditProductMasterData({ role: "admin" }) === true);
check("super_admin → true",                   canEditProductMasterData({ role: "super_admin" }) === true);
check("superadmin → true",                    canEditProductMasterData({ role: "superadmin" }) === true);
check("platform_admin → true",                canEditProductMasterData({ role: "platform_admin" }) === true);
check("finance → true",                       canEditProductMasterData({ role: "finance" }) === true);
check("platform_finance → true",              canEditProductMasterData({ role: "platform_finance" }) === true);
check("logistics → true",                     canEditProductMasterData({ role: "logistics" }) === true);

process.stdout.write("\n§3 Case-insensitive normalisation\n");
check("ADMIN (uppercase) → true",             canEditProductMasterData({ role: "ADMIN" }) === true);
check("Finance (mixed case) → true",          canEditProductMasterData({ role: "Finance" }) === true);
check("FACTORY (uppercase) → false",          canEditProductMasterData({ role: "FACTORY" }) === false);

process.stdout.write(`\nResults: ${pass} pass, ${fail} fail\n`);
if (fail) {
  process.stdout.write("\nFailed:\n");
  for (const f of fails) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
