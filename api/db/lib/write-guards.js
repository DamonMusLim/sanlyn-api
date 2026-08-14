// 写入闸·纯函数层 — 2026-08-13 脏数据根治 V1
// 规则1: FOB 票的 CNY 非驳船费目不得有卖价(FOB只收海运费) — 自动置0并出警告, 不拦截
// 规则2: 金额 0 视为"未填", 归一为 null (防 COALESCE 回落被 0 堵死)

export function guardBillRow(row, tradeTerms) {
  const isFob = String(tradeTerms || "").trim().toUpperCase() === "FOB";
  const cur = String(row.currency || "CNY").toUpperCase();
  const cat = String(row.cost_category || "");
  if (isFob && cur === "CNY" && !/驳船|barge/i.test(cat) && Number(row.sale_amount || 0) > 0) {
    return {
      sale: 0,
      warning: `FOB票[${cat}]卖价${row.sale_amount}已置0(FOB只收海运费; 驳船联程另计)`,
    };
  }
  return { sale: null, warning: null }; // sale=null 表示不干预
}

export function normalizeAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

// 四路匹配同 recon order_pick: BL / shipping_plan_id / order_nos / contract_nos — 漏一路都可能把混票误判纯FOB
export async function ticketTerms(pool, plan) {
  if (!plan) return "";
  const r = await pool.query(
    `SELECT string_agg(DISTINCT t, '+' ORDER BY t) AS terms FROM (
       SELECT NULLIF(BTRIM(o.trade_terms),'') AS t FROM orders o
        WHERE o.deleted_at IS NULL AND (
              (NULLIF(BTRIM($1::text),'') IS NOT NULL AND BTRIM(o.bl_no)=BTRIM($1::text))
           OR o.shipping_plan_id::text = $2::text
           OR o.order_no = ANY(COALESCE($3::text[],'{}'::text[]))
           OR o.contract_no = ANY(COALESCE($4::text[],'{}'::text[]))
        )) x WHERE t IS NOT NULL`,
    [plan.bl_no || "", String(plan._id || ""), plan.order_nos || null, plan.contract_nos || null]);
  return (r.rows[0] && r.rows[0].terms) || "";
}

// 归属判定(Damon 0815铁律): 外单借巴匕协议价订舱→账单抬头是巴匕属正常, 但费用归属只认实际订单。
// 有我方订单 → payer=票客户; 无订单 → payer 必须留空(绝不默认BABI), 由调用方建"待归属"任务。
export async function resolvePayer(pool, plan) {
  if (!plan) return { payer: null, owned: false };
  const r = await pool.query(
    `WITH matched AS (
       SELECT NULLIF(BTRIM(o.company_code), '') AS payer,
              COALESCE(o.customer_amount, o.total_amount, 0) AS order_amount,
              o.id
         FROM orders o
        WHERE o.deleted_at IS NULL AND (
            (NULLIF(BTRIM($1::text),'') IS NOT NULL AND BTRIM(o.bl_no)=BTRIM($1::text))
         OR o.shipping_plan_id::text = $2::text
         OR o.order_no = ANY(COALESCE($3::text[],'{}'::text[]))
         OR o.contract_no = ANY(COALESCE($4::text[],'{}'::text[]))
        )
     )
     SELECT EXISTS(SELECT 1 FROM matched) AS owned,
            (
              SELECT payer
                FROM matched
               WHERE payer IS NOT NULL
               ORDER BY order_amount DESC NULLS LAST, id
               LIMIT 1
            ) AS payer`,
    [plan.bl_no || "", String(plan._id || ""), plan.order_nos || null, plan.contract_nos || null]);
  return { payer: r.rows[0]?.payer || null, owned: !!r.rows[0]?.owned };
}
