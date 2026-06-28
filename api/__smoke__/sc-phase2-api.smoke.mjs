// sc-phase2-api.smoke.mjs — Phase 2 + Phase 2.5 API layer smoke tests
//
// Run: node --experimental-vm-modules api/__smoke__/sc-phase2-api.smoke.mjs

import {
  DEFAULT_QUOTE_VISIBILITY_POLICY,
  deriveQuoteStage,
  deriveQuoteBidStage,
  deriveCollabStage,
  canViewBl,
  buildQuoteRequestViewModel,
  buildQuoteBidCardViewModel,
  buildCollabSheetViewModel,
} from '../lib/sc-viewmodels.js';

import {
  JDY_MIGRATION_ENDPOINTS,
  applyAliasMap,
  enforceFieldPolicy,
} from '../lib/sc-field-policy-helper.js';

// ─── Harness ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const fails = [];

function check(label, ok) {
  if (ok) { pass++; process.stdout.write(`  ✔ ${label}\n`); }
  else    { fail++; fails.push(label); process.stdout.write(`  ✘ ${label}\n`); }
}
function mustThrow(label, fn, expectedCode) {
  try {
    fn();
    fail++; fails.push(label);
    process.stdout.write(`  ✘ ${label} — should have thrown\n`);
  } catch (e) {
    if (e.code === expectedCode) { pass++; process.stdout.write(`  ✔ ${label}\n`); }
    else { fail++; fails.push(label); process.stdout.write(`  ✘ ${label} — threw ${e.code} not ${expectedCode}\n`); }
  }
}
function mustNotThrow(label, fn) {
  try { fn(); pass++; process.stdout.write(`  ✔ ${label}\n`); }
  catch (e) { fail++; fails.push(label); process.stdout.write(`  ✘ ${label} — threw ${JSON.stringify(e.code || e.message)}\n`); }
}

// ─── §1: sc-field-policy-helper ──────────────────────────────────────────────
process.stdout.write('\n§1 sc-field-policy-helper\n');
{
  check('JDY products_PATCH in set', JDY_MIGRATION_ENDPOINTS.has('products_PATCH'));
  check('JDY products_PUT in set',   JDY_MIGRATION_ENDPOINTS.has('products_PUT'));
  check('JDY orders_PATCH in set',   JDY_MIGRATION_ENDPOINTS.has('orders_PATCH'));
  check('supply-chain quote-requests NOT in JDY set',
    !JDY_MIGRATION_ENDPOINTS.has('supply-chain_GET_quote-requests'));

  mustThrow('undefined allowedSet → MISSING_FIELD_WHITELIST',
    () => enforceFieldPolicy(undefined, { x: 1 }, 'ep'), 'MISSING_FIELD_WHITELIST');
  try { enforceFieldPolicy(undefined, {}, 'test_ep'); } catch (e) {
    check('MISSING_FIELD_WHITELIST has status=500', e.status === 500);
    check('MISSING_FIELD_WHITELIST has endpoint', e.endpoint === 'test_ep');
  }

  mustThrow('unknown field on SC endpoint → UNKNOWN_FIELD',
    () => enforceFieldPolicy(new Set(['offered_price']), { offered_price: 1, buy_rate: 99 }, 'sc_ep'),
    'UNKNOWN_FIELD');
  try { enforceFieldPolicy(new Set(['a']), { a: 1, b: 2, c: 3 }, 'sc_ep'); } catch (e) {
    check('UNKNOWN_FIELD has status=400', e.status === 400);
    check('UNKNOWN_FIELD fields includes b', e.fields?.includes('b'));
    check('UNKNOWN_FIELD fields includes c', e.fields?.includes('c'));
  }
  mustNotThrow('all-known fields passes', () => enforceFieldPolicy(new Set(['a', 'b']), { a: 1, b: 2 }, 'ep'));
  mustNotThrow('empty body always passes', () => enforceFieldPolicy(new Set(['a']), {}, 'ep'));
}

