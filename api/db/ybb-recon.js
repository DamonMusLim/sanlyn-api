// api/db/ybb-recon.js — 洋宝宝收付对账板。AI自动匹配每笔款项(确定/疑似)+人工审核。
import { getPool, setCors } from "../db.js";

async function resolveOrder(pool, s) {
  const txt = (s.remark_note || "") + " " + (s.remark_details || "");
  const dir = s.direction, cp = (dir === "收款" ? s.sender_name : s.beneficiary_name) || "";
  if (!cp || /银行/.test(cp)) return null;
  const contracts = (txt.match(/\b(?:PBTYF|FS)[-\dA-Z]+/gi) || []);
  const bls = (txt.match(/\b\d{8,}\b/g) || []);
  const invs = (txt.match(/\bFI-[\dA-Z-]+/gi) || []);
  if (invs.length) {
    const r = await pool.query(`SELECT contract_nos FROM finance_invoices_out WHERE invoice_no = ANY($1) LIMIT 1`, [invs]);
    if (r.rows[0]?.contract_nos?.length) contracts.push(...r.rows[0].contract_nos);
  }
  if (!contracts.length && !bls.length) return null;
  const r = await pool.query(
    `SELECT o.order_no, o.contract_no, o.customer, o.issuing_company, sp.shipment_no, sp.bl_no
     FROM orders o LEFT JOIN shipping_plans sp ON o.order_no = ANY(sp.order_nos)
     WHERE o.contract_no = ANY($1) OR sp.bl_no = ANY($2) OR EXISTS(SELECT 1 FROM unnest(sp.contract_nos) c WHERE c = ANY($1))
     LIMIT 1`, [contracts.length ? contracts : ['__none__'], bls.length ? bls : ['__none__']]);
  return r.rows[0] || null;
}

function suggestBills(bills, payAmount) {
  const target = Math.abs(+payAmount || 0);
  const rows = bills.map(b => ({ ...b, amountNum: Math.abs(+b.amount || 0) })).filter(b => b.amountNum > 0).sort((a,b)=>b.amountNum-a.amountNum);
  let pick = [], sum = 0;
  for (const b of rows) {
    if (sum + b.amountNum <= target * 1.05) { pick.push(b); sum += b.amountNum; }
    if (Math.abs(sum - target) <= target * 0.05) break;
  }
  if (Math.abs(sum - target) > target * 0.05) {
    let best = { diff: Math.abs(sum - target), pick };
    const n = Math.min(rows.length, 18);
    for (let mask = 1; mask < (1 << n); mask++) {
      let s = 0, p = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) { s += rows[i].amountNum; p.push(rows[i]); }
      const diff = Math.abs(s - target);
      if (diff < best.diff) best = { diff, pick: p };
      if (diff <= target * 0.05) break;
    }
    pick = best.pick;
  }
  return pick.map(b => b.bl_no).filter(Boolean);
}

