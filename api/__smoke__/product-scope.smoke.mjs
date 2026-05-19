// product-scope.smoke.mjs — P0-0 Product Master V1 user scope tests
//
// Run: node api/__smoke__/product-scope.smoke.mjs
//
// Covers the 7 verification cases from the P0-0 spec:
//   1. customer A cannot see customer B's aliases or product rows
//   2. factory A cannot see factory B's aliases or product rows
//   3. customer response contains no pricing/margin
//   4. factory response contains no sales_price / profit / rebate
//   5. missing user scope → fail-closed (null / [])
//   6. admin/finance read everything
//   7. front-end-supplied filter hints do NOT escalate permission

import {
  getProductScope,
  applyProductRowScope,
  applyProductFieldWhitelist,
  resolvePartyAlias,
  resolvePricingVisibility,
  applyAllVisibility,
} from "../lib/product-scope.js";

let pass = 0, fail = 0;
const fails = [];
function check(label, ok) {
  if (ok) { pass++; process.stdout.write(`  ✔ ${label}\n`); }
  else    { fail++; fails.push(label); process.stdout.write(`  ✘ ${label}\n`); }
}

function makeRow(overrides = {}) {
  return Object.assign({
    id: 1,
    sku: "WP-62",
    product_name: "Sniffly Dog Tray",
    brand: "PETSOME",
    factory_code: "CN-00001",
    factory_name: "XIAMEN PET BABY",
    factory_price: 12.5,
    sanlyn_price: 18.0,
    price_usd: 2.6,
    profit: 5.5,
    rebate_rate: 0.13,
    tax_rate: 0.13,
    declaration_amount: 100,
    raw: {
      aliases: {
        customer: {
          "CN-00040": { sku: "ZC-16", name: "Petsome Chicken 200g", is_orderable: true },
          "CN-00041": { sku: "OTHER-99", name: "Other Buyer Name", is_orderable: false },
        },
        factory: {
          "CN-00001": { code: "FX-001", name: "Plant A name" },
          "CN-00002": { code: "FX-OTHER", name: "Plant B name" },
        },
      },
      pricing: {
        factory_price: { value: 12.5, currency: "CNY", unit: "per_ctn", scope_company_code: "CN-00001" },
        sales_price:   { value: 18.0, currency: "USD", unit: "per_ctn", scope_company_code: "CN-00040" },
        customs_declared_price: { value: 10.0, currency: "USD", unit: "per_ctn" },
        tax_rebate_rate: { value: 0.13 },
        invoice_price: { value: 17.5, currency: "USD" },
      },
    },
  }, overrides);
}

// ─── §1: getProductScope role classification ─────────────────────────────────
process.stdout.write("\n§1 getProductScope\n");
{
  check("null req.user → null",            getProductScope(null) === null);
  check("undefined req.user → null",       getProductScope(undefined) === null);
  check("no role → null",                  getProductScope({}) === null);
  check("unknown role → null",             getProductScope({ role: "wizard", companyCode: "CN-1" }) === null);

  const admin = getProductScope({ role: "admin" });
  check("admin → mode=full",               admin && admin.mode === "full");

  const finance = getProductScope({ role: "finance" });
  check("finance → mode=full",             finance && finance.mode === "full");

  const log = getProductScope({ role: "logistics" });
  check("logistics → mode=internal_restricted", log && log.mode === "internal_restricted");

  const trader = getProductScope({ role: "trader" });
  check("trader → mode=internal_restricted",    trader && trader.mode === "internal_restricted");

  const fac = getProductScope({ role: "factory", companyCode: "CN-00001" });
  check("factory with code → mode=factory",     fac && fac.mode === "factory" && fac.codes[0] === "CN-00001");

  const facNoCode = getProductScope({ role: "factory" });
  check("factory without code → null (fail-closed)", facNoCode === null);

  const cust = getProductScope({ role: "customer", companyCodes: ["CN-00040"] });
  check("customer with code → mode=customer",   cust && cust.mode === "customer");

  const custNoCode = getProductScope({ role: "customer" });
  check("customer without code → null (fail-closed)", custNoCode === null);

  // Verify front-end-supplied "filter hint" doesn't change scope (companyCode
  // comes from req.user, not query). This module only consults reqUser.
  const factoryA = getProductScope({ role: "factory", companyCode: "CN-00001" });
  check("factory A scope.codes only contains caller's own", factoryA.codes.length === 1 && factoryA.codes[0] === "CN-00001");
}