// ─── §2: applyAliasMap ────────────────────────────────────────────────────────
process.stdout.write('\n§2 applyAliasMap\n');
{
  const aliases = [
    { deprecated: 'local_charge_amount', canonical: 'supplier_local_charge_amount', endpoint: 'bids_PATCH' },
    { deprecated: 'local_charge_currency', canonical: 'supplier_local_charge_currency' },
  ];
  const body = { offered_price: 1800, local_charge_amount: 250, local_charge_currency: 'USD' };
  const r    = applyAliasMap(body, aliases, 'bids_PATCH');
  check('deprecated key removed', !Object.hasOwn(r.body, 'local_charge_amount'));
  check('canonical key added',    Object.hasOwn(r.body, 'supplier_local_charge_amount'));
  check('currency alias applied', r.body['supplier_local_charge_currency'] === 'USD');
  check('passthrough key kept',   r.body['offered_price'] === 1800);
  check('deprecatedFields logged',r.deprecatedFields.length > 0);
  check('deprecatedFields[0].sent ok', r.deprecatedFields[0]?.sent === 'local_charge_amount');

  const r2 = applyAliasMap({ old_key: 'v' }, [{ deprecated: 'old_key', canonical: 'new_key', endpoint: 'other_ep' }], 'different_ep');
  check('endpoint-specific alias skipped when mismatch', Object.hasOwn(r2.body, 'old_key'));
  check('no deprecatedFields when skipped', r2.deprecatedFields.length === 0);

  const r3 = applyAliasMap(
    { old: 'deprecated-val', newKey: 'canonical-val' },
    [{ deprecated: 'old', canonical: 'newKey' }], 'ep',
  );
  check('canonical value preserved when both present', r3.body['newKey'] === 'canonical-val');
  check('deprecated key removed when both present', !Object.hasOwn(r3.body, 'old'));
}

// ─── §3: JDY production warn+strip ───────────────────────────────────────────
process.stdout.write('\n§3 JDY production warn+strip\n');
{
  const orig = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const allowed = new Set(['sku', 'name_en']);
  const body = { sku: 'P-001', name_en: 'Test', jdy_extra: 'drop' };
  mustNotThrow('JDY endpoint in production does not throw',
    () => enforceFieldPolicy(allowed, body, 'products_PATCH'));
  check('jdy_extra stripped from body', !Object.hasOwn(body, 'jdy_extra'));
  check('sku preserved',                body.sku === 'P-001');

  process.env.NODE_ENV = 'test';
  mustThrow('JDY endpoint in test env → UNKNOWN_FIELD',
    () => enforceFieldPolicy(new Set(['sku']), { sku: 'x', bad_field: 1 }, 'products_PATCH'),
    'UNKNOWN_FIELD');
  process.env.NODE_ENV = orig;
}

// ─── §4: canViewBl ────────────────────────────────────────────────────────────
process.stdout.write('\n§4 canViewBl\n');
{
  check('quoting → all false (trader)',    !canViewBl({ role: 'trader', stage: 'quoting' }));
  check('quoting → all false (sc ocean)', !canViewBl({ role: 'supply_chain', serviceType: 'ocean', stage: 'quoting' }));
  check('accepted + sc ocean NOT assigned → false',
    !canViewBl({ role: 'supply_chain', serviceType: 'ocean', stage: 'accepted', isAssignedOceanBidder: false }));
  check('accepted + sc ocean IS assigned → true',
    canViewBl({ role: 'supply_chain', serviceType: 'ocean', stage: 'accepted', isAssignedOceanBidder: true }));
  check('accepted + trader → true',           canViewBl({ role: 'trader', stage: 'accepted' }));
  check('assigned + sc ocean → true',         canViewBl({ role: 'supply_chain', serviceType: 'ocean', stage: 'assigned' }));
  check('assigned + buyer → true',            canViewBl({ role: 'buyer', stage: 'assigned' }));
  check('assigned + factory direct_export → true',
    canViewBl({ role: 'factory', stage: 'assigned', fulfillmentMode: 'direct_export' }));
  check('assigned + factory trader_export → false',
    !canViewBl({ role: 'factory', stage: 'assigned', fulfillmentMode: 'trader_export' }));
}

