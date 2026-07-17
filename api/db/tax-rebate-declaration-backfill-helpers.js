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

export function contractNoTokens(contractNo) {
  const s = text(contractNo);
  if (!s) return [];
  return Array.from(new Set(s.split(/[\/,，;；\s]+/).map((x) => x.trim()).filter(Boolean)));
}

export function shippingPlanResolution(contractNo, rows) {
  const candidates = Array.from(new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => text(row?._id ?? row?.id ?? row))
      .filter(Boolean)
  )).sort();
  const tokens = contractNoTokens(contractNo);
  return {
    tokens,
    candidates,
    shipping_plan_id: candidates[0] || null,
    skipped: candidates.length === 0,
  };
}

export function missingShippingPlanSkipRecord({ customs_no, declaration_no, declaration_index, contract_no }) {
  return {
    customs_no: text(customs_no),
    declaration_no: text(declaration_no),
    declaration_index,
    contract_no: text(contract_no),
    reason: "contract_no has no matching shipping_plans._id",
  };
}

export function ownerCompanyIdFromRows(rows, taxId = TAX_ID) {
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id == null) {
    throw new Error(`owner company not configured for tax_id=${taxId}`);
  }
  return rows[0].id;
}