async function getCandidates(pool, id) {
  const slipQ = await pool.query(
    `SELECT id, amount, currency FROM bank_slips WHERE id=$1 AND created_by='claude-csv-import-ybb-202606'`, [id]);
  const slip = slipQ.rows[0];
  if (!slip) return null;
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='freight_supplier_bills' AND column_name IN ('currency','currency_norm')`);
  const has = new Set(cols.rows.map(r => r.column_name));
  const curExpr = has.has("currency_norm") && has.has("currency") ? "COALESCE(fsb.currency_norm,fsb.currency)" : has.has("currency_norm") ? "fsb.currency_norm" : "fsb.currency";
  const billsQ = await pool.query(
    `SELECT fsb.bl_no, sp.shipment_no, ord.order_no, ord.issuing_company, ord.customer,
            fsb.amount, fsb.ap_status
       FROM freight_supplier_bills fsb
       LEFT JOIN shipping_plans sp ON sp.bl_no = fsb.bl_no
       LEFT JOIN LATERAL (
         SELECT string_agg(o.order_no, ', ' ORDER BY o.order_no) AS order_no,
                string_agg(DISTINCT o.issuing_company, ', ') AS issuing_company,
                string_agg(DISTINCT o.customer, ', ') AS customer
           FROM orders o WHERE sp.order_nos IS NOT NULL AND o.order_no = ANY(sp.order_nos)
       ) ord ON true
      WHERE fsb.supplier ILIKE '%万汇恒通%'
        AND fsb.ap_status='unpaid'
        AND ${curExpr} = $1
      ORDER BY fsb.bl_no, fsb.amount`, [slip.currency]);
  const bills = billsQ.rows.map(b => ({ ...b, amount: +b.amount }));
  return { payAmount: Math.abs(+slip.amount || 0), currency: slip.currency, bills, suggested: suggestBills(bills, slip.amount) };
}

// AI 匹配每笔: 给做账口径 + 置信度(确定/疑似/待人工)
async function aiMatch(pool, s, order, ybbShipments) {
  const dir = s.direction, amt = Math.abs(+s.amount || 0);
  const cp = (dir === "收款" ? s.sender_name : s.beneficiary_name) || "";
  const bt = s.business_type || "";
  const memo = (s.remark_details || "") + (s.purpose_code || "") + (s.remark_note || "") + bt;
  if (/息/.test(memo) && !cp) return { label: "银行利息收入", side: "其他收益", conf: "确定", basis: "摘要=结息" };
  if (/维护费|电讯费|手续费/.test(memo) && !cp) return { label: "银行费用-" + (memo.match(/维护费|电讯费|手续费/) || [""])[0], side: "财务费用", conf: "确定", basis: "摘要=银行收费" };
  if (dir === "收款" && /JJ PET/i.test(cp)) {
    if (order) return { label: `货代运费收入 · JJ PET`, side: "主营业务收入-国际货代免税", conf: "确定", basis: `附言引用发票/提单 → 订单${order.order_no}`, note: "免税/汇率待核" };
    return { label: "货代运费收入 · JJ PET", side: "主营业务收入", conf: "疑似", basis: "客户=JJ PET，未连到订单" };
  }
  if (dir === "付款" && /万汇恒通/.test(cp)) {
    const kind = /港杂/.test(memo) ? "港杂费" : "出口海运费";
    const cand = ybbShipments.map(c => `${c.shipment_no}(出单:${c.issuing_company||"?"}·客户:${c.customer||"?"})`).slice(0,3).join(" 或 ");
    const guess = cand ? `疑似对应本月出运柜：${cand}${ybbShipments.length>3?" 等":""}` : "待人工核对具体柜";
    return { label: `货代成本-${kind}`, side: "主营业务成本-国际货代成本", conf: "疑似", basis: `供应商=万汇恒通，用途=${kind}`, note: guess + "。核对金额/柜后确认", candidates: ybbShipments };
  }
  return { label: "待人工判断", side: "", conf: "待人工", basis: "" };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  try {
    if (req.method === "GET" && req.query?.action === "candidates") {
      if (!req.query.id) return res.status(400).json({ ok: false, error: "缺 id" });
      const data = await getCandidates(pool, req.query.id);
      if (!data) return res.status(404).json({ ok: false, error: "流水不存在" });
      return res.status(200).json({ ok: true, ...data });
    }
    if (req.method === "PATCH") {
      const { id, note, reviewed, allocations } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: "缺 id" });
      const patch = {};
      if (note !== undefined) patch.note = String(note || "");
      if (reviewed !== undefined) patch.reviewed = reviewed ? "1" : "";
      if (allocations !== undefined) {
        if (!Array.isArray(allocations)) return res.status(400).json({ ok: false, error: "allocations 必须是数组" });
        const slipQ = await pool.query(`SELECT amount FROM bank_slips WHERE id=$1 AND created_by='claude-csv-import-ybb-202606'`, [id]);
        if (!slipQ.rows[0]) return res.status(404).json({ ok: false, error: "流水不存在" });
        patch.allocations = allocations.map(a => ({
          bl_no: String(a.bl_no || ""),
          shipment_no: String(a.shipment_no || ""),
          alloc_amount: +(a.alloc_amount || 0)
        })).filter(a => a.alloc_amount > 0);
        patch.allocated = patch.allocations.reduce((n, a) => n + a.alloc_amount, 0);
        patch.unallocated = Math.abs(+slipQ.rows[0].amount || 0) - patch.allocated;
      }
      await pool.query(`UPDATE bank_slips SET raw = COALESCE(raw,'{}'::jsonb)||$2::jsonb, updated_at=NOW() WHERE id=$1 AND created_by='claude-csv-import-ybb-202606'`, [id, JSON.stringify(patch)]);
      return res.status(200).json({ ok: true });
    }
    // 本月洋宝宝出运柜(供疑似匹配提示)
    // 候选柜 = 本月收款已匹配到的出运柜(带出单公司/客户), 供付款疑似提示
    const slipsQ = await pool.query(
      `SELECT id, raw->>'direction' AS direction, amount, currency, payment_date,
              sender_name, beneficiary_name, purpose_code, remark_details,
              raw->>'remark_note' AS remark_note, raw->>'business_type' AS business_type, raw->>'note' AS note, raw->>'reviewed' AS reviewed,
              raw->'allocations' AS allocations, raw->>'allocated' AS allocated, raw->>'unallocated' AS unallocated
       FROM bank_slips WHERE created_by='claude-csv-import-ybb-202606' ORDER BY payment_date, id`);
    const resolved = [];
    for (const s of slipsQ.rows) resolved.push({ s, order: await resolveOrder(pool, s).catch(() => null) });
    const seen = new Set();
    const ybbShipments = resolved.filter(r => r.s.direction === "收款" && r.order && r.order.shipment_no)
      .map(r => r.order).filter(o => !seen.has(o.shipment_no) && seen.add(o.shipment_no));
    const slips = [];
    for (const { s, order } of resolved) {
      const ai = await aiMatch(pool, s, order, ybbShipments);
      slips.push({ ...s, order, ai, reviewed: s.reviewed === "1", allocated: +(s.allocated || 0), unallocated: +(s.unallocated || 0), allocations: s.allocations || [] });
    }
    const sum = (d, c) => slips.filter(s => s.direction === d && s.currency === c).reduce((a, s) => a + Math.abs(+s.amount), 0);
    const ap = await pool.query(`SELECT COUNT(*)::int c, COALESCE(SUM(amount),0) amt FROM freight_supplier_bills WHERE supplier ILIKE '%万汇恒通%' AND ap_status='unpaid'`);
    const ar = await pool.query(`SELECT COUNT(*)::int c, COALESCE(SUM(amount_incl_tax),0) amt FROM finance_invoices_out WHERE seller_name LIKE '%上海洋宝宝%' AND issue_date >= '2026-06-01' AND issue_date < '2026-07-01'`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      ok: true, company: "上海洋宝宝国际物流有限公司", period: "2026-06",
      summary: { inUSD: sum("收款","USD"), outUSD: sum("付款","USD"), inCNY: sum("收款","CNY"), outCNY: sum("付款","CNY"),
                 total: slips.length,
                 sure: slips.filter(s=>s.ai.conf==="确定").length,
                 doubt: slips.filter(s=>s.ai.conf==="疑似").length,
                 reviewed: slips.filter(s=>s.reviewed).length,
                 matched: slips.filter(s=>s.order).length,
                 apUnpaidCount: ap.rows[0].c, apUnpaidAmt: +ap.rows[0].amt, arCount: ar.rows[0].c, arAmt: +ar.rows[0].amt },
      slips });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}
