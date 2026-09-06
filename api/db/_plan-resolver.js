// api/db/_plan-resolver.js
// 运单归集解析共用逻辑:录入不卡,只把无法归集的风险显式标出来。

function cleanText(v) {
  return String(v ?? "").trim();
}

export const PLAN_LOOKUPS = [
  ["bl_no", "bl_no"],
  ["mbl_no", "mbl_no"],
  ["hbl_no", "hbl_no"],
  ["so_no", "so_no"],
  ["booking_no", "booking_no"],
  ["forwarder_booking_no", "forwarder_booking_no"],
  ["container_no", "container_no"],
];

export function lookupValue(refs = {}, key, blNo) {
  const aliases = {
    mbl_no: ["mbl_no", "mbl"],
    hbl_no: ["hbl_no", "hbl"],
    so_no: ["so_no", "shipping_order_no"],
    booking_no: ["booking_no", "booking"],
    forwarder_booking_no: ["forwarder_booking_no", "fwd_booking_no"],
    container_no: ["container_no", "container"],
  };
  if (key === "bl_no") return cleanText(refs.bl_no || blNo);
  for (const alias of aliases[key] || [key]) {
    const v = cleanText(refs[alias]);
    if (v) return v;
  }
  if (key === "mbl_no" || key === "hbl_no") return cleanText(blNo);
  return "";
}

export async function resolvePlanIdForBillResult(db, blNo, linkPlanId, refs = {}) {
  const raw = cleanText(linkPlanId);
  if (/^[0-9]+$/.test(raw)) {
    return { planId: raw, status: "matched", method: "link_plan_id", tried: [] };
  }

  const tried = [];
  for (const [method, column] of PLAN_LOOKUPS) {
    const value = lookupValue(refs, method, blNo);
    if (!value) continue;
    const plans = await db.query(
      `SELECT id
         FROM shipping_plans
        WHERE deleted_at IS NULL
          AND ${column} = $1
        ORDER BY id
        LIMIT 2`,
      [value]
    );
    tried.push({ method, value, matches: plans.rows.length });
    if (plans.rows.length === 1) {
      return { planId: String(plans.rows[0].id), status: "matched", method, tried };
    }
    if (plans.rows.length > 1) {
      // 2026 实测累计 352 行悬空(CNY412,248+USD57,918+EUR9,500):多命中不能猜第一条,只标记待人工归集。
      return { planId: null, status: "ambiguous", tried };
    }
  }

  // 2026 实测 05-21 漏113行/04-21漏96/05-15漏57/06-02漏50/06-07漏28:录入不卡,解析不到写 govern_flag 暴露风险。
  return { planId: null, status: "unmatched", tried };
}

export function planGovernFlag(result) {
  if (result.status === "ambiguous") return "unlinked_ambiguous";
  if (result.status === "unmatched") return "unlinked_pending";
  return null;
}

export function planWarning(row, result) {
  if (result.status === "matched") return null;
  return {
    bl_no: cleanText(row.bl_no),
    link_plan_id: cleanText(row.link_plan_id) || null,
    status: result.status,
    govern_flag: planGovernFlag(result),
    tried: result.tried,
  };
}

export function planStats(results) {
  return {
    total_rows: results.length,
    linked: results.filter((r) => r.status === "matched").length,
    unmatched: results.filter((r) => r.status === "unmatched").length,
    ambiguous: results.filter((r) => r.status === "ambiguous").length,
  };
}
