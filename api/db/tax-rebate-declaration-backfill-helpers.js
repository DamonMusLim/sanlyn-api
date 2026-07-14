import { TAX_ID } from "./tax-rebate-taxpayer.js";

export function text(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

export function containerNosArray(v) {
  const s = text(v);
  if (!s) return null;
  return s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

export function pendingShippingPlanId(customsNo) {
  const no = text(customsNo);
  if (!no) throw new Error("customs_no is required for pending shipping_plan_id");
  return `pending_shipping_plan_link:${no}`;
}

export function ownerCompanyIdFromRows(rows, taxId = TAX_ID) {
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id == null) {
    throw new Error(`owner company not configured for tax_id=${taxId}`);
  }
  return rows[0].id;
}