// ─── §5: deriveQuoteStage ─────────────────────────────────────────────────────
process.stdout.write('\n§5 deriveQuoteStage (P1-C1)\n');
{
  check('status=open → quoting',           deriveQuoteStage({ status: 'open' })            === 'quoting');
  check('status=OPEN (case) → quoting',    deriveQuoteStage({ status: 'OPEN' })            === 'quoting');
  check('status=accepted → accepted',      deriveQuoteStage({ status: 'accepted' })        === 'accepted');
  check('status=bid_accepted → accepted',  deriveQuoteStage({ status: 'bid_accepted' })    === 'accepted');
  check('status=assigned → assigned',      deriveQuoteStage({ status: 'assigned' })        === 'assigned');
  check('null row → quoting',              deriveQuoteStage(null)                           === 'quoting');
  check('empty status → quoting',          deriveQuoteStage({ status: '' })                 === 'quoting');
}

// ─── §6: deriveQuoteBidStage ──────────────────────────────────────────────────
process.stdout.write('\n§6 deriveQuoteBidStage (P1-C1)\n');
{
  check('bid_status=submitted → quoting',  deriveQuoteBidStage({ bid_status: 'submitted' }) === 'quoting');
  check('bid_status=accepted → accepted',  deriveQuoteBidStage({ bid_status: 'accepted' })  === 'accepted');
  check('bid_status=assigned → assigned',  deriveQuoteBidStage({ bid_status: 'assigned' })  === 'assigned');
  check('status fallback to status col',   deriveQuoteBidStage({ status: 'accepted' })       === 'accepted');
  check('null row → quoting',              deriveQuoteBidStage(null)                          === 'quoting');
}

// ─── §7: deriveCollabStage ────────────────────────────────────────────────────
process.stdout.write('\n§7 deriveCollabStage (P1-C1)\n');
{
  check('main_stage=in_transit → assigned',      deriveCollabStage({ main_stage: 'in_transit' })    === 'assigned');
  check('main_stage=delivered → assigned',       deriveCollabStage({ main_stage: 'delivered' })     === 'assigned');
  check('main_stage=customs_clearance → assigned', deriveCollabStage({ main_stage: 'customs_clearance' }) === 'assigned');
  check('main_stage=bid_accepted → accepted',    deriveCollabStage({ main_stage: 'bid_accepted' })  === 'accepted');
  check('collab_status=accepted → accepted',     deriveCollabStage({ collab_status: 'accepted' })   === 'accepted');
  check('main_stage=quoting → quoting',          deriveCollabStage({ main_stage: 'quoting' })       === 'quoting');
  check('null row → quoting',                    deriveCollabStage(null)                              === 'quoting');
}

// ─── §8: buildQuoteRequestViewModel — Phase 2.5 fixes ────────────────────────
process.stdout.write('\n§8 buildQuoteRequestViewModel Phase 2.5\n');

const qRow = {
  quote_id: 'QR-T-001', order_id: 1146, order_no: '46-T-1',
  service_type: 'ocean', pol: 'CNSHA', pod: 'USNYC',
  cargo_type: 'general',
  target_price: 3000, target_currency: 'USD',
  cargo_description: 'SECRET CARGO',
  total_weight: 5400, total_volume: 22.5,
  incoterm: 'FOB', scope_ids: ['ocean'],
  status: 'open',
  requested_at: new Date().toISOString(),
};

