import { buildInvoiceByTicket, ticketKey } from "./freight-match-sources.js";

const FEE_TOLERANCE = { CNY: 200, USD: 50 };
const norm = (v) => String(v ?? "").trim();
const upper = (v) => norm(v).toUpperCase();
const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const date10 = (v) => (v ? String(v).slice(0, 10) : null);
const ccy = (v) => {
  const s = upper(v);
  return s === "RMB" || s === "人民币" ? "CNY" : s;
};
const moneyText = (amount, currency) => `${currency} ${num(amount).toFixed(2)}`;
const invoiceDateFromNo = (v) => upper(v).match(/-(\d{8})(?:-\d+)?$/)?.[1]?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") || null;

function refToken(v, kind = "ref") {
  const s = upper(v);
  if (!s || ["-", "—", "NULL", "N/A"].includes(s)) return "";
  if (kind === "cy") return /^CY\d{4,}$/.test(s) ? s : "";
  if (kind === "bl" && /^\d{9,}$/.test(s)) return s;
  if (s.length < 8 || !/[A-Z]/.test(s) || !/\d/.test(s)) return "";
  return s;
}

function invoiceMentions(text) {
  const hay = upper(text);
  const re = /\b(?:(?:FI|OF|PC|EXW)-[A-Z0-9]+(?:-\d{4,8}(?:-\d+)?)?|PB[A-Z0-9-]*-\d{8}(?:-\d+)?)\b/g;
  const legacy = /\b(?:XM\d[A-Z0-9.-]*|WP(?:20\d|-ORDER)[A-Z0-9.-]*|PBTDA[A-Z0-9.-]*\d[A-Z0-9.-]*|PBTDB[A-Z0-9.-]*\d[A-Z0-9.-]*|PBZCA[A-Z0-9.-]*\d[A-Z0-9.-]*|PBZSA[A-Z0-9.-]*\d[A-Z0-9.-]*|PBXCF[A-Z0-9.-]*\d[A-Z0-9.-]*)\b/g;
  return Array.from(new Set([...(hay.match(re) || []), ...(hay.match(legacy) || [])]));
}

function aliasesForInvoice(invNo) {
  const s = upper(invNo);
  const out = new Set([s]);
  const m = s.match(/^((?:FI|OF|PC|EXW)-[A-Z0-9]+)(?:-(\d{4,8})(?:-\d+)?)?$/);
  if (m) {
    out.add(m[1]);
    if (m[2]) {
      for (let i = 4; i <= m[2].length; i += 1) out.add(`${m[1]}-${m[2].slice(0, i)}`);
    }
  }
  return Array.from(out).filter(Boolean);
}

function buildInvoiceIndex(entries) {
  const byAlias = new Map();
  for (const entry of entries) {
    for (const alias of aliasesForInvoice(entry.invoice_no)) {
      if (!byAlias.has(alias)) byAlias.set(alias, []);
      byAlias.get(alias).push(entry);
    }
  }
  return byAlias;
}

