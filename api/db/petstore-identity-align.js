// 数据加工中心 · 第2层「身份对齐」· 0903
//
// 🩸 为什么这是地基不是一个检查项:
//    同一个数字 6335107466 —— 在线下档案里是 productCode,在线上清单里是 skuId。
//    我曾拿【单键】对两边,算出"全店 0 个无货位商品在卖" —— 假的,真值是 2 个。
//    ⇒ 身份没对齐,后面效期/价格/采购【全会算歪】,而且算出来的数看着很正常。
//
// 这层只回答一件事:两边对得上吗?对不上的在哪一边?
// ⛔ 只读。⛔ 不修数据(修要人批)。⛔ 缺值留 null 不填 0。
// ⛔ 返回体不含成本/进价/毛利/银行账号
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  // 网关已鉴权(nginx auth_request 走 diary_auth cookie)则放行,否则回落到 Bearer。
  // ⛔ 这个头外部伪造不了:nginx 只在 auth_request 通过后才注入。
  //    实测 0903:外部带伪造头+无cookie → 401(nginx先拦);外部裸请求 → 401。
  // ⚠️ 已知边界:【内网直连 9010 带此头 → 200】。9010 只绑内网,能直连的人已在服务器上,
  //    所以不是新开的洞,但也不是零风险。要收紧就把常量换成 .env 里的随机值并与 nginx 同步。
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") {
    if (!requireAuth(req, res)) return;
  }
  const store = (req.query?.storeCode || "63350001").slice(0, 32);
  const pool = getPool();
  try {
    // ── ① 商品主表 vs 门店状态表:productCode 对不对得上 ──
    const a = (await pool.query(
      `SELECT
         (SELECT count(*) FROM petstore_skus)                                   AS master_n,
         (SELECT count(*) FROM petstore_product_status_current WHERE store_code=$1) AS store_n,
         (SELECT count(*) FROM petstore_product_status_current s
           WHERE s.store_code=$1 AND NOT EXISTS
                 (SELECT 1 FROM petstore_skus m WHERE m.product_code=s.product_code)) AS store_orphan,
         (SELECT count(*) FROM petstore_skus m WHERE NOT EXISTS
                 (SELECT 1 FROM petstore_product_status_current s
                   WHERE s.store_code=$1 AND s.product_code=m.product_code))          AS master_only`,
      [store])).rows[0];

    // ── ② 条码维度:主表 upc_code vs 条码表 barcode ──
    const b = (await pool.query(
      `SELECT
         (SELECT count(*) FROM petstore_skus WHERE COALESCE(upc_code,'')<>'')      AS master_has_upc,
         (SELECT count(*) FROM petstore_skus WHERE COALESCE(upc_code,'')='')       AS master_no_upc,
         (SELECT count(DISTINCT product_code) FROM petstore_product_barcodes)      AS bc_products,
         (SELECT count(*) FROM petstore_product_barcodes)                          AS bc_rows,
         (SELECT count(*) FROM (SELECT product_code FROM petstore_product_barcodes
             GROUP BY 1 HAVING count(DISTINCT barcode)>1) x)                       AS multi_barcode,
         (SELECT count(*) FROM (SELECT barcode FROM petstore_product_barcodes
             WHERE COALESCE(barcode,'')<>'' GROUP BY 1 HAVING count(DISTINCT product_code)>1) x) AS shared_barcode`)).rows[0];

    // ── ③ 门店侧条码与主表 upc 是否一致(真正的双索引校验) ──
    const c = (await pool.query(
      `SELECT count(*) FILTER (WHERE COALESCE(s.barcode,'')<>'' AND COALESCE(m.upc_code,'')<>''
                                AND s.barcode <> m.upc_code)                       AS conflict,
              count(*) FILTER (WHERE COALESCE(s.barcode,'')='' )                   AS store_no_barcode
         FROM petstore_product_status_current s
         LEFT JOIN petstore_skus m ON m.product_code=s.product_code
        WHERE s.store_code=$1`, [store])).rows[0];

    const n = v => v == null ? null : Number(v);
    const findings = [];
    const push = (lv, t, v, why) => findings.push({ level: lv, title: t, value: v, why });

    if (n(a.store_orphan) > 0)
      push("red", "门店有、主表没有", n(a.store_orphan),
        "门店在卖但商品主表里查不到 —— 任何按主表做的分析都会漏掉这些");
    if (n(c.conflict) > 0)
      push("red", "同一商品两边条码不一致", n(c.conflict),
        "🩸 这正是「单键对齐算出假结果」的成因 —— 必须双索引(product_code + barcode)");
    if (n(b.shared_barcode) > 0)
      push("red", "一个条码挂多个商品", n(b.shared_barcode),
        "扫码会扫出多个品,双索引也救不了 —— 上游数据本身错(两家模型都点过这个边界)");
    if (n(b.multi_barcode) > 0)
      push("yellow", "一个商品多个条码", n(b.multi_barcode),
        "多包装/换包装通常正常,但对账时要指定用哪个");
    if (n(b.master_no_upc) > 0)
      push("yellow", "主表无条码", n(b.master_no_upc), "这些品只能靠内部编码对齐,单索引");
    if (n(c.store_no_barcode) > 0)
      push("yellow", "门店侧无条码", n(c.store_no_barcode), "扫不了码,店员只能手输");

    return res.status(200).json({
      store_code: store,
      generated_at: new Date().toISOString(),
      verdict: findings.some(f => f.level === "red")
        ? "🔴 身份没对齐 —— 上层分析结果不可全信"
        : "✅ 两侧身份可对齐",
      counts: {
        master_products: n(a.master_n), store_products: n(a.store_n),
        store_orphan: n(a.store_orphan), master_only: n(a.master_only),
        master_has_upc: n(b.master_has_upc), master_no_upc: n(b.master_no_upc),
        barcode_products: n(b.bc_products), barcode_rows: n(b.bc_rows)
      },
      findings,
      note: "⚖️ 双索引只能发现「两边编码不一致」,发现不了「上游数据本身错」(如同一商品被赋两个条码)。后者只能人工核。"
    });
  } catch (e) {
    console.error("[petstore-identity-align]", e);
    return res.status(500).json({ error: "server_error" });
  }
}
