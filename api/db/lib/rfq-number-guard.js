export class RfqNumberValidationError extends Error {
  constructor(field, value, code = "invalid_number", extra = {}) {
    super(`${code}:${field}`);
    this.status = 400;
    this.code = code;
    this.field = field;
    this.value = value;
    Object.assign(this, extra);
  }
}

function hasValue(v) {
  return v !== undefined && v !== null && v !== "";
}

function numberField(source, field, opts = {}) {
  const value = source[field];
  if (!hasValue(value)) {
    if (opts.required) throw new RfqNumberValidationError(field, value, "required");
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new RfqNumberValidationError(field, value);
  if (opts.integer && !Number.isInteger(n)) throw new RfqNumberValidationError(field, value);
  if (opts.min !== undefined && n < opts.min) throw new RfqNumberValidationError(field, value);
  if (opts.max !== undefined && n > opts.max) throw new RfqNumberValidationError(field, value);
  return n;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export function normalizeRfqQuoteNumbers(source = {}, mode = "supplier") {
  const isInternal = mode === "internal";
  const quote = {
    price_incl_tax: numberField(source, "price_incl_tax", { min: 0, required: true }),
    price_ex_tax: numberField(source, "price_ex_tax", { min: 0, required: true }),
    tax_pct: numberField(source, "tax_pct", { min: 0, max: 100, required: true }),
    moq: numberField(source, "moq", { min: 0, integer: true, required: !isInternal }),
    lead_time_days: numberField(source, "lead_time_days", { min: 0, integer: true, required: !isInternal }),
  };
  const expected = round4(quote.price_ex_tax * (1 + quote.tax_pct / 100));
  const diffRate = quote.price_incl_tax === 0
    ? (expected === 0 ? 0 : Infinity)
    : Math.abs(quote.price_incl_tax - expected) / quote.price_incl_tax;
  if (diffRate > 0.005) {
    throw new RfqNumberValidationError("price_incl_tax", source.price_incl_tax, "price_mismatch", {
      price_ex_tax: quote.price_ex_tax,
      tax_pct: quote.tax_pct,
      expected_price_incl_tax: expected,
      got_price_incl_tax: quote.price_incl_tax,
      message: `不含税 ${quote.price_ex_tax} + 税点 ${quote.tax_pct}% 应为含税 ${expected}，你填的含税价是 ${quote.price_incl_tax}，请核对`,
    });
  }
  return quote;
}

export function normalizeRfqSignature(source = {}) {
  const signed_by_name = String(source.signed_by_name == null ? "" : source.signed_by_name).trim();
  const signature_data = String(source.signature_data == null ? "" : source.signature_data).trim();
  if (!signed_by_name || !signature_data) {
    throw new RfqNumberValidationError("signature_data", "", "signature_required");
  }
  if (Buffer.byteLength(signature_data, "utf8") > 200 * 1024) {
    throw new RfqNumberValidationError("signature_data", "", "signature_too_large");
  }
  return { signed_by_name, signature_data };
}

export function calculateRfqFeeAmount(fee) {
  if (fee.unit_price === null || fee.color_count === null) return null;
  return fee.unit_price * fee.color_count;
}

export function normalizeRfqFeeNumbers(source = {}) {
  const fee = {
    unit_price: numberField(source, "unit_price", { min: 0 }),
    color_count: numberField(source, "color_count", { min: 1, integer: true }),
    refund_threshold_qty: numberField(source, "refund_threshold_qty", { min: 0 }),
  };
  return {
    ...fee,
    amount: calculateRfqFeeAmount(fee),
  };
}

export function invalidNumberResponse(res, err) {
  const out = {
    error: err.code,
    field: err.field,
    value: err.value,
  };
  for (const k of ["price_ex_tax", "tax_pct", "expected_price_incl_tax", "got_price_incl_tax", "message"]) {
    if (err[k] !== undefined) out[k] = err[k];
  }
  return res.status(400).json(out);
}
