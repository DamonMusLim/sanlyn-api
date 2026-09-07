// 数据加工中心 · 第4层「产品分析」· 0903
// 回答:我们到底在卖什么、卖得动吗、钱压在哪。
//
// 🩸 为什么这层必须在效期/价格/采购【之前】:
//    实测 1,123 个有货 SKU 里只有 18 个(1.6%)卖得动,1,105 个压着 ¥112,681。
//    没这层,前面全在给一堆卖不动的货做质检 —— 日期补齐、货位找到、价格改对,它还是卖不动。
//
// ⛔ 不重复造:petstore-store-product-analysis.js 已给「在架率/动销率/缺货率」6个汇总数,
//    本接口只补它没有的维度:品类结构 / 动销分层 / 品牌 / 商品完整度 / 死货占款。
// ⛔ 只读 · 缺值留 null 不填 0 · 返回体不含成本/进价/毛利率/银行账号
//    ⚠️ 占款金额是【库存价值】,由 cur_stock×cost_price 聚合而来,只出聚合值不出单品成本。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") { if (!requireAuth(req, res)) return; }
  const store = (req.query?.storeCode || "63350001").slice(0, 32);
  const pool = getPool();
  try {
    const LATEST = `(SELECT max(as_of) FROM petstore_sku_sales_dna)`;

    const velocity = (await pool.query(
      `SELECT COALESCE(velocity_tier,'(未分层)') tier, count(*)::int n,
              round(sum(cur_stock*cost_price))::int amt
         FROM petstore_sku_sales_dna
        WHERE as_of=${LATEST} AND store_code=$1 AND cur_stock>0
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST`, [store])).rows;

    const cat = (await pool.query(
      `SELECT COALESCE(category_name,'(无品类)') cat, count(*)::int n,
              count(*) FILTER (WHERE cur_stock>0)::int in_stock,
              count(*) FILTER (WHERE qty_30>0)::int moving,
              round(sum(cur_stock*cost_price))::int amt
         FROM petstore_sku_sales_dna
        WHERE as_of=${LATEST} AND store_code=$1
        GROUP BY 1 ORDER BY 5 DESC NULLS LAST LIMIT 14`, [store])).rows;

    // 自有品牌 vs 他人 —— 战略上完全两套定价逻辑,必须分开看
    const OWN = "LUVSOME|SNIFFLY|CATSOME|DOGSOME|PETSOME|ENRICH";
    const brand = (await pool.query(
      `SELECT CASE WHEN product_name ~* $2 THEN '自有品牌' ELSE '他人品牌' END b,
              count(*)::int n, count(*) FILTER (WHERE cur_stock>0)::int in_stock,
              count(*) FILTER (WHERE qty_30>0)::int moving,
              round(sum(cur_stock*cost_price))::int amt
         FROM petstore_sku_sales_dna
        WHERE as_of=${LATEST} AND store_code=$1
        GROUP BY 1 ORDER BY 5 DESC NULLS LAST`, [store, OWN])).rows;

    // 商品完整度:能不能被顾客搜到/看到
    const comp = (await pool.query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE COALESCE(barcode,'')='')::int no_barcode,
              count(*) FILTER (WHERE product_status='UP')::int listed,
              count(*) FILTER (WHERE product_status='UP' AND COALESCE(stock_num,0)<=0)::int listed_oos
         FROM petstore_product_status_current WHERE store_code=$1`, [store])).rows[0];

    const n = v => v == null ? null : Number(v);
    const totalAmt = velocity.reduce((s,v)=>s+(Number(v.amt)||0),0);
    const bad = velocity.filter(v=>["dead","slow","stale"].includes(v.tier));
    const badN = bad.reduce((s,v)=>s+Number(v.n),0), badAmt = bad.reduce((s,v)=>s+(Number(v.amt)||0),0);
    const good = velocity.filter(v=>["fast","steady"].includes(v.tier));
    const goodN = good.reduce((s,v)=>s+Number(v.n),0);
    const stockN = velocity.reduce((s,v)=>s+Number(v.n),0);

    return res.status(200).json({
      store_code: store, generated_at: new Date().toISOString(),
      headline: stockN > 0
        ? `有货 ${stockN} 个品,只有 ${goodN} 个(${(goodN*100/stockN).toFixed(1)}%)卖得动;${badN} 个压着 ¥${badAmt.toLocaleString("zh-CN")}`
        : "无有货商品",
      verdict: (stockN>0 && goodN*100/stockN < 10) ? "red" : "ok",
      velocity: velocity.map(v=>({tier:v.tier, n:n(v.n), stock_value:n(v.amt),
        pct: stockN? Math.round(Number(v.n)*1000/stockN)/10 : null})),
      category: cat.map(c=>({name:c.cat, skus:n(c.n), in_stock:n(c.in_stock), moving:n(c.moving),
        stock_value:n(c.amt),
        moving_pct: Number(c.in_stock)>0 ? Math.round(Number(c.moving)*1000/Number(c.in_stock))/10 : null})),
      brand: brand.map(b=>({name:b.b, skus:n(b.n), in_stock:n(b.in_stock), moving:n(b.moving),
        stock_value:n(b.amt),
        moving_pct: Number(b.in_stock)>0 ? Math.round(Number(b.moving)*1000/Number(b.in_stock))/10 : null})),
      completeness: {
        total: n(comp.total), listed: n(comp.listed),
        listed_pct: Number(comp.total)>0 ? Math.round(Number(comp.listed)*1000/Number(comp.total))/10 : null,
        no_barcode: n(comp.no_barcode),
        listed_but_oos: n(comp.listed_oos)
      },
      total_stock_value: totalAmt,
      note: "动销分层来自 sku_sales_dna.velocity_tier(滚动30/90天),⛔不用自然月 month_sale"
    });
  } catch (e) { return res.status(500).json({ error: String(e.message||e).slice(0,200) }); }
}
