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

export async function ticketTerms(pool, blNo) {
  if (!blNo) return "";
  const r = await pool.query(
    `SELECT string_agg(DISTINCT NULLIF(BTRIM(trade_terms),''), '+') AS terms
       FROM orders WHERE deleted_at IS NULL AND BTRIM(bl_no)=BTRIM($1)`, [blNo]);
  return (r.rows[0] && r.rows[0].terms) || "";
}
