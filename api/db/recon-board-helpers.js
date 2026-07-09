// recon-board 纯函数辅助层：金额/账龄/状态判定 + 结算线构造。
// 从 recon-board.js 拆出(原文件超500行),这里不连数据库、不认证，只做数据整形。
export const TOLERANCE = 1;
export const STALE_CUTOFF = new Date("2026-06-25T00:00:00Z");

export function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function parseLimit(value) {
  const n = Number(value || 500);
  if (!Number.isFinite(n)) return 500;
  return Math.max(1, Math.min(10000, Math.trunc(n)));
}

export function ageDays(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

export function due(total, paid) {
  const t = money(total);
  if (t === null) return null;
  return Math.max(0, money(t - (money(paid) || 0)));
}

export function isDone(total, paid) {
  const t = money(total);
  return t !== null && (money(paid) || 0) >= t - TOLERANCE;
}

export function isPartial(total, paid) {
  const t = money(total);
  const p = money(paid) || 0;
  return t !== null && p > 0 && p < t - TOLERANCE;
}

export function statusOf(total, paid) {
  if (isDone(total, paid)) return "paid";
  return (money(paid) || 0) > 0 ? "partial" : "unpaid";
}

export function hasText(value) {
  return String(value ?? "").trim() !== "";
}

export function relationTypeLabel(type) {
  return { factory: "工厂", customer: "客户", forwarder: "货代" }[type] || "对方";
}

export function relationTitle(ownEntity, counterpartyType) {
  return `${ownEntity || "缺我方主体"}-${relationTypeLabel(counterpartyType)}`;
}

export function settlementLine({
  sourceType,
  counterpartyType,
  direction,
  ownEntity,
  ownEntityCode,
  counterpartyName,
  counterpartyCode,
  total,
  paid,
  currency,
  refs,
  status,
  tone,
  invoiceStatus,
  slipUploaded,
  dataMissing = false,
  missingReason = null,
}) {
  const t = money(total);
  const p = money(paid) || 0;
  const lineTone = dataMissing ? "risk" : (tone || baseTone({ total: t, paid: p, age: null, invoiceStatus }));
  return {
    id: [
      sourceType,
      refs?.order_no || refs?.shipment_id || refs?.shipment_no || refs?.bl_no || refs?.contract_no || "",
      direction,
      counterpartyType,
      ownEntityCode || ownEntity || "missing-own",
      counterpartyCode || counterpartyName || "missing-party",
      currency || "CNY",
    ].join(":"),
    source_type: sourceType,
    relation_label: relationTitle(ownEntity, counterpartyType),
    own_entity: ownEntity || null,
    own_entity_code: ownEntityCode || null,
    counterparty_type: counterpartyType,
    counterparty_label: relationTypeLabel(counterpartyType),
    counterparty_name: counterpartyName || null,
    counterparty_code: counterpartyCode || null,
    direction,
    currency: currency || "CNY",
    total: t,
    paid: p,
    due: due(t, p),
    status: status || statusOf(t, p),
    tone: lineTone,
    invoice_status: invoiceStatus || null,
    slip_uploaded: Boolean(slipUploaded),
    data_missing: Boolean(dataMissing),
    missing_reason: missingReason || null,
    refs: refs || {},
  };
}

export function aggregateStatus(rows, field) {
  if (!rows.length) return "unpaid";
  const vals = rows.map(r => String(r[field] || "").toLowerCase());
  if (vals.every(v => v === "paid")) return "paid";
  if (vals.some(v => v === "paid" || v === "partial" || v === "partially_paid")) return "partial";
  return "unpaid";
}

export function baseTone({ total, paid, age, invoiceStatus, createdAt }) {
  const t = money(total);
  const p = money(paid) || 0;
  const created = createdAt ? new Date(createdAt) : null;
  const stale = t !== null && p === 0 && created && created < STALE_CUTOFF;
  if (invoiceStatus === "blocked" || isPartial(t, p) || (!stale && t !== null && !isDone(t, p) && age > 60)) return "risk";
  if (invoiceStatus === "pending" || invoiceStatus === "confirmed" || (!stale && t !== null && !isDone(t, p) && age > 30)) return "todo";
  if (stale) return "stale";
  return "done";
}

export function worstTone(tones) {
  for (const t of ["risk", "todo", "stale"]) if (tones.includes(t)) return t;
  return "done";
}

export function ageChip(age, hasDue) {
  if (!hasDue || age === null) return null;
  if (age > 60) return { label: `逾期${age - 60}天`, tone: "risk" };
  if (age > 30) return { label: "到期近", tone: "todo" };
  return null;
}

export function nextAction(row) {
  const s = row.signals || {};
  if (s.invoice_status === "pending" || s.invoice_status === "confirmed") return { label: "确认票面开票", kind: "confirm_invoice" };
  if (s.receivable_due > TOLERANCE && !s.customer_slip_uploaded) return { label: "催客户传水单", kind: "copy_slip_link" };
  if (s.invoice_status === "blocked") return { label: "补报关资料(缺申报额)", kind: "none" };
  if (s.payable_due > TOLERANCE) return { label: "登记工厂付款", kind: "goto_payment" };
  return { label: "—已闭环", kind: "none" };
}

export function amountMapAdd(map, currency, amount) {
  const n = money(amount);
  if (!n || n <= TOLERANCE) return;
  const cur = currency || "CNY";
  map.set(cur, money((map.get(cur) || 0) + n));
}

export function amountList(map) {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount }));
}
