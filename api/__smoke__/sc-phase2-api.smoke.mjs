// sc-phase2-api.smoke.mjs — Phase 2 API layer smoke tests
//
// Tests the JS ViewModel + field-policy helpers in isolation (no DB, no HTTP).
// Run: node api/__smoke__/sc-phase2-api.smoke.mjs

import {
  DEFAULT_QUOTE_VISIBILITY_POLICY,
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
  if (ok) {
    pass++;
    process.stdout.write(`  ✔ ${label}\n`);
  } else {
    fail++;
    fails.push(label);
    process.stdout.write(`  ✘ ${label}\n`);
  }
}

function mustThrow(label, fn, expectedCode) {
  try {
    fn();
    fail++;
    fails.push(label);
    process.stdout.write(`  ✘ ${label} — should have thrown\n`);
  } catch (e) {
    if (e.code === expectedCode) {
      pass++;
      process.stdout.write(`  ✔ ${label}\n`);
    } else {
      fail++;
      fails.push(label);
      process.stdout.write(`  ✘ ${label} — threw ${e.code} not ${expectedCode}\n`);
    }
  }
}

function mustNotThrow(label, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ✔ ${label}\n`);
  } catch (e) {
    fail++;
    fails.push(label);
    process.stdout.write(`  ✘ ${label} — threw ${JSON.stringify(e.code || e.message)}\n`);
  }
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
    () => enforceFieldPolicy(undefined, { x: 1 }, 'ep'),
    'MISSING_FIELD_WHITELIST');

  try {
    enforceFieldPolicy(undefined, {}, 'test_ep');
  } catch (e) {
    check('MISSING_FIELD_WHITELIST has status=500', e.status === 500);
    check('MISSING_FIELD_WHITELIST has endpoint', e.endpoint === 'test_ep');
  }

  mustThrow('unknown field on SC endpoint → UNKNOWN_FIELD',
    () => enforceFieldPolicy(new Set(['offered_price']), { offered_price: 1, buy_rate: 99 }, 'sc_ep'),
    'UNKNOWN_FIELD');

  try {
    enforceFieldPolicy(new Set(['a']), { a: 1, b: 2, c: 3 }, 'sc_ep');
  } catch (e) {
    check('UNKNOWN_FIELD has status=400', e.status === 400);
    check('UNKNOWN_FIELD fields includes b', e.fields?.includes('b'));
    check('UNKNOWN_FIELD fields includes c', e.fields?.includes('c'));
  }

  mustNotThrow('all-known fields passes',
    () => enforceFieldPolicy(new Set(['a', 'b']), { a: 1, b: 2 }, 'ep'));

  mustNotThrow('empty body always passes',
    () => enforceFieldPolicy(new Set(['a']), {}, 'ep'));
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

  // Endpoint-specific alias skipped when endpoint differs
  const r2 = applyAliasMap({ old_key: 'v' }, [{ deprecated: 'old_key', canonical: 'new_key', endpoint: 'other_ep' }], 'different_ep');
  check('endpoint-specific alias skipped when mismatch', Object.hasOwn(r2.body, 'old_key'));
  check('no deprecatedFields when skipped', r2.deprecatedFields.length === 0);

  // When both deprecated + canonical present, canonical wins
  const r3 = applyAliasMap(
    { old: 'deprecated-val', newKey: 'canonical-val' },
    [{ deprecated: 'old', canonical: 'newKey' }],
    'ep',
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
  check('jdy_extra stripped from body',   !Object.hasOwn(body, 'jdy_extra'));
  check('sku preserved',                  body.sku === 'P-001');

  process.env.NODE_ENV = orig;

  // In test env, JDY endpoint still throws
  process.env.NODE_ENV = 'test';
  mustThrow('JDY endpoint in test env → UNKNOWN_FIELD',
    () => enforceFieldPolicy(new Set(['sku']), { sku: 'x', bad_field: 1 }, 'products_PATCH'),
    'UNKNOWN_FIELD');
  process.env.NODE_ENV = orig;
}

// ─── §4: canViewBl ────────────────────────────────────────────────────────────
process.stdout.write('\n§4 canViewBl\n');

{
  check('quoting stage → all false (trader)',
    !canViewBl({ role: 'trader', stage: 'quoting' }));
  check('quoting stage → all false (supply_chain ocean)',
    !canViewBl({ role: 'supply_chain', serviceType: 'ocean', stage: 'quoting' }));
  check('accepted + supply_chain ocean + NOT assigned → false',
    !canViewBl({ role: 'supply_chain', serviceType: 'ocean', stage: 'accepted', isAssignedOceanBidder: false }));
  check('accepted + supply_chain ocean + IS assigned → true',
    canViewBl({ role: 'supply_chain', serviceType: 'ocean', stage: 'accepted', isAssignedOceanBidder: true }));
  check('accepted + trader → true',
    canViewBl({ role: 'trader', stage: 'accepted' }));
  check('assigned + supply_chain ocean → true',
    canViewBl({ role: 'supply_chain', serviceType: 'ocean', stage: 'assigned' }));
  check('assigned + buyer → true',
    canViewBl({ role: 'buyer', stage: 'assigned' }));
  check('assigned + factory direct_export → true',
    canViewBl({ role: 'factory', stage: 'assigned', fulfillmentMode: 'direct_export' }));
  check('assigned + factory trader_export → false',
    !canViewBl({ role: 'factory', stage: 'assigned', fulfillmentMode: 'trader_export' }));
}

// ─── §5: buildQuoteRequestViewModel ──────────────────────────────────────────
process.stdout.write('\n§5 buildQuoteRequestViewModel\n');

const qRow = {
  quote_id:       'QR-TEST-001',
  order_id:       1146,
  order_no:       '46-T-1',
  service_type:   'ocean',
  pol:            'CNSHA',
  pod:            'USNYC',
  cargo_type:     'general',
  target_price:   3000,
  target_currency:'USD',
  cargo_description: 'SECRET CARGO',
  total_weight:   5400,
  total_volume:   22.5,
  incoterm:       'FOB',
  scope_ids:      ['ocean'],
  status:         'open',
  requested_at:   new Date().toISOString(),
};

{
  // trader sees raw target_price + cargoDescription
  const vm = buildQuoteRequestViewModel({ role: 'trader' }, qRow);
  check('trader: targetPrice present (raw)',   vm?.targetPrice === 3000);
  check('trader: cargoDescription visible',   vm?.cargoDescription === 'SECRET CARGO');
  check('trader: no targetPriceRange',        vm?.targetPriceRange == null);
  check('trader: FORBIDDEN buy_rate absent',  !('buy_rate' in (vm || {})));
  check('trader: FORBIDDEN sell_rate absent', !('sell_rate' in (vm || {})));

  // supply_chain ocean sees ±range, not raw price
  const vmSc = buildQuoteRequestViewModel(
    { role: 'supply_chain', serviceType: 'ocean' },
    qRow,
    DEFAULT_QUOTE_VISIBILITY_POLICY, // 15%
  );
  check('supply_chain: targetPriceRange present', vmSc?.targetPriceRange != null);
  check('supply_chain: targetPrice absent (no raw)', vmSc?.targetPrice == null);
  check('supply_chain: range.low = 3000 * 0.85 = 2550', vmSc?.targetPriceRange?.low === 2550);
  check('supply_chain: range.high = 3000 * 1.15 = 3450', vmSc?.targetPriceRange?.high === 3450);
  check('supply_chain: cargoDescription absent', vmSc?.cargoDescription == null);

  // Policy override (20%)
  const vmPolicy = buildQuoteRequestViewModel(
    { role: 'supply_chain', serviceType: 'ocean' },
    qRow,
    { targetPriceRangePercent: 20 },
  );
  check('policy 20%: range.low = 3000 * 0.80 = 2400', vmPolicy?.targetPriceRange?.low === 2400);
  check('policy 20%: range.high = 3000 * 1.20 = 3600', vmPolicy?.targetPriceRange?.high === 3600);

  // buyer sees no price fields at all
  const vmBuyer = buildQuoteRequestViewModel({ role: 'buyer' }, qRow);
  check('buyer: targetPrice absent', vmBuyer?.targetPrice == null);
  check('buyer: targetPriceRange absent', vmBuyer?.targetPriceRange == null);

  // broker → null
  check('broker_supply → null', buildQuoteRequestViewModel({ role: 'broker_supply' }, qRow) === null);
  check('broker_factory → null', buildQuoteRequestViewModel({ role: 'broker_factory' }, qRow) === null);

  // null inputs → null
  check('null ctx → null', buildQuoteRequestViewModel(null, qRow) === null);
  check('null row → null', buildQuoteRequestViewModel({ role: 'trader' }, null) === null);
}

// ─── §6: buildQuoteBidCardViewModel ──────────────────────────────────────────
process.stdout.write('\n§6 buildQuoteBidCardViewModel\n');

const bidRow = {
  bid_id:                      'BID-001',
  quote_id:                    'QR-TEST-001',
  service_type:                'ocean',
  bidder_company_code:         'OCEAN-A',
  offered_price:               2650,
  offered_currency:            'USD',
  all_in_price:                3100,
  all_in_currency:             'USD',
  supplier_local_charge:       true,
  supplier_local_charge_amount: 120,
  supplier_local_charge_currency: 'USD',
  status:                      'submitted',
  remarks:                     'includes THC',
  submitted_at:                new Date().toISOString(),
};

{
  // Own supply_chain bidder sees offeredPrice + supplierLocalCharge but NOT allInPrice
  const vmOwn = buildQuoteBidCardViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-A' },
    bidRow,
  );
  check('own sc: offeredPrice visible',        vmOwn?.offeredPrice === 2650);
  check('own sc: supplierLocalCharge visible', vmOwn?.supplierLocalCharge != null);
  check('own sc: allInPrice absent',           vmOwn?.allInPrice == null);
  check('own sc: bidderCompanyCode absent',    vmOwn?.bidderCompanyCode == null);
  check('own sc: FORBIDDEN buy_rate absent',   !('buy_rate' in (vmOwn || {})));

  // Competing supply_chain sees nothing → null
  const vmOther = buildQuoteBidCardViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-B' },
    bidRow,
  );
  check('competing sc → null', vmOther === null);

  // trader sees everything including allInPrice + bidderCompanyCode
  const vmTrader = buildQuoteBidCardViewModel({ role: 'trader' }, bidRow);
  check('trader: offeredPrice visible',       vmTrader?.offeredPrice === 2650);
  check('trader: allInPrice visible',         vmTrader?.allInPrice === 3100);
  check('trader: bidderCompanyCode visible',  vmTrader?.bidderCompanyCode === 'OCEAN-A');
  check('trader: FORBIDDEN sell_rate absent', !('sell_rate' in (vmTrader || {})));

  // buyer → null (blocked before ViewModel)
  check('broker_customer → null', buildQuoteBidCardViewModel({ role: 'broker_customer' }, bidRow) === null);
}

// ─── §7: buildCollabSheetViewModel ───────────────────────────────────────────
process.stdout.write('\n§7 buildCollabSheetViewModel\n');

const collabRow = {
  collab_id:          'COLLAB-001',
  order_id:           1146,
  order_no:           '46-T-1',
  main_stage:         'in_transit',
  service_type:       'ocean',
  scope_ids:          ['ocean'],
  cargo_category:     'pet_food',
  cargo_description:  'TOP SECRET CARGO',
  declared_value:     18000,
  incoterm:           'FOB',
  supplier_company_code: 'OCEAN-A',
  trucking_company_code: 'TRUCK-X',
  pickup_address:     '123 Factory Rd',
  delivery_address:   '456 Port Ave',
  truck_plate:        'SH-12345',
  driver_name:        'John Driver',
  // driver_phone: intentionally NOT in row (FORBIDDEN — never in raw row)
  vessel:             'EVER GIVEN',
  voyage:             'W042E',
  etd:                '2026-05-15',
  eta:                '2026-06-10',
  pol:                'CNSHA',
  pod:                'USNYC',
  bl_no:              'MAEU1234567',
  booking_no:         'BKG-001',
  hs_code:            '2309.90',
  declaration_elements: 'test',
  local_charge_rule:  { ruleId: 'LCR-1', defaultAmount: 200, currency: 'USD' },
  supplier_local_charge: { amount: 120, currency: 'USD', items: [] },
  customer_local_charge_display: { displayAmount: 150, displayCurrency: 'USD', displayLabel: 'Port charges' },
  bl_draft_status:    'issued',
  invoice_status:     'issued',
  packing_list_status:'pending',
  customs_status:     'cleared',
  loading_photos:     [{ url: 'https://example.com/photo1.jpg' }],
  inspection_photos:  [],
  exception_type:     null,
  exception_note:     null,
  internal_notes:     'TRADER EYES ONLY',
  handoff_status:     'completed',
  submitted_at:       new Date().toISOString(),
  collab_status:      'active',
};

{
  // FORBIDDEN: driver_phone must never appear in ViewModel output
  const vmTrader = buildCollabSheetViewModel(
    { role: 'trader', stage: 'assigned' },
    collabRow,
  );
  check('FORBIDDEN driver_phone never in ViewModel (trader)', !('driver_phone' in vmTrader));
  check('FORBIDDEN buy_rate never in ViewModel (trader)',     !('buy_rate' in vmTrader));
  check('FORBIDDEN sell_rate never in ViewModel (trader)',    !('sell_rate' in vmTrader));

  // §M internal_notes: trader only
  check('trader: internalNotes visible',  vmTrader?.internalNotes === 'TRADER EYES ONLY');

  // supply_chain sees no internal_notes
  const vmSc = buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-A', stage: 'assigned', isAssignedOceanBidder: true },
    collabRow,
  );
  check('supply_chain: internalNotes absent', vmSc?.internalNotes == null);

  // §H BL: assigned stage + own ocean bidder → visible
  check('assigned ocean sc: blNo visible', vmSc?.blNo === 'MAEU1234567');

  // quoting stage → bl hidden for supply_chain
  const vmScQuoting = buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-A', stage: 'quoting' },
    collabRow,
  );
  check('quoting stage sc: blNo absent', vmScQuoting?.blNo == null);

  // §I C1 localChargeRule: trader + platform_admin only
  check('trader: localChargeRule visible', vmTrader?.localChargeRule != null);
  check('supply_chain: localChargeRule absent', vmSc?.localChargeRule == null);

  // §I C2 supplierLocalCharge: own sc + trader only
  check('trader: supplierLocalCharge visible', vmTrader?.supplierLocalCharge != null);
  check('own sc: supplierLocalCharge visible', vmSc?.supplierLocalCharge != null);

  // Competing sc must NOT see supplierLocalCharge (P1 bug fix)
  const vmScOther = buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'DIFFERENT-CO', stage: 'assigned' },
    collabRow,
  );
  check('competing sc: supplierLocalCharge absent [P1 fix]', vmScOther?.supplierLocalCharge == null);

  // §I C3 customerLocalChargeDisplay: buyer + trader
  const vmBuyer = buildCollabSheetViewModel({ role: 'buyer', stage: 'assigned' }, collabRow);
  check('buyer: customerLocalChargeDisplay visible', vmBuyer?.customerLocalChargeDisplay != null);
  check('buyer: supplierLocalCharge absent',         vmBuyer?.supplierLocalCharge == null);
  check('buyer: localChargeRule absent',             vmBuyer?.localChargeRule == null);
  check('buyer: internalNotes absent',               vmBuyer?.internalNotes == null);

  // §K loading_photos: factory + trader
  check('trader: loadingPhotos visible', vmTrader?.loadingPhotos != null);
  const vmFactory = buildCollabSheetViewModel(
    { role: 'factory', fulfillmentMode: 'direct_export', stage: 'assigned' },
    collabRow,
  );
  check('factory: loadingPhotos visible',         vmFactory?.loadingPhotos != null);
  check('factory: internalNotes absent',          vmFactory?.internalNotes == null);
  check('factory: supplierLocalCharge absent',    vmFactory?.supplierLocalCharge == null);

  // Broker roles → null
  check('broker_supply → null',   buildCollabSheetViewModel({ role: 'broker_supply' },   collabRow) === null);
  check('broker_factory → null',  buildCollabSheetViewModel({ role: 'broker_factory' },  collabRow) === null);
  check('broker_customer → null', buildCollabSheetViewModel({ role: 'broker_customer' }, collabRow) === null);

  // null inputs → null
  check('null ctx → null', buildCollabSheetViewModel(null, collabRow) === null);
  check('null row → null', buildCollabSheetViewModel({ role: 'trader' }, null) === null);

  // §H HS code: supply_chain[customs] + trader + platform_admin only
  const vmCustoms = buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'customs', stage: 'assigned' },
    collabRow,
  );
  check('customs sc: hsCode visible', vmCustoms?.hsCode === '2309.90');
  check('trucking sc: hsCode absent', buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'trucking', stage: 'assigned' },
    collabRow,
  )?.hsCode == null);
}

// ─── §8: Information isolation (factory/supply_chain mutual opacity) ──────────
process.stdout.write('\n§8 Information isolation\n');

{
  const vmFactory2 = buildCollabSheetViewModel(
    { role: 'factory', stage: 'assigned' },
    collabRow,
  );
  // factory must not see supplier_company_code (exposed as supplierCompanyCode)
  // The ViewModel doesn't expose supplierCompanyCode field at all
  check('factory: no supplierCompanyCode field in vm',
    !Object.hasOwn(vmFactory2 || {}, 'supplierCompanyCode'));
  check('factory: no truckingCompanyCode (not own trucking)',
    vmFactory2?.truckingCompanyCode == null);
  check('factory: no bookingNo',   vmFactory2?.bookingNo == null);
  check('factory: no hsCode (not customs)', vmFactory2?.hsCode == null);

  // supply_chain ocean: should not expose factory identity fields
  const vmOcean = buildCollabSheetViewModel(
    { role: 'supply_chain', serviceType: 'ocean', companyCode: 'OCEAN-A', stage: 'assigned', isAssignedOceanBidder: true },
    collabRow,
  );
  check('ocean sc: no loadingPhotos',     vmOcean?.loadingPhotos == null);
  check('ocean sc: no inspectionPhotos (not customs)', vmOcean?.inspectionPhotos == null);
  check('ocean sc: no incoterm (not direct_export factory or trader)',
    vmOcean?.incoterm == null);
}

// ─── Final report ─────────────────────────────────────────────────────────────
process.stdout.write(`\n${'─'.repeat(60)}\n`);
process.stdout.write(`sc-phase2-api: ${pass} passed, ${fail} failed\n`);
if (fails.length > 0) {
  process.stdout.write('\nFailed:\n');
  fails.forEach(f => process.stdout.write(`  ✘ ${f}\n`));
  process.exit(1);
} else {
  process.stdout.write('ALL PASS\n');
}
