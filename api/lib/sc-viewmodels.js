// api/lib/sc-viewmodels.js
//
// SC Collab Phase 2 + Phase 2.5 ViewModel builders
//
// P1-A1: factory → null in buildQuoteRequestViewModel
// P1-A2: buyer sees raw targetPrice (not range)
// P1-A3: factory → null in buildQuoteBidCardViewModel
// P1-A4: buyer + accepted/assigned bid → sees offeredPrice
// P1-A5: allInPrice derived (offeredPrice + LC); row.all_in_price is NEVER read
// P1-C1: stage derived per-row via helpers; never from req.query

export const DEFAULT_QUOTE_VISIBILITY_POLICY = { targetPriceRangePercent: 15 };

const BROKER_ROLES = new Set(['broker_supply', 'broker_factory', 'broker_customer']);
const SC_TARGET_PRICE_RANGE_TYPES = new Set(['ocean', 'customs', 'trucking', 'ddp']);

// ── Stage derivation (P1-C1) ──────────────────────────────────────────────────

export function deriveQuoteStage(row) {
  const s = ((row?.status) || '').toLowerCase();
  if (s === 'assigned')                     return 'assigned';
  if (s === 'accepted' || s === 'bid_accepted') return 'accepted';
  return 'quoting';
}

export function deriveQuoteBidStage(row) {
  const s = ((row?.bid_status || row?.status) || '').toLowerCase();
  if (s === 'assigned') return 'assigned';
  if (s === 'accepted') return 'accepted';
  return 'quoting';
}

const COLLAB_ASSIGNED_STAGES = new Set([
  'in_transit', 'customs_clearance', 'at_destination', 'delivered',
  'loading', 'port_departure', 'ocean_transit',
]);

export function deriveCollabStage(row) {
  const mainStage    = ((row?.main_stage)    || '').toLowerCase();
  const collabStatus = ((row?.collab_status) || '').toLowerCase();
  if (COLLAB_ASSIGNED_STAGES.has(mainStage) || collabStatus === 'assigned') return 'assigned';
  if (mainStage === 'bid_accepted' || collabStatus === 'accepted')           return 'accepted';
  return 'quoting';
}

// ── BL visibility matrix §4.5 ─────────────────────────────────────────────────

