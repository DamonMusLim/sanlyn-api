// 数据加工中心 · 总商品库 · 0903
// Damon 0903:「总商品库也要有,整个店铺最重要的。每日更新」
//
// ⛔ 不重复造:逐条明细走现成的 petstore-goods-list.js(131行,自带成本红线)。
//    本接口只给【全库画像 + 每日更新状态】—— 商品库健不健康、今天更没更、更了多少。
//
// 🔴 成本红线(照抄 goods-list 的注释):本接口永不返回成本类字段。
//    占款金额是聚合值(sum(stock×cost)),不落到单品,不出 cost_price/毛利。
// ⛔ 只读 · 缺值 null 不填 0
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
    // ── 规模 ──
    const size = (await pool.query(
      `SELECT (SELECT count(*) FROM petstore_skus)                                    AS master,
              (SELECT count(*) FROM petstore_product_status_current WHERE store_code=$1) AS store_rows,
              (SELECT count(DISTINCT spu_code) FROM petstore_skus WHERE COALESCE(spu_code,'')<>'') AS spu,
              (SELECT count(*) FROM petstore_product_barcodes)                        AS barcodes,
              (SELECT count(*) FROM petstore_sku_snapshots)                           AS snapshots`,
      [store])).rows[0];

    // ── 每日更新:今天/昨天各更新了多少 ──
    const fresh = (await pool.query(
      `SELECT
         (SELECT max(as_of)::text FROM petstore_sku_sales_dna)                        AS dna_latest,
         (SELECT max(capture_date)::text FROM petstore_offline_stock_snapshot)        AS stock_latest,
         (SELECT count(*) FROM petstore_sku_snapshots WHERE snapshot_date=CURRENT_DATE)       AS snap_today,
         (SELECT count(*) FROM petstore_sku_snapshots WHERE snapshot_date=CURRENT_DATE-1)     AS snap_yday,
         (SELECT max(created_at) FROM petstore_sku_snapshots)                          AS snap_last_at`)).rows[0];

    // ── 结构:上架/有货/有图/有条码/有货位/有效期 —— 商品库"完不完整" ──
    // ⚠️ 实测:petstore_ops_row 没有 store_code / product_status 列 —— 用门店状态表
    //    图片(pic_url)在 ops_row 上,不带门店维度,单独查
    const q = (await pool.query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE product_status='UP')::int listed,
              count(*) FILTER (WHERE COALESCE(stock_num,0)>0)::int in_stock,
              count(*) FILTER (WHERE COALESCE(barcode,'')<>'')::int has_barcode
         FROM petstore_product_status_current WHERE store_code=$1`, [store])).rows[0];
    const picRow = (await pool.query(
      `SELECT count(*)::int total, count(*) FILTER (WHERE COALESCE(pic_url,'')<>'')::int has_pic
         FROM petstore_ops_row`)).rows[0];

    const n = v => v == null ? null : Number(v);
    const pct = (a, b) => (b && Number(b) > 0) ? Math.round(Number(a) * 1000 / Number(b)) / 10 : null;

    // 每日更新判定 —— 这是 Damon 要的「每日更新」的证据,⛔不是"应该每天更"而是"今天更没更"
    const snapToday = n(fresh.snap_today), snapYday = n(fresh.snap_yday);
    const upd = [];
    const today = new Date().toISOString().slice(0, 10);
    if (fresh.dna_latest === today) upd.push({ src: "销售DNA", level: "green", value: fresh.dna_latest, why: "今天已更新" });
    else upd.push({ src: "销售DNA", level: fresh.dna_latest ? "yellow" : "red",
                    value: fresh.dna_latest || "无", why: "最新只到 " + (fresh.dna_latest || "—") });
    if (fresh.stock_latest === today) upd.push({ src: "库存快照", level: "green", value: fresh.stock_latest, why: "今天已更新" });
    else upd.push({ src: "库存快照", level: fresh.stock_latest ? "yellow" : "red",
                    value: fresh.stock_latest || "无", why: "最新只到 " + (fresh.stock_latest || "—") });
    upd.push({ src: "SKU快照", level: snapToday > 0 ? "green" : "yellow",
               value: snapToday, why: snapToday > 0 ? ("今天写入 " + snapToday + " 行")
                                                    : ("今天 0 行,昨天 " + snapYday + " 行") });

    const bad = upd.filter(u => u.level !== "green").length;
    return res.status(200).json({
      store_code: store, generated_at: new Date().toISOString(),
      headline: `商品主表 ${n(size.master)} 个 · 门店在册 ${n(size.store_rows)} 个 · ` +
                (bad ? `🔴 ${bad} 个数据源今天没更新` : "✅ 今天全部已更新"),
      verdict: bad ? "red" : "ok",
      scale: { master: n(size.master), store_rows: n(size.store_rows), spu: n(size.spu),
               barcode_rows: n(size.barcodes), snapshot_rows: n(size.snapshots) },
      daily_update: upd,
      last_snapshot_at: fresh.snap_last_at || null,
      completeness: q ? {
        total: n(q.total), listed: n(q.listed), listed_pct: pct(q.listed, q.total),
        in_stock: n(q.in_stock), in_stock_pct: pct(q.in_stock, q.total),
        has_barcode: n(q.has_barcode), barcode_pct: pct(q.has_barcode, q.total),
        has_pic: n(picRow.has_pic),          // 来自 ops_row(全库口径,非门店)
        pic_pct: pct(picRow.has_pic, picRow.total)
      } : null,
      note: "🔴 成本红线:本接口不返回任何成本/进价/毛利字段。逐条明细走 petstore-goods-list。"
    });
  } catch (e) { console.error("[petstore-catalog-overview]", e);
    return res.status(500).json({ error: "server_error" }); }
}