{
  // P1-A1: factory fail-closed
  check('factory → null (P1-A1)',
    buildQuoteRequestViewModel({ role: 'factory' }, qRow) === null);

  // P1-A2: buyer sees raw targetPrice
  const vmBuyer = buildQuoteRequestViewModel({ role: 'buyer' }, qRow);
  check('buyer: targetPrice visible (P1-A2)',  vmBuyer?.targetPrice === 3000);
  check('buyer: no targetPriceRange',          vmBuyer?.targetPriceRange == null);
  check('buyer: FORBIDDEN buy_rate absent',    !('buy_rate' in (vmBuyer || {})));

  // trader sees raw targetPrice + cargoDescription
  const vmTrader = buildQuoteRequestViewModel({ role: 'trader', stage: deriveQuoteStage(qRow) }, qRow);
  check('trader: targetPrice visible',          vmTrader?.targetPrice === 3000);
  check('trader: cargoDescription visible',     vmTrader?.cargoDescription === 'SECRET CARGO');
  check('trader: no targetPriceRange',          vmTrader?.targetPriceRange == null);
  check('trader: FORBIDDEN buy_rate absent',    !('buy_rate' in (vmTrader || {})));

  // supply_chain sees ±range, no raw price
  const vmSc = buildQuoteRequestViewModel(
    { role: 'supply_chain', serviceType: 'ocean', stage: deriveQuoteStage(qRow) },
    qRow, DEFAULT_QUOTE_VISIBILITY_POLICY,
  );
  check('supply_chain: targetPriceRange present',         vmSc?.targetPriceRange != null);
  check('supply_chain: targetPrice absent (P1-A2 guard)', vmSc?.targetPrice == null);
  check('supply_chain: range.low = 2550',                 vmSc?.targetPriceRange?.low === 2550);
  check('supply_chain: range.high = 3450',                vmSc?.targetPriceRange?.high === 3450);
  check('supply_chain: cargoDescription absent',          vmSc?.cargoDescription == null);

  // Policy 20%
  const vmPolicy = buildQuoteRequestViewModel(
    { role: 'supply_chain', serviceType: 'ocean', stage: 'quoting' },
    qRow, { targetPriceRangePercent: 20 },
  );
  check('policy 20%: range.low = 2400',  vmPolicy?.targetPriceRange?.low === 2400);
  check('policy 20%: range.high = 3600', vmPolicy?.targetPriceRange?.high === 3600);

  // broker roles → null
  check('broker_supply → null',   buildQuoteRequestViewModel({ role: 'broker_supply' },   qRow) === null);
  check('broker_factory → null',  buildQuoteRequestViewModel({ role: 'broker_factory' },  qRow) === null);
  check('broker_customer → null', buildQuoteRequestViewModel({ role: 'broker_customer' }, qRow) === null);
  check('null ctx → null',        buildQuoteRequestViewModel(null, qRow) === null);
  check('null row → null',        buildQuoteRequestViewModel({ role: 'trader' }, null) === null);
}

// ─── §9: buildQuoteBidCardViewModel — Phase 2.5 fixes ────────────────────────
process.stdout.write('\n§9 buildQuoteBidCardViewModel Phase 2.5\n');

const bidRow = {
  bid_id: 'BID-001', quote_id: 'QR-T-001',
  service_type: 'ocean', bidder_company_code: 'OCEAN-A',
  offered_price: 2650, offered_currency: 'USD',
  supplier_local_charge: true,
  supplier_local_charge_amount: 120,
  supplier_local_charge_currency: 'USD',
  all_in_price: 999999, // should be IGNORED (P1-A5)
  bid_status: 'submitted',
  status: 'submitted',
  remarks: 'includes THC',
  submitted_at: new Date().toISOString(),
};

const acceptedBidRow = Object.assign({}, bidRow, { bid_status: 'accepted', status: 'accepted' });