// ─── §2: applyProductRowScope row filter ─────────────────────────────────────
process.stdout.write("\n§2 applyProductRowScope\n");
{
  const rows = [
    makeRow({ id: 1, factory_code: "CN-00001" }),
    makeRow({ id: 2, factory_code: "CN-00002" }),
    makeRow({ id: 3, factory_code: "CN-00003" }),
  ];

  // factory A → only own rows
  const factoryA = applyProductRowScope(JSON.parse(JSON.stringify(rows)), { role: "factory", companyCode: "CN-00001" });
  check("factory A gets only own row", factoryA.length === 1 && factoryA[0].id === 1);

  // factory B → only own rows; A's rows excluded
  const factoryB = applyProductRowScope(JSON.parse(JSON.stringify(rows)), { role: "factory", companyCode: "CN-00002" });
  check("factory B gets only own row (no cross-factory leak)", factoryB.length === 1 && factoryB[0].id === 2);

  // factory with multiple codes
  const factoryAB = applyProductRowScope(JSON.parse(JSON.stringify(rows)), { role: "factory", companyCodes: ["CN-00001", "CN-00002"] });
  check("factory with multi-codes gets both rows", factoryAB.length === 2);

  // factory matches via raw.factoryCode fallback
  const rowsRawOnly = [
    { id: 10, raw: { factoryCode: "CN-00001" } },
    { id: 11, raw: { factoryCode: "CN-00099" } },
  ];
  const facRaw = applyProductRowScope(rowsRawOnly, { role: "factory", companyCode: "CN-00001" });
  check("factory matches via raw.factoryCode fallback", facRaw.length === 1 && facRaw[0].id === 10);

  // factory without companyCode → fail-closed (null scope → [])
  const facFail = applyProductRowScope(rows, { role: "factory" });
  check("factory without companyCode → [] (fail-closed)", facFail.length === 0);

  // admin gets everything
  const adminRows = applyProductRowScope(JSON.parse(JSON.stringify(rows)), { role: "admin" });
  check("admin gets all rows", adminRows.length === 3);

  // customer mode: row filter is no-op here (SQL brand-scoping handles)
  const custRows = applyProductRowScope(JSON.parse(JSON.stringify(rows)), { role: "customer", companyCode: "CN-00040" });
  check("customer row filter no-op (brand-scoping is SQL-side)", custRows.length === 3);

  // null req.user → []
  const nullRows = applyProductRowScope(JSON.parse(JSON.stringify(rows)), null);
  check("null req.user → []", nullRows.length === 0);

  // unknown role → []
  const wizRows = applyProductRowScope(JSON.parse(JSON.stringify(rows)), { role: "wizard", companyCode: "CN-00001" });
  check("unknown role → [] (fail-closed)", wizRows.length === 0);
}

