// api/db/customs-doc-quality-gate.js — 报关资料出单前质量门禁 (P0, 2026-07-06)
// forge gpt-5.5 系统设计的落地版:只做两项(柜覆盖完整性 + 报关↔商检金额比对),渲染器画图前先调这里判断。
// 字段只对应不编造:查不到就标"数据缺失",不猜测、不静默放行。
import { resolveOrdersForContainer } from "./customs-declaration-form.js";

function clean(v) { return String(v ?? "").trim(); }
function norm(v) { return clean(v).toUpperCase(); }

// ── 柜覆盖完整性 ──────────────────────────────────────────────
// expected = 本 BL 下 order_containers→containers 的真实柜号(唯一真源,不用 shipping_plans.container_qty 弱字段)
// covered  = 本次出单实际覆盖的订单所归属的柜号
export async function checkContainerCoverage(pool, plan, { requestedContainerNo, coveredOrderIds } = {}) {
  const blNo = clean(plan && plan.bl_no);
  const result = { expected: [], covered: [], missing: [], foreign: [], ok: true, reason: "" };
  if (!blNo) { result.reason = "该票无 BL 号,无法核对柜覆盖(跳过)"; return result; }

  const exp = await pool.query(
    `SELECT DISTINCT c.container_no
       FROM order_containers oc
       JOIN containers c ON c.id = oc.container_id
       LEFT JOIN shipment_group sg ON sg.id = c.shipment_group_id
       JOIN orders o ON o.id = oc.order_id
      WHERE (sg.bl_master = $1 OR o.bl_no = $1 OR o.raw->>'blNo' = $1 OR o.raw->>'bl_no' = $1)
        AND NULLIF(btrim(c.container_no),'') IS NOT NULL`,
    [blNo]
  );
  result.expected = exp.rows.map(r => norm(r.container_no)).filter(Boolean);
  if (!result.expected.length) { result.reason = "本票在 order_containers 里查无柜号记录(可能尚未录入真实装柜数据),无法核对完整性"; return result; }

  if (requestedContainerNo) {
    // 按柜出单:只要求"这个柜号确实属于本票",不要求覆盖全部柜
    const want = norm(requestedContainerNo);
    result.covered = [want];
    if (!result.expected.includes(want)) {
      result.foreign = [want];
      result.ok = false;
      result.reason = `柜号 ${requestedContainerNo} 不属于本票(BL ${blNo}) — 阻断`;
    }
    return result;
  }

  // 按 BL 整票出单:必须覆盖 expected 里的全部柜号
  let coveredNos = [];
  if (coveredOrderIds && coveredOrderIds.length) {
    const cov = await pool.query(
      `SELECT DISTINCT c.container_no
         FROM order_containers oc JOIN containers c ON c.id = oc.container_id
        WHERE oc.order_id = ANY($1::int[]) AND NULLIF(btrim(c.container_no),'') IS NOT NULL`,
      [coveredOrderIds]
    );
    coveredNos = cov.rows.map(r => norm(r.container_no)).filter(Boolean);
  }
  result.covered = coveredNos;
  result.missing = result.expected.filter(c => !coveredNos.includes(c));
  result.foreign = coveredNos.filter(c => !result.expected.includes(c));
  if (result.missing.length) {
    result.ok = false;
    result.reason = `本票应有 ${result.expected.length} 个柜(${result.expected.join("/")}),本次单据只覆盖 ${coveredNos.length} 个,缺: ${result.missing.join("/")}`;
  } else if (result.foreign.length) {
    result.ok = false;
    result.reason = `单据里出现了不属于本票的柜号: ${result.foreign.join("/")}`;
  }
  return result;
}