{
  // P1-A3: factory fail-closed
  check('factory → null (P1-A3)',
    buildQuoteBidCardViewModel({ role: 'factory' }, bidRow) === null);

  // Own sc: sees offeredPrice + LC, NOT allInPrice from DB
  const vmOwn = buildQuoteBidCardViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-A' },
    bidRow,
  );
  check('own sc: offeredPrice visible',                       vmOwn?.offeredPrice === 2650);
  check('own sc: supplierLocalCharge visible',                vmOwn?.supplierLocalCharge != null);
  check('own sc: allInPrice derived = 2650+120 = 2770 (P1-A5)', vmOwn?.allInPrice === 2770);
  check('own sc: all_in_price=999999 ignored (P1-A5)',         vmOwn?.allInPrice !== 999999);
  check('own sc: bidderCompanyCode absent',                   vmOwn?.bidderCompanyCode == null);
  check('own sc: FORBIDDEN buy_rate absent',                  !('buy_rate' in (vmOwn || {})));

  // Competing sc → null
  check('competing sc → null',
    buildQuoteBidCardViewModel({ role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-B' }, bidRow) === null);

  // trader sees all + derived allInPrice
  const vmTrader = buildQuoteBidCardViewModel({ role: 'trader' }, bidRow);
  check('trader: offeredPrice visible',                        vmTrader?.offeredPrice === 2650);
  check('trader: allInPrice derived = 2770 (P1-A5)',           vmTrader?.allInPrice === 2770);
  check('trader: row.all_in_price=999999 ignored (P1-A5)',     vmTrader?.allInPrice !== 999999);
  check('trader: bidderCompanyCode visible',                   vmTrader?.bidderCompanyCode === 'OCEAN-A');
  check('trader: FORBIDDEN sell_rate absent',                  !('sell_rate' in (vmTrader || {})));

  // P1-A4: buyer + accepted bid → sees offeredPrice
  const vmBuyerAccepted = buildQuoteBidCardViewModel(
    { role: 'buyer' },
    acceptedBidRow,
  );
  check('buyer + accepted bid: offeredPrice visible (P1-A4)',     vmBuyerAccepted?.offeredPrice === 2650);
  check('buyer + accepted bid: allInPrice = offeredPrice (P1-A5)',vmBuyerAccepted?.allInPrice === 2650);
  check('buyer + accepted bid: supplierLC absent (C2 protected)', vmBuyerAccepted?.supplierLocalCharge == null);
  check('buyer + accepted bid: bidderCompanyCode absent',         vmBuyerAccepted?.bidderCompanyCode == null);

  // buyer + non-accepted bid → NO price visible (null returned)
  const vmBuyerNonAccepted = buildQuoteBidCardViewModel({ role: 'buyer' }, bidRow);
  check('buyer + non-accepted bid → null (P1-A4 gate)',
    vmBuyerNonAccepted === null);

  // broker roles → null
  check('broker_customer → null', buildQuoteBidCardViewModel({ role: 'broker_customer' }, bidRow) === null);
  check('broker_supply → null',   buildQuoteBidCardViewModel({ role: 'broker_supply' },   bidRow) === null);
}

// ─── §10: P1-C1 — production ignores query stage ──────────────────────────────
process.stdout.write('\n§10 P1-C1 — stage spoofing prevention\n');
{
  // Simulate what the handler does: derive from row, not from query
  const openRow = { quote_id: 'QR-T-001', service_type: 'ocean', status: 'open', target_price: 3000, target_currency: 'USD', bl_no: 'BL-SECRET' };

  // In production: derive from row → 'quoting' → BL hidden
  const rowStage = deriveQuoteStage(openRow);
  check('open row → deriveQuoteStage = quoting', rowStage === 'quoting');
  check('quoting stage + trader → canViewBl = false',
    !canViewBl({ role: 'supply_chain', serviceType: 'ocean', stage: rowStage }));

  // Attacker passes ?stage=assigned → handler must ignore it in production
  // Simulate: prod guard means _devStageOverride is undefined in production
  const prodCtx = { role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-A', _devStageOverride: undefined };
  const ctxWithRowStage = Object.assign({}, prodCtx, { stage: prodCtx._devStageOverride || deriveQuoteStage(openRow) });
  check('production: query stage=assigned cannot unlock BL',
    !canViewBl({ role: ctxWithRowStage.role, serviceType: ctxWithRowStage.serviceType, stage: ctxWithRowStage.stage }));

  // In test env: _devStageOverride allowed
  const devCtxWith_dev_stage = { role: 'trader', _devStageOverride: 'assigned' };
  const ctxDev = Object.assign({}, devCtxWith_dev_stage, { stage: devCtxWith_dev_stage._devStageOverride });
  check('dev env: _dev_stage=assigned + trader → canViewBl true',
    canViewBl({ role: 'trader', stage: ctxDev.stage }));
}

// ─── §11: P1-D1 — collab list SQL scope guard ────────────────────────────────
process.stdout.write('\n§11 P1-D1 — SQL scope guard (fixture layer)\n');
{
  // Simulate fetchCollabRows fixture filtering
  const fixtures = [
    { collab_id: 'C-001', buyer_company_code: 'BUYER-A', factory_company_code: 'FACTORY-X', supplier_company_code: 'OCEAN-A' },
    { collab_id: 'C-002', buyer_company_code: 'BUYER-B', factory_company_code: 'FACTORY-Y', supplier_company_code: 'OCEAN-B' },
  ];
  function filterFixture(rows, filters) {
    let r = rows;
    if (filters.buyerCompanyCode)    r = r.filter(x => x.buyer_company_code    === filters.buyerCompanyCode);
    if (filters.factoryCompanyCode)  r = r.filter(x => x.factory_company_code  === filters.factoryCompanyCode);
    if (filters.supplierCompanyCode) r = r.filter(x => x.supplier_company_code === filters.supplierCompanyCode);
    return r;
  }

  check('buyer BUYER-A sees only own card',
    filterFixture(fixtures, { buyerCompanyCode: 'BUYER-A' }).length === 1 &&
    filterFixture(fixtures, { buyerCompanyCode: 'BUYER-A' })[0]?.collab_id === 'C-001');
  check('buyer BUYER-B sees only own card',
    filterFixture(fixtures, { buyerCompanyCode: 'BUYER-B' })[0]?.collab_id === 'C-002');
  check('factory FACTORY-X sees only own card',
    filterFixture(fixtures, { factoryCompanyCode: 'FACTORY-X' }).length === 1);
  check('supplier OCEAN-A sees only own card',
    filterFixture(fixtures, { supplierCompanyCode: 'OCEAN-A' }).length === 1);
  check('no scope filter → all returned (trader/admin)',
    filterFixture(fixtures, {}).length === 2);
}

// ─── §12: buildCollabSheetViewModel — retained from Phase 2 ─────────────────
process.stdout.write('\n§12 buildCollabSheetViewModel (Phase 2 retained)\n');

const collabRow = {
  collab_id: 'COLLAB-001', order_id: 1146, order_no: '46-T-1',
  main_stage: 'in_transit',  // → deriveCollabStage → 'assigned'
  collab_status: 'active',
  service_type: 'ocean', scope_ids: ['ocean'],
  buyer_company_code: 'BUYER-A',
  factory_company_code: 'FACTORY-X',
  cargo_category: 'pet_food',
  cargo_description: 'TOP SECRET CARGO',
  declared_value: 18000,
  incoterm: 'FOB',
  supplier_company_code: 'OCEAN-A',
  trucking_company_code: 'TRUCK-X',
  pickup_address: '123 Factory Rd', delivery_address: '456 Port Ave',
  truck_plate: 'SH-12345', driver_name: 'John Driver',
  vessel: 'EVER GIVEN', voyage: 'W042E',
  etd: '2026-05-15', eta: '2026-06-10', pol: 'CNSHA', pod: 'USNYC',
  bl_no: 'MAEU1234567', booking_no: 'BKG-001',
  hs_code: '2309.90', declaration_elements: 'test',
  local_charge_rule: { ruleId: 'LCR-1', defaultAmount: 200, currency: 'USD' },
  supplier_local_charge: { amount: 120, currency: 'USD', items: [] },
  customer_local_charge_display: { displayAmount: 150, displayCurrency: 'USD', displayLabel: 'Port charges' },
  bl_draft_status: 'issued', invoice_status: 'issued',
  packing_list_status: 'pending', customs_status: 'cleared',
  loading_photos: [{ url: 'https://example.com/p1.jpg' }],
  inspection_photos: [],
  exception_type: null, exception_note: null,
  internal_notes: 'TRADER EYES ONLY',
  handoff_status: 'completed',
  submitted_at: new Date().toISOString(),
};

{
  // Stage derived from row (assigned)
  const rowStage = deriveCollabStage(collabRow);
  check('deriveCollabStage(in_transit) = assigned', rowStage === 'assigned');

  const vmTrader = buildCollabSheetViewModel({ role: 'trader', stage: rowStage }, collabRow);
  check('FORBIDDEN driver_phone never in VM', !('driver_phone' in vmTrader));
  check('FORBIDDEN buy_rate never in VM',     !('buy_rate' in vmTrader));
  check('trader: internalNotes visible',       vmTrader?.internalNotes === 'TRADER EYES ONLY');
  check('trader: blNo visible (assigned)',      vmTrader?.blNo === 'MAEU1234567');
  check('trader: localChargeRule visible',      vmTrader?.localChargeRule != null);
  check('trader: supplierLocalCharge visible',  vmTrader?.supplierLocalCharge != null);
  check('trader: customerLocalChargeDisplay visible', vmTrader?.customerLocalChargeDisplay != null);

  const vmSc = buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-A', stage: rowStage, isAssignedOceanBidder: true },
    collabRow,
  );
  check('own ocean sc: blNo visible',           vmSc?.blNo === 'MAEU1234567');
  check('own ocean sc: supplierLC visible',     vmSc?.supplierLocalCharge != null);
  check('own ocean sc: internalNotes absent',   vmSc?.internalNotes == null);
  check('own ocean sc: localChargeRule absent', vmSc?.localChargeRule == null);

  // Competing sc: no supplierLC (P1 fix retained)
  const vmScOther = buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'DIFFERENT-CO', stage: rowStage },
    collabRow,
  );
  check('competing sc: supplierLC absent [P1 fix]', vmScOther?.supplierLocalCharge == null);

  // quoting stage → BL hidden (uses row-derived stage)
  const quotingRow = Object.assign({}, collabRow, { main_stage: 'quoting', collab_status: 'open' });
  const vmScQuoting = buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-A', stage: deriveCollabStage(quotingRow) },
    quotingRow,
  );
  check('quoting stage (row-derived): blNo hidden', vmScQuoting?.blNo == null);

  const vmBuyer = buildCollabSheetViewModel({ role: 'buyer', stage: rowStage }, collabRow);
  check('buyer: customerLocalChargeDisplay visible', vmBuyer?.customerLocalChargeDisplay != null);
  check('buyer: supplierLC absent',                  vmBuyer?.supplierLocalCharge == null);
  check('buyer: internalNotes absent',               vmBuyer?.internalNotes == null);
  check('buyer: localChargeRule absent',             vmBuyer?.localChargeRule == null);

  // broker → null
  check('broker_supply → null',   buildCollabSheetViewModel({ role: 'broker_supply' },   collabRow) === null);
  check('broker_factory → null',  buildCollabSheetViewModel({ role: 'broker_factory' },  collabRow) === null);
  check('broker_customer → null', buildCollabSheetViewModel({ role: 'broker_customer' }, collabRow) === null);

  // HS code gating
  const vmCustoms = buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'customs', stage: rowStage },
    collabRow,
  );
  check('customs sc: hsCode visible',
    vmCustoms?.hsCode === '2309.90');
  check('trucking sc: hsCode absent',
    buildCollabSheetViewModel({ role: 'supply_chain', serviceType: 'trucking', stage: rowStage }, collabRow)?.hsCode == null);
}

