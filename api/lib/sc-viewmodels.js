// api/lib/sc-viewmodels.js
//
// JS port of:
//   app/components/src/permission/quoteViewModels.ts
//   app/components/src/permission/collabViewModels.ts
//
// Canonical role set:
//   buyer / factory / trader / supply_chain / broker_factory / broker_customer /
//   broker_supply / platform_finance / platform_admin
//
// supply_chain sub-typed by serviceType (ocean/customs/trucking/ddp/packaging/…)
// factory sub-typed by fulfillmentMode (trader_export/direct_export/domestic_delivery_only)
//
// FORBIDDEN fields (never in any ViewModel output):
//   buy_rate / sell_rate / platform_markup / buyer_final_price / driver_phone /
//   internal_margin / platform_fee_raw
//
// Exports:
//   DEFAULT_QUOTE_VISIBILITY_POLICY
//   canViewBl(blCtx)
//   buildQuoteRequestViewModel(ctx, row, policy?)
//   buildQuoteBidCardViewModel(ctx, row)
//   buildCollabSheetViewModel(ctx, row)

// ─── Policy ───────────────────────────────────────────────────────────────────
export const DEFAULT_QUOTE_VISIBILITY_POLICY = {
  targetPriceRangePercent: 15, // ±15% band visible to supply_chain
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const BROKER_ROLES = new Set(['broker_supply', 'broker_factory', 'broker_customer']);

function isTraderOrPlatform(role) {
  return role === 'trader' || role === 'platform_admin' || role === 'platform_finance';
}

function isBroker(role) {
  return BROKER_ROLES.has(role);
}

// service types that receive the target price ±range (not raw)
const SC_TARGET_PRICE_RANGE_TYPES = new Set(['ocean', 'customs', 'trucking', 'ddp']);

// ─── canViewBl (§4.5 stage × role matrix) ────────────────────────────────────
/**
 * @param {{ role, serviceType?, stage?, isAssignedOceanBidder?, fulfillmentMode? }} ctx
 * @returns {boolean}
 */
export function canViewBl(ctx) {
  const { role, serviceType, stage, isAssignedOceanBidder, fulfillmentMode } = ctx;
  const effectiveStage = stage || 'quoting';

  switch (effectiveStage) {
    case 'quoting':
      return false;

    case 'accepted':
      if (role === 'supply_chain' && serviceType === 'ocean') {
        return !!isAssignedOceanBidder;
      }
      return isTraderOrPlatform(role);

    case 'assigned':
      if (role === 'supply_chain' && serviceType === 'ocean') return true;
      if (role === 'factory') return fulfillmentMode === 'direct_export';
      if (role === 'buyer')   return true;
      return isTraderOrPlatform(role);

    default:
      return false;
  }
}

// ─── buildQuoteRequestViewModel ───────────────────────────────────────────────
/**
 * @param {object|null}  ctx    - { role, serviceType?, companyCode?, stage?, isAcceptedBidder? }
 * @param {object|null}  row    - QuoteRequestRow (raw DB)
 * @param {object}       policy - { targetPriceRangePercent }
 * @returns {object|null}
 */
export function buildQuoteRequestViewModel(ctx, row, policy) {
  if (!ctx || !row) return null;
  if (isBroker(ctx.role)) return null;

  const pol = policy || DEFAULT_QUOTE_VISIBILITY_POLICY;
  const { role, serviceType, stage, isAcceptedBidder } = ctx;
  const effectiveStage = stage || 'quoting';

  const vm = {
    quoteId:     row.quote_id ?? row.id,
    orderId:     row.order_id,
    orderNo:     row.order_no,
    stage:       effectiveStage,
    serviceType: row.service_type,
    pol:         row.pol,
    pod:         row.pod,
    cargoType:   row.cargo_type,
    totalWeight: row.total_weight ?? undefined,
    totalVolume: row.total_volume ?? undefined,
    etd:         row.etd ?? undefined,
    requestedAt: row.requested_at ?? undefined,
    expiresAt:   row.expires_at ?? undefined,
    status:      row.status ?? undefined,
    _viewer:     { role, serviceType },
  };

  // target_price visibility
  if (isTraderOrPlatform(role)) {
    // trader + platform see raw target price
    if (row.target_price != null) vm.targetPrice = row.target_price;
    if (row.target_currency) vm.targetCurrency = row.target_currency;
  } else if (role === 'supply_chain' && SC_TARGET_PRICE_RANGE_TYPES.has(serviceType)) {
    // supply_chain sees ±range only
    if (row.target_price != null) {
      const pct = pol.targetPriceRangePercent / 100;
      vm.targetPriceRange = {
        low:  Math.round(row.target_price * (1 - pct) * 100) / 100,
        high: Math.round(row.target_price * (1 + pct) * 100) / 100,
        currency: row.target_currency ?? undefined,
      };
    }
  }
  // buyer + factory: no price visibility on quote request

  // cargoDescription: trader + platform only
  if (isTraderOrPlatform(role)) {
    vm.cargoDescription = row.cargo_description ?? undefined;
  }

  // scope_ids: all except broker (already gated above)
  vm.scopeIds = row.scope_ids ?? undefined;

  // incoterm: factory(direct_export) + trader + platform
  if (isTraderOrPlatform(role) || (role === 'factory' && ctx.fulfillmentMode === 'direct_export')) {
    vm.incoterm = row.incoterm ?? undefined;
  }

  // acceptedBidderId: trader + platform + accepted bidder
  if (isTraderOrPlatform(role) ||
      (role === 'supply_chain' && isAcceptedBidder && effectiveStage !== 'quoting')) {
    vm.acceptedBidderId = row.accepted_bidder_id ?? undefined;
  }

  return vm;
}

// ─── buildQuoteBidCardViewModel ───────────────────────────────────────────────
/**
 * @param {object|null} ctx - { role, serviceType?, companyCode? }
 * @param {object|null} row - QuoteBidRow
 * @returns {object|null}
 */
export function buildQuoteBidCardViewModel(ctx, row) {
  if (!ctx || !row) return null;
  if (isBroker(ctx.role)) return null;

  const { role, serviceType, companyCode } = ctx;

  const isOwnBid =
    role === 'supply_chain' &&
    !!companyCode &&
    !!row.bidder_company_code &&
    row.bidder_company_code === companyCode;

  // supply_chain may only see their own bid
  if (role === 'supply_chain' && !isOwnBid) return null;

  const vm = {
    bidId:       row.bid_id ?? row.id,
    quoteId:     row.quote_id,
    serviceType: row.service_type ?? serviceType,
    status:      row.status ?? undefined,
    submittedAt: row.submitted_at ?? undefined,
    _viewer:     { role, serviceType },
  };

  // offeredPrice: own bidder + trader + platform
  if (isTraderOrPlatform(role) || isOwnBid) {
    vm.offeredPrice    = row.offered_price ?? undefined;
    vm.offeredCurrency = row.offered_currency ?? undefined;
  }

  // allInPrice (the customer-facing composed price): trader + platform only
  if (isTraderOrPlatform(role)) {
    vm.allInPrice    = row.all_in_price ?? undefined;
    vm.allInCurrency = row.all_in_currency ?? undefined;
  }

  // supplierLocalCharge: own bidder + trader + platform (C2 tier)
  if ((isTraderOrPlatform(role) || isOwnBid) && row.supplier_local_charge != null) {
    vm.supplierLocalCharge = {
      amount:   row.supplier_local_charge_amount ?? undefined,
      currency: row.supplier_local_charge_currency ?? undefined,
    };
  }

  // bidderCompanyCode: trader + platform only (identity isolation)
  if (isTraderOrPlatform(role)) {
    vm.bidderCompanyCode = row.bidder_company_code ?? undefined;
  }

  // remarks: own bidder + trader + platform
  if (isTraderOrPlatform(role) || isOwnBid) {
    vm.remarks = row.remarks ?? undefined;
  }

  return vm;
}

// ─── buildCollabSheetViewModel ────────────────────────────────────────────────
/**
 * @param {object|null} ctx - { role, serviceType?, companyCode?, stage?, isAssignedOceanBidder?, fulfillmentMode? }
 * @param {object|null} row - CollabSheetRow
 * @returns {object|null}
 */
export function buildCollabSheetViewModel(ctx, row) {
  if (!ctx || !row) return null;
  if (isBroker(ctx.role)) return null;

  const { role, serviceType, companyCode, stage, isAssignedOceanBidder, fulfillmentMode } = ctx;
  const effectiveStage = stage || 'quoting';

  const vm = {
    collabId:          row.collab_id,
    orderId:           row.order_id,
    orderNo:           row.order_no,
    mainStage:         row.main_stage,
    serviceType:       row.service_type,
    scopeIds:          row.scope_ids,
    cargoCategory:     row.cargo_category,
    vessel:            row.vessel,
    voyage:            row.voyage,
    etd:               row.etd,
    eta:               row.eta,
    pol:               row.pol,
    pod:               row.pod,
    blDraftStatus:     row.bl_draft_status,
    invoiceStatus:     row.invoice_status,
    packingListStatus: row.packing_list_status,
    customsStatus:     row.customs_status,
    exceptionType:     row.exception_type,
    exceptionNote:     row.exception_note,
    handoffStatus:     row.handoff_status,
    submittedAt:       row.submitted_at,
    collabStatus:      row.collab_status,
    _viewer:           { role, serviceType },
  };

  // §A incoterm: factory(direct_export) + trader + platform
  if (isTraderOrPlatform(role) || (role === 'factory' && fulfillmentMode === 'direct_export')) {
    vm.incoterm = row.incoterm ?? undefined;
  }

  // §D cargo detail: trader + platform only
  if (isTraderOrPlatform(role)) {
    vm.cargoDescription = row.cargo_description ?? undefined;
    vm.declaredValue    = row.declared_value ?? undefined;
  }

  // §G trucking
  const isTruckingViewer =
    (role === 'supply_chain' && serviceType === 'trucking') || isTraderOrPlatform(role);

  if (isTruckingViewer) {
    vm.pickupAddress   = row.pickup_address ?? undefined;
    vm.deliveryAddress = row.delivery_address ?? undefined;
    vm.truckPlate      = row.truck_plate ?? undefined;
    vm.driverName      = row.driver_name ?? undefined;
    // truckingCompanyCode: own trucking sc + trader (not other sc companies)
    const isOwnTrucking =
      role === 'supply_chain' &&
      serviceType === 'trucking' &&
      !!companyCode &&
      row.trucking_company_code === companyCode;
    if (isTraderOrPlatform(role) || isOwnTrucking) {
      vm.truckingCompanyCode = row.trucking_company_code ?? undefined;
    }
  }

  // §H BL number
  if (canViewBl({ role, serviceType, stage: effectiveStage, isAssignedOceanBidder, fulfillmentMode }) && row.bl_no) {
    vm.blNo = row.bl_no;
  }

  // §H booking_no: supply_chain[ocean] + trader + platform
  if ((role === 'supply_chain' && serviceType === 'ocean') || isTraderOrPlatform(role)) {
    vm.bookingNo = row.booking_no ?? undefined;
  }

  // §H HS code + declaration_elements: supply_chain[customs|ddp] + trader + platform_admin
  if (
    (role === 'supply_chain' && (serviceType === 'customs' || serviceType === 'ddp')) ||
    role === 'trader' ||
    role === 'platform_admin'
  ) {
    vm.hsCode              = row.hs_code ?? undefined;
    vm.declarationElements = row.declaration_elements ?? undefined;
  }

  // §I C1 local_charge_rule: trader + platform_admin only
  if ((role === 'trader' || role === 'platform_admin') && row.local_charge_rule) {
    vm.localChargeRule = {
      ruleId:          row.local_charge_rule.rule_id ?? row.local_charge_rule.ruleId,
      defaultAmount:   row.local_charge_rule.default_amount ?? row.local_charge_rule.defaultAmount,
      currency:        row.local_charge_rule.currency,
      chargeItems:     row.local_charge_rule.charge_items ?? row.local_charge_rule.chargeItems,
      overrideAllowed: row.local_charge_rule.override_allowed ?? row.local_charge_rule.overrideAllowed,
    };
  }

  // §I C2 supplier_local_charge: supply_chain(own) + trader + platform
  const isOwnSupplier =
    role === 'supply_chain' &&
    !!companyCode &&
    !!row.supplier_company_code &&
    row.supplier_company_code === companyCode;
  if ((isTraderOrPlatform(role) || isOwnSupplier) && row.supplier_local_charge) {
    vm.supplierLocalCharge = {
      amount:   row.supplier_local_charge.amount,
      currency: row.supplier_local_charge.currency,
      items:    row.supplier_local_charge.items,
    };
  }

  // §I C3 customer_local_charge_display: buyer + trader + platform
  if ((role === 'buyer' || isTraderOrPlatform(role)) && row.customer_local_charge_display) {
    vm.customerLocalChargeDisplay = {
      displayAmount:   row.customer_local_charge_display.display_amount ??
                       row.customer_local_charge_display.displayAmount,
      displayCurrency: row.customer_local_charge_display.display_currency ??
                       row.customer_local_charge_display.displayCurrency,
      displayLabel:    row.customer_local_charge_display.display_label ??
                       row.customer_local_charge_display.displayLabel,
    };
  }

  // §K loading_photos: factory + trader
  if ((role === 'factory' || isTraderOrPlatform(role)) && row.loading_photos) {
    vm.loadingPhotos = row.loading_photos;
  }

  // §K inspection_photos: supply_chain[customs] + trader
  if (
    ((role === 'supply_chain' && serviceType === 'customs') || isTraderOrPlatform(role)) &&
    row.inspection_photos
  ) {
    vm.inspectionPhotos = row.inspection_photos;
  }

  // §M internal_notes: trader only
  if (role === 'trader' && row.internal_notes) {
    vm.internalNotes = row.internal_notes;
  }

  return vm;
}