export function canViewBl(ctx) {
  if (!ctx) return false;
  const { role, stage, serviceType, isAssignedOceanBidder, fulfillmentMode } = ctx;
  if (stage === 'quoting') return false;
  if (role === 'trader' || role === 'platform_admin' || role === 'platform_finance') return true;
  if (stage === 'accepted') {
    if (role === 'supply_chain' && serviceType === 'ocean' && isAssignedOceanBidder) return true;
    return false;
  }
  if (stage === 'assigned') {
    if (role === 'supply_chain' && serviceType === 'ocean') return true;
    if (role === 'buyer') return true;
    if (role === 'factory' && fulfillmentMode === 'direct_export') return true;
    return false;
  }
  return false;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function isTraderOrPlatform(role) {
  return role === 'trader' || role === 'platform_admin' || role === 'platform_finance';
}

function canSeeTargetPriceRaw(role) {
  // P1-A2: buyer + trader + platform see raw targetPrice
  return role === 'buyer' || isTraderOrPlatform(role);
}

// ── buildQuoteRequestViewModel ────────────────────────────────────────────────

export function buildQuoteRequestViewModel(ctx, row, policy) {
  if (!ctx || !row) return null;
  const { role, serviceType } = ctx;

  // P1-A1: factory + brokers fail-closed
  if (BROKER_ROLES.has(role) || role === 'factory') return null;

  const pol = policy || DEFAULT_QUOTE_VISIBILITY_POLICY;

  const vm = {
    quoteId:     row.quote_id,
    orderId:     row.order_id,
    orderNo:     row.order_no,
    serviceType: row.service_type,
    pol:         row.pol,
    pod:         row.pod,
    cargoType:   row.cargo_type,
    totalWeight: row.total_weight,
    totalVolume: row.total_volume,
    incoterm:    row.incoterm,
    scopeIds:    row.scope_ids,
    status:      row.status,
    requestedAt: row.requested_at,
    expiresAt:   row.expires_at,
  };

  // P1-A2: buyer + trader/platform get raw price; supply_chain gets range
  if (canSeeTargetPriceRaw(role)) {
    vm.targetPrice    = row.target_price;
    vm.targetCurrency = row.target_currency ?? undefined;
  } else if (role === 'supply_chain' && SC_TARGET_PRICE_RANGE_TYPES.has(serviceType)) {
    const pct  = ((pol.targetPriceRangePercent ?? 15)) / 100;
    const base = Number(row.target_price) || 0;
    vm.targetPriceRange = {
      low:      Math.round(base * (1 - pct) * 100) / 100,
      high:     Math.round(base * (1 + pct) * 100) / 100,
      currency: row.target_currency ?? undefined,
    };
  }

  // cargoDescription: trader/platform only (commercial sensitivity)
  if (isTraderOrPlatform(role)) {
    vm.cargoDescription = row.cargo_description;
  }

  return vm;
}

// ── buildQuoteBidCardViewModel ────────────────────────────────────────────────

export function buildQuoteBidCardViewModel(ctx, row) {
  if (!ctx || !row) return null;
  const { role, companyCode } = ctx;

  // P1-A3: factory + brokers fail-closed
  if (BROKER_ROLES.has(role) || role === 'factory') return null;

  const stage        = ctx.stage || deriveQuoteBidStage(row);
  const isAcceptedBid = row.bid_status === 'accepted' || row.bid_status === 'assigned';
  const isOwnBid      = role === 'supply_chain' && row.bidder_company_code === companyCode;

  // supply_chain sees only own bids
  if (role === 'supply_chain' && !isOwnBid) return null;

  // P1-A4: buyer sees only accepted/assigned bids
  const isBuyerAcceptedBid = role === 'buyer' && isAcceptedBid;
  if (role === 'buyer' && !isBuyerAcceptedBid) return null;

  const canSeePrice = isTraderOrPlatform(role) || isOwnBid || isBuyerAcceptedBid;

  const vm = {
    bidId:       row.bid_id,
    quoteId:     row.quote_id,
    serviceType: row.service_type,
    bidStatus:   row.bid_status,
    remarks:     row.remarks,
    submittedAt: row.submitted_at,
  };

  // bidderCompanyCode: trader/platform only (supply_chain and buyer must not see each other)
  if (isTraderOrPlatform(role)) {
    vm.bidderCompanyCode = row.bidder_company_code;
  }

  if (canSeePrice && row.offered_price != null) {
    vm.offeredPrice    = Number(row.offered_price);
    vm.offeredCurrency = row.offered_currency;

    // C2 supplier local charge: own sc + trader/platform (NOT buyer — P1-A5)
    const canSeeC2 = isTraderOrPlatform(role) || isOwnBid;
    let chargeAdd = 0;
    if (canSeeC2 && row.supplier_local_charge_amount != null) {
      chargeAdd = Number(row.supplier_local_charge_amount) || 0;
      vm.supplierLocalCharge = {
        amount:   chargeAdd,
        currency: row.supplier_local_charge_currency,
        included: !!row.supplier_local_charge,
      };
    }

    // P1-A5: allInPrice derived — NEVER reads row.all_in_price
    vm.allInPrice = Math.round((Number(row.offered_price) + chargeAdd) * 100) / 100;
  }

  return vm;
}

// ── buildCollabSheetViewModel ─────────────────────────────────────────────────

export function buildCollabSheetViewModel(ctx, row) {
  if (!ctx || !row) return null;
  const { role, serviceType, companyCode, stage, isAssignedOceanBidder, fulfillmentMode } = ctx;

  if (BROKER_ROLES.has(role)) return null;

  const blVisible = canViewBl({ role, stage, serviceType, isAssignedOceanBidder, fulfillmentMode });
  const isOwnSc   = role === 'supply_chain' && row.supplier_company_code === companyCode;

  const vm = {
    collabId:          row.collab_id,
    orderId:           row.order_id,
    orderNo:           row.order_no,
    collabStatus:      row.collab_status,
    serviceType:       row.service_type,
    scopeIds:          row.scope_ids,
    cargoCategory:     row.cargo_category,
    etd:               row.etd,
    eta:               row.eta,
    pol:               row.pol,
    pod:               row.pod,
    blDraftStatus:     row.bl_draft_status,
    invoiceStatus:     row.invoice_status,
    packingListStatus: row.packing_list_status,
    customsStatus:     row.customs_status,
    handoffStatus:     row.handoff_status,
    submittedAt:       row.submitted_at,
    exceptionType:     row.exception_type,
    exceptionNote:     row.exception_note,
  };

  // BL + booking: gated per §4.5 matrix
  if (blVisible) {
    vm.blNo      = row.bl_no;
    vm.bookingNo = row.booking_no;
  }

  // Vessel/voyage: ocean parties + factory + buyer
  if (isTraderOrPlatform(role) || role === 'buyer' || role === 'factory' ||
      (role === 'supply_chain' && serviceType === 'ocean')) {
    vm.vessel = row.vessel;
    vm.voyage = row.voyage;
  }

  // Incoterm: trader, buyer, factory direct_export only
  if (isTraderOrPlatform(role) || role === 'buyer' ||
      (role === 'factory' && fulfillmentMode === 'direct_export')) {
    vm.incoterm = row.incoterm;
  }

  // Cargo description + declared value: trader/platform only
  if (isTraderOrPlatform(role)) {
    vm.cargoDescription = row.cargo_description;
    vm.declaredValue    = row.declared_value;
    vm.declaredCurrency = row.declared_currency;
  }

  // Internal notes: trader/platform only
  if (isTraderOrPlatform(role)) {
    vm.internalNotes = row.internal_notes;
  }

  // C1 local_charge_rule: trader/platform only
  if (isTraderOrPlatform(role)) {
    vm.localChargeRule = row.local_charge_rule;
  }

  // C2 supplier_local_charge: own sc + trader/platform
  if (isTraderOrPlatform(role) || isOwnSc) {
    vm.supplierLocalCharge = row.supplier_local_charge;
  }

  // C3 customer_local_charge_display: buyer + trader/platform
  if (isTraderOrPlatform(role) || role === 'buyer') {
    vm.customerLocalChargeDisplay = row.customer_local_charge_display;
  }

  // HS code + declaration: customs sc + trader/platform
  if (isTraderOrPlatform(role) || (role === 'supply_chain' && serviceType === 'customs')) {
    vm.hsCode              = row.hs_code;
    vm.declarationElements = row.declaration_elements;
  }

  // Loading photos: factory + trader/platform
  if (isTraderOrPlatform(role) || role === 'factory') {
    vm.loadingPhotos = row.loading_photos;
  }

  // Inspection photos: customs sc + trader/platform
  if (isTraderOrPlatform(role) || (role === 'supply_chain' && serviceType === 'customs')) {
    vm.inspectionPhotos = row.inspection_photos;
  }

  // Trucking fields: trucking sc + trader/platform
  // driver_phone NEVER included — FORBIDDEN field
  if (isTraderOrPlatform(role) || (role === 'supply_chain' && serviceType === 'trucking')) {
    vm.truckingCompanyCode = row.trucking_company_code;
    vm.pickupAddress       = row.pickup_address;
    vm.deliveryAddress     = row.delivery_address;
    vm.truckPlate          = row.truck_plate;
    vm.driverName          = row.driver_name;
  }

  // Company identity fields — isolation per §A-§N
  if (isTraderOrPlatform(role)) {
    // trader/platform see all company codes
    vm.supplierCompanyCode = row.supplier_company_code;
    vm.factoryCompanyCode  = row.factory_company_code;
    vm.buyerCompanyCode    = row.buyer_company_code;
  } else if (role === 'buyer') {
    vm.buyerCompanyCode = row.buyer_company_code;
    // supplier/factory identity hidden from buyer
  } else if (role === 'factory') {
    // factory sees buyer identity but NOT supplier company identity (§B isolation)
    // supplierCompanyCode intentionally absent — key must not exist in VM
  } else if (role === 'supply_chain') {
    // supply_chain sees own company code only
    if (isOwnSc) vm.supplierCompanyCode = row.supplier_company_code;
  }

  return vm;
}