// ─── §3: applyProductFieldWhitelist ──────────────────────────────────────────
process.stdout.write("\n§3 applyProductFieldWhitelist\n");
{
  // Customer: no factory_price, sanlyn_price, profit, rebate
  const custRows = [makeRow()];
  applyProductFieldWhitelist(custRows, { role: "customer", companyCode: "CN-00040" });
  check("customer cannot see factory_price",  custRows[0].factory_price === undefined);
  check("customer cannot see sanlyn_price",   custRows[0].sanlyn_price === undefined);
  check("customer cannot see profit",         custRows[0].profit === undefined);
  check("customer cannot see rebate_rate",    custRows[0].rebate_rate === undefined);
  check("customer cannot see factory_code",   custRows[0].factory_code === undefined);
  check("customer cannot see factory_name",   custRows[0].factory_name === undefined);

  // Factory: cannot see sales-side (sanlyn_price / profit / rebate); CAN see own factory_price
  const facRows = [makeRow()];
  applyProductFieldWhitelist(facRows, { role: "factory", companyCode: "CN-00001" });
  check("factory CAN see factory_price",      facRows[0].factory_price === 12.5);
  check("factory cannot see sanlyn_price",    facRows[0].sanlyn_price === undefined);
  check("factory cannot see profit",          facRows[0].profit === undefined);
  check("factory cannot see rebate_rate",     facRows[0].rebate_rate === undefined);

  // Admin: keeps everything
  const adminRows = [makeRow()];
  applyProductFieldWhitelist(adminRows, { role: "admin" });
  check("admin keeps factory_price",          adminRows[0].factory_price === 12.5);
  check("admin keeps sanlyn_price",           adminRows[0].sanlyn_price === 18.0);
  check("admin keeps profit",                 adminRows[0].profit === 5.5);

  // Trader: hides factory cost but keeps sanlyn_price
  const traderRows = [makeRow()];
  applyProductFieldWhitelist(traderRows, { role: "trader" });
  check("trader cannot see factory_price",    traderRows[0].factory_price === undefined);
  check("trader cannot see profit",           traderRows[0].profit === undefined);
  check("trader keeps sanlyn_price",          traderRows[0].sanlyn_price === 18.0);

  // null req.user → fail-closed: returns []
  const nullRows = [makeRow()];
  const nullOut = applyProductFieldWhitelist(nullRows, null);
  check("null req.user → returns [] (fail-closed)", Array.isArray(nullOut) && nullOut.length === 0);
}

// ─── §4: resolvePartyAlias single-party view ────────────────────────────────
process.stdout.write("\n§4 resolvePartyAlias\n");
{
  // Customer A sees only own alias; B's alias absent
  const rowA = makeRow();
  resolvePartyAlias(rowA, { role: "customer", companyCode: "CN-00040" });
  check("customer A sees own alias",          rowA.alias && rowA.alias.sku === "ZC-16");
  check("customer A cannot see customer B alias map", rowA.raw.aliases === undefined);
  check("alias object does NOT contain CN-00041", JSON.stringify(rowA).indexOf("OTHER-99") === -1);

  // Customer B sees its own
  const rowB = makeRow();
  resolvePartyAlias(rowB, { role: "customer", companyCode: "CN-00041" });
  check("customer B sees own alias",          rowB.alias && rowB.alias.sku === "OTHER-99");
  check("customer B response has no ZC-16",   JSON.stringify(rowB).indexOf("ZC-16") === -1);

  // Factory A sees own factory alias only
  const rowFA = makeRow();
  resolvePartyAlias(rowFA, { role: "factory", companyCode: "CN-00001" });
  check("factory A sees own factory alias",   rowFA.alias && rowFA.alias.code === "FX-001");
  check("factory A response has no FX-OTHER", JSON.stringify(rowFA).indexOf("FX-OTHER") === -1);

  // Customer sees no factory aliases
  const rowC = makeRow();
  resolvePartyAlias(rowC, { role: "customer", companyCode: "CN-00040" });
  check("customer response has no factory alias", JSON.stringify(rowC).indexOf("FX-001") === -1);

  // Admin keeps the full map
  const rowAdmin = makeRow();
  resolvePartyAlias(rowAdmin, { role: "admin" });
  check("admin keeps full aliases map",       rowAdmin.raw && rowAdmin.raw.aliases && rowAdmin.raw.aliases.customer);

  // null req.user → aliases stripped
  const rowNull = makeRow();
  resolvePartyAlias(rowNull, null);
  check("null req.user → aliases stripped",   !rowNull.raw.aliases);
}

