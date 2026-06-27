// bl-clause-parser.mjs — BL 货运条款解析器(防 Prepaid 类污染)
// GPT起草(forge_dq)+Claude审(release_type保留中文)。三概念各归各位:
//   Incoterm→freight_term / 运费付款→freight_payment / 放货方式→release_type(中文) / 箱型→container_service / 场站→handover_term
const INCOTERMS = ['EXW','FCA','FAS','FOB','CFR','CNF','CIF','CPT','CIP','DAP','DPU','DDP','DAT'];
export function parseBlClause(text) {
  const t = String(text || '').toUpperCase();
  const out = { freight_term: null, freight_payment: null, release_type: null, container_service: null, handover_term: null, raw: text || null };
  if (!t.trim()) return out;
  // 运费付款方式
  if (/\b(OCEAN\s+)?FREIGHT\s+PREPAID\b|\bPREPAID\b/.test(t)) out.freight_payment = 'PREPAID';
  else if (/\b(OCEAN\s+)?FREIGHT\s+COLLECT\b|\bCOLLECT\b/.test(t)) out.freight_payment = 'COLLECT';
  // 放货方式(中文标准,与现有库一致)
  if (/TELEX\s*RELEASE|SURRENDER|电放/.test(t)) out.release_type = '电放';
  else if (/SEA\s*WAYBILL|\bSWB\b|EXPRESS\s+RELEASE|海运单/.test(t)) out.release_type = 'SWB';
  else if (/ORIGINAL\s*B\/?L|3\/3\s*ORIGINAL|FULL\s+SET\s+ORIGINAL|正本/.test(t)) out.release_type = '正本';
  // 箱型/场站
  const cs = t.match(/\b(FCL[-/]FCL|LCL[-/]LCL|FCL[-/]LCL|LCL[-/]FCL)\b/);  if (cs) out.container_service = cs[1].replace('/','-');
  const ho = t.match(/\b(CY[-/]CY|CFS[-/]CFS|CY[-/]CFS|CFS[-/]CY)\b/);       if (ho) out.handover_term = ho[1].replace('/','-');
  // Incoterm:唯一命中才认(避免误配)
  const found = INCOTERMS.filter(ic => new RegExp('\\b'+ic+'\\b').test(t));
  if (found.length === 1) out.freight_term = found[0] === 'CNF' ? 'CFR' : found[0];
  return out;
}
// 归一已有字段:把脏 freight_term/release_type 拆正
export function normalizeShippingTerms({ freight_term, release_type } = {}) {
  const merged = parseBlClause([freight_term, release_type].filter(Boolean).join(' / '));
  const r = {};
  // freight_term:只保留合法Incoterm,否则交给parser结果
  if (freight_term && INCOTERMS.includes(String(freight_term).toUpperCase())) r.freight_term = String(freight_term).toUpperCase()==='CNF'?'CFR':String(freight_term).toUpperCase();
  else if (merged.freight_term) r.freight_term = merged.freight_term;
  else r.freight_term = null;
  if (merged.freight_payment) r.freight_payment = merged.freight_payment;
  if (merged.release_type) r.release_type = merged.release_type;
  else if (release_type && /电放|telex|正本|original|swb|海运单/i.test(release_type)) r.release_type = merged.release_type || (/swb|海运单/i.test(release_type)?'SWB':/正本|original/i.test(release_type)?'正本':'电放');
  else r.release_type = null;
  if (merged.container_service) r.container_service = merged.container_service;
  if (merged.handover_term) r.handover_term = merged.handover_term;
  return r;
}