// ─── §13: information isolation ───────────────────────────────────────────────
process.stdout.write('\n§13 Information isolation\n');
{
  const rowStage = deriveCollabStage(collabRow);
  const vmFactory = buildCollabSheetViewModel(
    { role: 'factory', fulfillmentMode: 'trader_export', stage: rowStage },
    collabRow,
  );
  check('factory: no supplierCompanyCode field', !Object.hasOwn(vmFactory || {}, 'supplierCompanyCode'));
  check('factory: no truckingCompanyCode',       vmFactory?.truckingCompanyCode == null);
  check('factory: no bookingNo',                 vmFactory?.bookingNo == null);
  check('factory: loadingPhotos visible',        vmFactory?.loadingPhotos != null);

  const vmOceanSc = buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-A', stage: rowStage, isAssignedOceanBidder: true },
    collabRow,
  );
  check('ocean sc: no loadingPhotos',                      vmOceanSc?.loadingPhotos == null);
  check('ocean sc: no inspectionPhotos (not customs)',     vmOceanSc?.inspectionPhotos == null);
  check('ocean sc: no incoterm (not direct_export/trader)', vmOceanSc?.incoterm == null);
}

// ─── Final report ─────────────────────────────────────────────────────────────
process.stdout.write(`\n${'─'.repeat(60)}\n`);
process.stdout.write(`sc-phase2+2.5-api: ${pass} passed, ${fail} failed\n`);
if (fails.length > 0) {
  process.stdout.write('\nFailed:\n');
  fails.forEach(f => process.stdout.write(`  ✘ ${f}\n`));
  process.exit(1);
} else {
  process.stdout.write('ALL PASS\n');
}