// ─── §5: resolvePricingVisibility ────────────────────────────────────────────
process.stdout.write("\n§5 resolvePricingVisibility\n");
{
  // Customer: no pricing structures visible (column-level factory_price is the
  // separate responsibility of applyProductFieldWhitelist — see §6 E2E).
  const rowC = makeRow();
  resolvePricingVisibility(rowC, { role: "customer", companyCode: "CN-00040" });
  check("customer response has no raw.pricing", !rowC.raw.pricing);
  check("customer response has no pricing key", !rowC.pricing);

  // Factory A: only own factory_price (scope_company_code match)
  const rowF = makeRow();
  resolvePricingVisibility(rowF, { role: "factory", companyCode: "CN-00001" });
  check("factory sees own factory_price",     rowF.pricing && rowF.pricing.factory_price && rowF.pricing.factory_price.value === 12.5);
  check("factory does NOT see sales_price",   !rowF.pricing.sales_price);
  check("factory does NOT see tax_rebate_rate", !rowF.pricing.tax_rebate_rate);
  check("factory does NOT see invoice_price", !rowF.pricing.invoice_price);
  check("factory does NOT see raw.pricing",   !rowF.raw.pricing);

  // Factory B: no factory_price visible (scope_company_code mismatch)
  const rowFB = makeRow();
  resolvePricingVisibility(rowFB, { role: "factory", companyCode: "CN-00002" });
  check("factory B without matching scope sees no factory_price", !rowFB.pricing || !rowFB.pricing.factory_price);

  // Logistics (internal_restricted): masked summary
  const rowL = makeRow();
  resolvePricingVisibility(rowL, { role: "logistics" });
  check("logistics sees customs_declared_price",  rowL.pricing && rowL.pricing.customs_declared_price);
  check("logistics sees tax_rebate_rate",         rowL.pricing && rowL.pricing.tax_rebate_rate);
  check("logistics gets sales_price_status flag", rowL.pricing && rowL.pricing.sales_price_status === "configured");
  check("logistics does NOT get raw sales_price", !rowL.pricing.sales_price);

  // Admin: keeps full pricing
  const rowA = makeRow();
  resolvePricingVisibility(rowA, { role: "admin" });
  check("admin keeps raw.pricing intact",     rowA.raw.pricing && rowA.raw.pricing.factory_price.value === 12.5);

  // Trader (internal_restricted but reseller): no pricing leak — regression for
  // CODEX-REVIEW P1 (2026-05-19). Trader must NOT receive tax_rebate_rate or
  // any pricing status flags even though it shares the internal_restricted branch.
  const rowT = makeRow();
  resolvePricingVisibility(rowT, { role: "trader" });
  check("trader gets no raw.pricing",         !rowT.raw.pricing);
  check("trader gets no pricing key",         !rowT.pricing);
  check("trader response has no tax_rebate_rate", JSON.stringify(rowT).indexOf("tax_rebate_rate") === -1);
  check("trader response has no customs_declared_price", JSON.stringify(rowT).indexOf("customs_declared_price") === -1);
  check("trader response has no factory_price_status", JSON.stringify(rowT).indexOf("factory_price_status") === -1);

  // null req.user → pricing stripped
  const rowN = makeRow();
  resolvePricingVisibility(rowN, null);
  check("null req.user → pricing stripped",   !rowN.raw.pricing);
}

// ─── §6: applyAllVisibility convenience: integration ────────────────────────
process.stdout.write("\n§6 applyAllVisibility integration\n");
{
  // Customer A end-to-end: no pricing, no factory info, own alias only
  const rows = [makeRow(), makeRow({ id: 2, sku: "WP-99" })];
  applyAllVisibility(rows, { role: "customer", companyCode: "CN-00040" });
  const json = JSON.stringify(rows);
  check("E2E customer: no factory_price string",   json.indexOf("factory_price") === -1);
  check("E2E customer: no sanlyn_price string",    json.indexOf("sanlyn_price") === -1);
  check("E2E customer: no profit string",          json.indexOf("\"profit\"") === -1);
  check("E2E customer: no rebate_rate string",     json.indexOf("rebate_rate") === -1);
  check("E2E customer: no factory_code string",    json.indexOf("factory_code") === -1);
  check("E2E customer: no OTHER-99 (cross-customer alias)", json.indexOf("OTHER-99") === -1);
  check("E2E customer: no FX-001 (factory alias)", json.indexOf("FX-001") === -1);
  check("E2E customer: own alias present",         json.indexOf("ZC-16") !== -1);

  // Factory A end-to-end: own factory_price + own factory alias, no sales/profit
  const rowsF = [makeRow()];
  applyAllVisibility(rowsF, { role: "factory", companyCode: "CN-00001" });
  const jsonF = JSON.stringify(rowsF);
  check("E2E factory: own factory_price visible",  jsonF.indexOf("\"factory_price\"") !== -1);
  check("E2E factory: own alias FX-001 visible",   jsonF.indexOf("FX-001") !== -1);
  check("E2E factory: no FX-OTHER (cross-factory)",jsonF.indexOf("FX-OTHER") === -1);
  check("E2E factory: no sanlyn_price",            jsonF.indexOf("sanlyn_price") === -1);
  check("E2E factory: no profit",                  jsonF.indexOf("\"profit\":") === -1);
  check("E2E factory: no rebate_rate",             jsonF.indexOf("rebate_rate") === -1);
}