// ── 报关 ↔ 商检 金额比对 ──────────────────────────────────────
// declared = order_line_items subtotal 汇总(报关口径)
// inspection = 已上传真商检单的 OCR 结构化总值(inspection_request_sheets.inspection.items[].value 或 total)
// 扣减项: OLI 里标记为赠品/试吃装(品名含 GIFT/赠品/试吃,或未来 declare_adjustment_type 字段) + 有效CN(status 不是 draft/closed)
export async function checkAmountReconciliation(pool, orderIds, { thresholdPct = 0.05 } = {}) {
  const result = {
    declaredAmount: 0, inspectionAmount: null, diff: null, diffPct: null,
    giftAmount: 0, giftLines: [], creditNotes: [], creditNotesAmount: 0,
    explainedDiff: 0, unexplainedDiff: null,
    status: "pass", reasons: [],
  };
  if (!orderIds || !orderIds.length) { result.status = "warning"; result.reasons.push("无订单范围,无法核对金额"); return result; }

  // 报关金额(OLI汇总) + 赠品/试吃装识别(品名含关键字,forge建议的兜底推断,非自动确认)
  const oli = await pool.query(
    `SELECT product_name, declaration_name, subtotal FROM order_line_items WHERE order_id = ANY($1::int[])`,
    [orderIds]
  );
  let declared = 0;
  const giftLines = [];
  for (const r of oli.rows) {
    const amt = Number(r.subtotal) || 0;
    declared += amt;
    const name = (r.product_name || "") + " " + (r.declaration_name || "");
    if (/赠品|GIFT|试吃|SAMPLE/i.test(name)) giftLines.push({ name: clean(r.product_name), amount: amt });
  }
  result.declaredAmount = Math.round(declared * 100) / 100;
  result.giftAmount = Math.round(giftLines.reduce((s, g) => s + g.amount, 0) * 100) / 100;
  result.giftLines = giftLines;

  // 有效CN(排除draft/closed) — 按order_no匹配(orders.order_no对应credit_notes.order_no)
  const ords = await pool.query(`SELECT order_no FROM orders WHERE id = ANY($1::int[])`, [orderIds]);
  const orderNos = ords.rows.map(r => r.order_no).filter(Boolean);
  if (orderNos.length) {
    const cn = await pool.query(
      `SELECT cn_no, net_amount, status, note FROM credit_notes WHERE order_no = ANY($1::text[]) AND status NOT IN ('closed','draft')`,
      [orderNos]
    );
    // 🚨去重: CN 的 note 若明确写"试吃/赠品/样品/GIFT",大概率就是 OLI 赠品行的贷记记账动作(同一笔经济事项走了
    // 两条腿:OLI报关价+CN冲应付),不能跟 giftAmount 重复相加,否则"扣减项"虚高、未解释差额算成负数。
    // 只有 note 里看不出跟赠品重叠的 CN,才计入独立扣减项。
    result.creditNotes = cn.rows.map(r => {
      const note = clean(r.note);
      const overlapsGift = /赠品|试吃|样品|GIFT/i.test(note);
      return { cn_no: r.cn_no, net_amount: Number(r.net_amount) || 0, status: r.status, note: note.slice(0, 60), overlaps_gift: overlapsGift };
    });
    result.creditNotesAmount = Math.round(
      result.creditNotes.filter(c => !c.overlaps_gift).reduce((s, c) => s + Math.abs(c.net_amount), 0) * 100
    ) / 100;
  }

  // 商检金额: 优先读已OCR的inspection_request_sheets.inspection结构化值(inspection-ocr.js写入的)
  const insp = await pool.query(
    `SELECT inspection FROM inspection_request_sheets WHERE order_id = ANY($1::int[]) ORDER BY id DESC LIMIT 1`,
    [orderIds]
  );
  if (insp.rows.length && insp.rows[0].inspection) {
    const data = insp.rows[0].inspection;
    let total = 0, found = false;
    if (Array.isArray(data.items)) {
      for (const it of data.items) { const v = Number(it.value); if (Number.isFinite(v)) { total += v; found = true; } }
    }
    if (found) result.inspectionAmount = Math.round(total * 100) / 100;
  }

  if (result.inspectionAmount == null) {
    result.status = "warning";
    result.reasons.push("尚无已OCR的商检单结构化金额,无法自动比对(请先上传真商检单并跑 inspection-ocr)");
    return result;
  }

  result.diff = Math.round((result.declaredAmount - result.inspectionAmount) * 100) / 100;
  result.diffPct = result.inspectionAmount ? Math.round((result.diff / result.inspectionAmount) * 10000) / 100 : null;
  result.explainedDiff = Math.round((result.giftAmount + result.creditNotesAmount) * 100) / 100;
  result.unexplainedDiff = Math.round((result.diff - result.explainedDiff) * 100) / 100;

  if (result.declaredAmount < result.inspectionAmount) {
    result.status = "blocked";
    result.reasons.push(`报关金额(${result.declaredAmount}) 低于商检金额(${result.inspectionAmount}) — 有低报嫌疑,阻断`);
  } else if (result.diffPct != null && Math.abs(result.diffPct) > thresholdPct * 100) {
    if (Math.abs(result.unexplainedDiff) > 0.01) {
      result.status = "warning";
      result.reasons.push(`差异 ${result.diffPct}% 超阈值,扣除赠品(${result.giftAmount})+CN(${result.creditNotesAmount})后仍有未解释差额 ${result.unexplainedDiff}`);
    } else {
      result.status = "pass";
      result.reasons.push(`差异 ${result.diffPct}% 但已被赠品/CN完全解释`);
    }
  }
  return result;
}

// ── 渲染横幅 HTML(供各渲染器/bundle插入) ──────────────────────
export function renderGateBanner(coverage, recon) {
  const lines = [];
  if (coverage && !coverage.ok) lines.push("🚫 柜覆盖: " + coverage.reason);
  if (recon) {
    if (recon.status === "blocked") lines.push("🚫 " + recon.reasons.join("; "));
    else if (recon.status === "warning") lines.push("⚠️ " + recon.reasons.join("; "));
  }
  if (!lines.length) return "";
  const blocked = (coverage && !coverage.ok) || (recon && recon.status === "blocked");
  const bg = blocked ? "#fef2f2" : "#fffbeb";
  const bd = blocked ? "#dc2626" : "#f59e0b";
  const title = blocked ? "🚫 质量门禁未通过 — 仅供内部核对,不可正式对外使用" : "⚠️ 质量门禁警告 — 请人工确认后再正式发出";
  return `<div style="border:2px solid ${bd};background:${bg};border-radius:8px;padding:10px 14px;margin:0 0 10px;font-size:11px;color:#7f1d1d;font-family:sans-serif">
    <div style="font-weight:800;margin-bottom:4px">${title}</div>
    ${lines.map(l => `<div>${l.replace(/</g, "&lt;")}</div>`).join("")}
  </div>`;
}