function resolveMention(ref, invoiceIndex) {
  const r = upper(ref);
  if (invoiceIndex.has(r)) return invoiceIndex.get(r);
  const out = [];
  for (const [alias, entries] of invoiceIndex.entries()) {
    if (alias.startsWith(r) || r.startsWith(alias)) out.push(...entries);
  }
  const seen = new Set();
  return out.filter((x) => {
    const k = `${x.ticket_key}|${upper(x.invoice_no)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function refBelongsToTicket(ref, ticket, invoices = []) {
  const r = upper(ref);
  if ((invoices || []).some((x) => aliasesForInvoice(x.invoice_no).includes(r))) return true;
  const cy = upper(ticket.cy_no || ticket.shipment_no);
  const bl = upper(ticket.bl_no);
  return (!!cy && new RegExp(`^(FI|OF|EXW)-${cy}(?:-|$)`).test(r))
    || (!!bl && new RegExp(`^(PC|OF|EXW)-${bl}(?:-|$)`).test(r));
}

function invoiceEntries(invoiceByTicket) {
  const out = [];
  for (const [ticket_key, invoices] of invoiceByTicket.entries()) {
    for (const inv of invoices) out.push({ ticket_key, invoice_no: inv.invoice_no, invoice: inv });
  }
  return out;
}

function buildTokens(tickets, invoiceByTicket) {
  const map = new Map();
  for (const t of tickets) {
    const set = new Set();
    const key = ticketKey(t);
    const cy = refToken(t.cy_no, "cy");
    const bl = refToken(t.bl_no, "bl");
    if (cy) set.add(cy);
    if (bl) set.add(bl);
    for (const inv of invoiceByTicket.get(key) || []) for (const a of aliasesForInvoice(inv.invoice_no)) set.add(a);
    map.set(key, [...set]);
  }
  return map;
}

function groupInfo(kind, row, hay, invoiceIndex) {
  const refs = invoiceMentions(hay);
  for (const alias of invoiceIndex.keys()) {
    if (alias.length >= 6 && /[A-Z]/.test(alias) && /\d/.test(alias) && hay.includes(alias)) refs.push(alias);
  }
  const uniqRefs = Array.from(new Set(refs));
  if (!uniqRefs.length) return null;
  const known = [];
  const unknown = [];
  const seen = new Set();
  for (const ref of uniqRefs) {
    const hits = resolveMention(ref, invoiceIndex);
    if (!hits.length) {
      unknown.push(ref);
      continue;
    }
    for (const h of hits) {
      const k = `${h.ticket_key}|${upper(h.invoice_no)}`;
      if (!seen.has(k)) {
        seen.add(k);
        known.push(h);
      }
    }
  }
  if (!known.length) return null;
  if (known.length < 2 && !unknown.length) return null;
  const cur = ccy(row.currency);
  const total = num(known.reduce((a, x) => a + (cur === "USD" ? num(x.invoice.amount_usd) : num(x.invoice.amount_cny)), 0));
  const received = num(row.amount);
  const diff = num(total - received);
  const settled = !unknown.length && known.length >= 2 && total > 0 && diff >= 0 && diff <= (FEE_TOLERANCE[cur] || 0);
  const amountByTicket = new Map();
  for (const k of known) {
    const amt = cur === "USD" ? num(k.invoice.amount_usd) : num(k.invoice.amount_cny);
    amountByTicket.set(k.ticket_key, num((amountByTicket.get(k.ticket_key) || 0) + amt));
  }
  const source = kind === "flow" ? "流水" : "水单";
  const missing = unknown.length ? `${unknown.join(", ")} 未登记` : "";
  return {
    status: settled ? "settled_by_group" : "pending_split",
    group_count: known.length + unknown.length,
    group_invoice_total: total || null,
    group_received_amount: received,
    group_difference: total ? diff : null,
    group_currency: cur,
    group_note: settled ? `同笔${source}合付 ${known.length} 张` : missing || `${source} #${row.id} 点名发票待拆`,
    amountByTicket,
  };
}

function matchingKeys(tokensByTicket, ticketByKey, invoiceByTicket, hay, account) {
  const keys = [...tokensByTicket.entries()].filter(([, toks]) => toks.some((tok) => hay.includes(tok))).map(([k]) => k);
  if (account !== "babi") return keys;
  const refs = invoiceMentions(hay);
  return keys.filter((k) => refs.some((r) => refBelongsToTicket(r, ticketByKey.get(k) || {}, invoiceByTicket.get(k) || [])));
}

function flowReceipts(flows, ctx) {
  const out = [];
  for (const f of flows || []) {
    const account = lowerAccount(f.entity_code);
    if (!["oceanbaby", "babi"].includes(account)) continue;
    if (["out", "refund"].includes(upper(f.direction).toLowerCase())) continue;
    if (norm(f.source_file).startsWith("lemon-cloud")) continue;
    const hay = upper([f.memo, f.purpose].join(" "));
    const keys = matchingKeys(ctx.tokensByTicket, ctx.ticketByKey, ctx.invoiceByTicket, hay, account);
    if (!keys.length) continue;
    const group = groupInfo("flow", f, hay, ctx.invoiceIndex);
    for (const key of keys) {
      out.push(receipt("flow", f, key, account, hay, group));
    }
  }
  return out;
}

function lowerAccount(v) {
  const s = upper(v);
  return s === "BABI" ? "babi" : s === "OCEANBABY" ? "oceanbaby" : s.toLowerCase();
}

function receipt(type, row, ticketKeyValue, account, hay, group = null, amountOverride = null) {
  const status = group?.amountByTicket?.has(ticketKeyValue) ? group.status : group ? "pending_split" : type === "slip" && !row.matched_flow_id ? "pending" : "booked";
  return {
    ticket_key: ticketKeyValue,
    type,
    id: row.id,
    date: date10(row.tx_date || row.payment_date),
    amount: amountOverride ?? (group?.status === "settled_by_group" && group.amountByTicket.has(ticketKeyValue) ? group.amountByTicket.get(ticketKeyValue) : num(row.amount)),
    currency: ccy(row.currency || row.alloc_currency),
    account,
    memo_ref: norm([row.memo, row.purpose, row.beneficiary_reference, row.remark_details].filter(Boolean).join(" ")),
    status,
    matched_flow_id: row.matched_flow_id || null,
    group_count: group?.group_count || null,
    group_invoice_total: group?.group_invoice_total || null,
    group_received_amount: group?.group_received_amount || null,
    group_difference: group?.group_difference ?? null,
    group_currency: group?.group_currency || null,
    group_note: group?.group_note || null,
  };
}

function linkReceipts(links, slips, ctx) {
  const out = [];
  const slipById = new Map((slips || []).map((s) => [String(s.id), s]));
  for (const l of links || []) {
    if (l.alloc_status !== "allocated" && l.alloc_status !== "pending_allocation") continue;
    const s = slipById.get(String(l.slip_id));
    if (!s || upper(s.cash_direction) === "OUT") continue;
    const t = ctx.tickets.find((x) => upper(x.bl_no) === upper(l.bl_no) || upper(x.cy_no) === upper(l.shipment_no));
    if (!t) continue;
    const hay = upper([l.note, l.alloc_note, s.beneficiary_reference, s.remark_details].join(" "));
    if (!/OCEAN FREIGHT|FI-|OF-|PC-|EXW-|运费/.test(hay)) continue;
    const account = lowerAccount(s.beneficiary_company_code || "oceanbaby");
    if (account === "babi" && !invoiceMentions(hay).some((r) => refBelongsToTicket(r, t, ctx.invoiceByTicket.get(ticketKey(t)) || []))) continue;
    const group = groupInfo("slip", s, hay, ctx.invoiceIndex);
    out.push(receipt("slip", s, ticketKey(t), account, hay, group, num(l.amount_alloc || s.amount)));
  }
  return out;
}

function textSlipReceipts(slips, ctx) {
  const out = [];
  for (const s of slips || []) {
    if (upper(s.cash_direction) === "OUT") continue;
    const account = lowerAccount(s.beneficiary_company_code || "oceanbaby");
    const hay = upper([s.beneficiary_reference, s.remark_details].join(" "));
    if (!/OCEAN FREIGHT|FI-|OF-|PC-|EXW-|运费/.test(hay)) continue;
    const keys = matchingKeys(ctx.tokensByTicket, ctx.ticketByKey, ctx.invoiceByTicket, hay, account);
    const group = groupInfo("slip", s, hay, ctx.invoiceIndex);
    for (const key of keys) out.push(receipt("slip", s, key, account, hay, group));
  }
  return out;
}

function dedupeReceipts(receipts) {
  const flows = receipts.filter((x) => x.type === "flow");
  const seen = new Set();
  const out = [];
  for (const r of receipts) {
    if (r.type === "slip") {
      const flow = flows.find((f) => f.ticket_key === r.ticket_key && f.currency === r.currency && Math.abs(num(f.amount) - num(r.amount)) <= 1 && Math.abs(Date.parse(f.date || 0) - Date.parse(r.date || 0)) / 86400000 <= 45);
      if (flow) {
        flow.vouchers = flow.vouchers || [];
        if (!flow.vouchers.some((x) => x.type === "slip" && String(x.id) === String(r.id))) {
          flow.vouchers.push({ type: "slip", id: r.id, date: r.date, amount: r.amount, currency: r.currency, memo_ref: r.memo_ref, status: r.status });
        }
        continue;
      }
    }
    const key = [r.ticket_key, r.type, r.id, r.currency, r.amount, r.status].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function addReceiptInvoices(invoiceByTicket, ticketByKey, receipts) {
  for (const r of receipts) {
    const invoices = invoiceByTicket.get(r.ticket_key) || [];
    const t = ticketByKey.get(r.ticket_key);
    for (const ref of invoiceMentions(r.memo_ref)) {
      if (!t || !refBelongsToTicket(ref, t, invoices)) continue;
      if (invoices.some((x) => aliasesForInvoice(x.invoice_no).includes(upper(ref)))) continue;
      invoices.push({ invoice_no: ref, currency: "", amount_usd: 0, amount_cny: 0, invoice_date: invoiceDateFromNo(ref), is_cif: false, source: "收款引用", source_file: null, note: "金额待补" });
    }
  }
}

function settle(ticket, invoices, receipts) {
  if (invoices.some((x) => x.is_cif)) return { code: "cif", label: "CIF·运费含在货款" };
  if (!invoices.length) return { code: "no_invoice", label: "无发票" };
  const dueUsd = num(invoices.reduce((a, x) => a + num(x.amount_usd), 0));
  const dueCny = num(invoices.reduce((a, x) => a + num(x.amount_cny), 0));
  const amountPending = invoices.some((x) => !num(x.amount_usd) && !num(x.amount_cny));
  const booked = receipts.filter((x) => ["booked", "settled_by_group"].includes(x.status));
  const pending = receipts.filter((x) => x.status === "pending");
  const paidUsd = num(booked.filter((x) => x.currency === "USD").reduce((a, x) => a + num(x.amount), 0));
  const paidCny = num(booked.filter((x) => x.currency === "CNY").reduce((a, x) => a + num(x.amount), 0));
  const pendingUsd = num(pending.filter((x) => x.currency === "USD").reduce((a, x) => a + num(x.amount), 0));
  const pendingCny = num(pending.filter((x) => x.currency === "CNY").reduce((a, x) => a + num(x.amount), 0));
  if (receipts.some((x) => x.status === "pending_split")) {
    const r = receipts.find((x) => x.status === "pending_split");
    return { code: "pending_split", label: r.group_note ? `待拆（${r.group_note}）` : "待拆", due_usd: dueUsd, due_cny: dueCny, paid_usd: paidUsd, paid_cny: paidCny };
  }
  if (amountPending && (paidUsd || paidCny)) return { code: "amount_pending", label: `已收 ${[paidUsd ? moneyText(paidUsd, "USD") : "", paidCny ? moneyText(paidCny, "CNY") : ""].filter(Boolean).join(" + ")}，发票金额待补`, due_usd: dueUsd, due_cny: dueCny, paid_usd: paidUsd, paid_cny: paidCny };
  const usdSettled = dueUsd > 0 && paidUsd > 0 && dueUsd - paidUsd <= FEE_TOLERANCE.USD;
  const cnySettled = dueCny > 0 && paidCny > 0 && dueCny - paidCny <= FEE_TOLERANCE.CNY;
  const dual = invoices.some((x) => num(x.amount_usd) && num(x.amount_cny));
  if (dual ? (usdSettled || cnySettled) : ((!dueUsd || usdSettled) && (!dueCny || cnySettled))) return { code: "settled", label: "已结清", due_usd: dueUsd, due_cny: dueCny, paid_usd: paidUsd, paid_cny: paidCny };
  const pendingSettled = (dueUsd > 0 && paidUsd + pendingUsd > 0 && dueUsd - paidUsd - pendingUsd <= FEE_TOLERANCE.USD) || (dueCny > 0 && paidCny + pendingCny > 0 && dueCny - paidCny - pendingCny <= FEE_TOLERANCE.CNY);
  if (pendingSettled) return { code: "pending_arrival", label: "待到账", due_usd: dueUsd, due_cny: dueCny, paid_usd: paidUsd, paid_cny: paidCny, pending_usd: pendingUsd, pending_cny: pendingCny };
  return { code: "unpaid", label: "未收", due_usd: dueUsd, due_cny: dueCny, paid_usd: paidUsd, paid_cny: paidCny };
}

export function matchFreight(input) {
  const tickets = input.tickets || [];
  const invoiceByTicket = input.invoiceByTicket || buildInvoiceByTicket(input);
  const ticketByKey = new Map(tickets.map((t) => [ticketKey(t), t]));
  const entries = invoiceEntries(invoiceByTicket);
  const ctx = { tickets, ticketByKey, invoiceByTicket, tokensByTicket: buildTokens(tickets, invoiceByTicket), invoiceIndex: buildInvoiceIndex(entries) };
  const receipts = dedupeReceipts([...flowReceipts(input.flows || [], ctx), ...linkReceipts(input.links || [], input.slips || [], ctx), ...textSlipReceipts(input.slips || [], ctx)]);
  addReceiptInvoices(invoiceByTicket, ticketByKey, receipts);
  const receiptByTicket = new Map();
  for (const r of receipts) {
    if (!receiptByTicket.has(r.ticket_key)) receiptByTicket.set(r.ticket_key, []);
    receiptByTicket.get(r.ticket_key).push(r);
  }
  return tickets.map((t) => {
    const key = ticketKey(t);
    const invoices = invoiceByTicket.get(key) || [];
    const recs = receiptByTicket.get(key) || [];
    return { cy_no: norm(t.cy_no), bl_no: norm(t.bl_no), invoices, receipts: recs, settle_status: settle(t, invoices, recs) };
  });
}

export const __test = { invoiceMentions, aliasesForInvoice, refBelongsToTicket, settle, refToken };