// ─── §6b: CODEX-REVIEW round 2 regressions ──────────────────────────────────
process.stdout.write("\n§6b CODEX-REVIEW round 2 regressions\n");
{
  // P2: canonical role aliases (financePreviewGate.js) must resolve to full
  const pf = getProductScope({ role: "platform_finance" });
  check("platform_finance → mode=full", pf && pf.mode === "full");
  const io = getProductScope({ role: "internal_operator" });
  check("internal_operator → mode=full", io && io.mode === "full");
  const pa = getProductScope({ role: "platform_admin" });
  check("platform_admin → mode=full", pa && pa.mode === "full");

  // P1: buyer role maps to customer-scoped (factory-invite-complete.js path)
  const buyerScope = getProductScope({ role: "buyer", companyCode: "CN-00040" });
  check("buyer role → mode=customer (not null)", buyerScope && buyerScope.mode === "customer");
  const buyerNoCode = getProductScope({ role: "buyer" });
  check("buyer without companyCode → null (fail-closed)", buyerNoCode === null);

  // P1: camelCase factory identifiers stripped for customer
  const rowCamel = {
    id: 1, sku: "WP-62", product_name: "x", brand: "PETSOME",
    raw: {
      factoryCode: "CN-00001",
      factoryName: "XIAMEN PET BABY",
      factoryCity: "Xiamen",
      factoryCompanyCode: "CN-00001",
      issuingCompany: "Sanlyn",
    },
  };
  applyProductFieldWhitelist([rowCamel], { role: "customer", companyCode: "CN-00040" });
  const jsonCamel = JSON.stringify(rowCamel);
  check("customer: raw.factoryCode stripped",         jsonCamel.indexOf("factoryCode") === -1);
  check("customer: raw.factoryName stripped",         jsonCamel.indexOf("factoryName") === -1);
  check("customer: raw.factoryCity stripped",         jsonCamel.indexOf("factoryCity") === -1);
  check("customer: raw.factoryCompanyCode stripped",  jsonCamel.indexOf("factoryCompanyCode") === -1);
  check("customer: raw.issuingCompany stripped",      jsonCamel.indexOf("issuingCompany") === -1);

  // Buyer path mirrors customer
  const rowBuyer = JSON.parse(JSON.stringify(rowCamel));
  applyProductFieldWhitelist([rowBuyer], { role: "buyer", companyCode: "CN-00040" });
  check("buyer: raw.factoryCode stripped (mirrors customer)", JSON.stringify(rowBuyer).indexOf("factoryCode") === -1);
}

// ─── §7: Front-end query params CANNOT escalate permission ──────────────────
process.stdout.write("\n§7 Front-end hints never escalate\n");
{
  // Simulate caller trying to spoof companyCode via "query" — module ignores
  // anything not on reqUser.
  const rows = [
    makeRow({ id: 1, factory_code: "CN-00001" }),
    makeRow({ id: 2, factory_code: "CN-00002" }),
  ];
  // factory A passes a malicious "filter hint" claiming to be factory B —
  // we still only consult req.user.companyCode (CN-00001).
  const reqUserA = { role: "factory", companyCode: "CN-00001" };
  const filtered = applyProductRowScope(JSON.parse(JSON.stringify(rows)), reqUserA);
  check("front-end hint cannot expand factory scope", filtered.length === 1 && filtered[0].id === 1);
}

// ─── Summary ────────────────────────────────────────────────────────────────
process.stdout.write(`\nResults: ${pass} pass, ${fail} fail\n`);
if (fail) {
  process.stdout.write("\nFailed:\n");
  for (const f of fails) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
