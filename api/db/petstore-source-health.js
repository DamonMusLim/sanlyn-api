// 数据加工中心 · 第1层「真源状态」· 0903
// 每日拉完必须回答三件事:拉了没有 / 拉全了没有 / 跟昨天差多少。
//
// 🩸 为什么要这层:最近查出的问题【全部】是这层缺失 ——
//    采集停10天没人知道 · 下游同步停更3天没人知道 · 某模型批量处理静默截断24%没人知道。
//    都不是"数据错",是【没人看它到底跑没跑】。
//
// 🔴 两类红灯必须分开(codex 0903 指出,否则常驻红灯会失去信用):
//    急性  = 今天没拉到/暴跌   → 今天出的事,当天修
//    慢性  = 效期覆盖率37%     → 已知待治理,不该跟急性混在一个灯里
//
// ⛔ 只读。⛔ 缺值留 null 不填 0(红线④:「没有」和「取不到」必须分得开)
// ⛔ 返回体不含成本/进价/毛利/银行账号
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 核心源:上游每日全量拉进来的三张 + 效期。挑它们是因为下游七层全靠它们。
const CORE = [
  { t: "petstore_sku_snapshots",  label: "SKU快照",   daily: true },
  { t: "petstore_sku_sales_dna",  label: "销售DNA",   daily: true },
  { t: "petstore_price_history",  label: "价格历史",  daily: true },
  { t: "petstore_daily_todo",     label: "每日待办",  daily: true }
];

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

  const pool = getPool();
  try {
    // ── 今日 vs 昨日快照做差。⚠️ stats_reset 变了说明累计值被重置过,差值无意义 ──
    const { rows: snap } = await pool.query(
      `WITH t AS (SELECT * FROM petstore_table_stat_snapshot WHERE snapshot_date=CURRENT_DATE),
            y AS (SELECT * FROM petstore_table_stat_snapshot WHERE snapshot_date=CURRENT_DATE-1)
       SELECT t.table_name, t.row_est, t.read_total, t.write_total, t.stats_reset, t.last_autoanalyze,
              y.row_est AS y_row, y.read_total AS y_read, y.write_total AS y_write,
              (y.stats_reset IS DISTINCT FROM t.stats_reset) AS stats_was_reset
         FROM t LEFT JOIN y ON y.table_name=t.table_name`);
    const byName = Object.fromEntries(snap.map(r => [r.table_name, r]));

    // ── 效期覆盖率:有库存的品里有多少条真日期 ──
    const cov = (await pool.query(
      `SELECT count(*) FILTER (WHERE cur_stock>0) AS with_stock,
              count(*) FILTER (WHERE cur_stock>0 AND product_code IN
                (SELECT product_code FROM petstore_offline_expiry_snapshot)) AS with_date
         FROM petstore_sku_sales_dna
        WHERE as_of=(SELECT max(as_of) FROM petstore_sku_sales_dna)`)).rows[0];
    const withStock = Number(cov.with_stock), withDate = Number(cov.with_date);
    const covPct = withStock > 0 ? Math.round(withDate * 1000 / withStock) / 10 : null;

    const acute = [], chronic = [], ok = [];
    // 没有昨日快照 = 所有"跟昨天比"的判据都还不能用。第一天必然如此。
    let baselineMissing = !snap.some(r => r.y_row != null);
    for (const c of CORE) {
      const s = byName[c.t];
      if (!s) { acute.push({ src: c.label, level: "red", why: "今日无快照 —— 采集器没跑" }); continue; }
      const rowDelta = s.y_row == null ? null : Number(s.row_est) - Number(s.y_row);
      const pct = (s.y_row == null || Number(s.y_row) === 0) ? null
                : Math.round(rowDelta * 1000 / Number(s.y_row)) / 10;
      const writeDelta = s.y_write == null ? null : Number(s.write_total) - Number(s.y_write);
      const item = { src: c.label, table: c.t, rows: Number(s.row_est),
                     row_delta: rowDelta, row_delta_pct: pct,   // null = 昨天没基准,⛔不填0
                     write_delta: writeDelta,
                     last_write: s.last_autoanalyze || null,
                     stats_was_reset: s.stats_was_reset || false };
      if (Number(s.row_est) === 0)             acute.push({ ...item, level: "red",  why: "核心源条数为 0" });
      else if (s.stats_was_reset)              ok.push({ ...item, level: "gray", why: "PG统计被重置,差值本轮不可信" });
      else if (writeDelta === 0)               acute.push({ ...item, level: "red",  why: "今日零写入 —— 拉取没跑或没拉到新数据" });
      else if (pct !== null && pct < -10)      acute.push({ ...item, level: "red",  why: "条数较昨日跌 " + Math.abs(pct) + "%" });
      else if (pct !== null && Math.abs(pct) >= 3) ok.push({ ...item, level: "yellow", why: "条数波动 " + pct + "%" });
      else                                     ok.push({ ...item, level: "green", why: "正常" });
    }

    // 慢性:已知待治理,⛔不跟急性混
    if (covPct !== null && covPct < 80) {
      chronic.push({ src: "效期覆盖率", level: covPct < 50 ? "red" : "yellow",
        value: covPct + "%", detail: withDate + " / " + withStock + " 个有库存品有真日期",
        why: "覆盖率 " + covPct + "% —— 临期分析跑在残缺基数上,算出的「快过期」必然偏",
        kind: "已知待治理" });
    }

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      // 🔴 第一天没有昨日基准时,增量判据全部失效 —— 必须说清,⛔不许报"正常"蒙混
      verdict: acute.length ? ("🔴 " + acute.length + " 项急性")
             : (baselineMissing ? "⚠️ 无昨日基准,增量判据本轮未生效(明天起才有效)" : "✅ 今日拉取正常"),
      baseline_ready: !baselineMissing,
      acute,      // 今天出的事
      chronic,    // 已知待治理,⛔别跟急性混在一个灯里
      normal: ok,
      known_blind_spot: "⚠️ 上游改了字段【含义】时,行数没变、空值率没变,这层看不出来。只能抽样人工核对,无自动化方案。"
    });
  } catch (e) {
    console.error("[petstore-source-health]", e);
    return res.status(500).json({ error: "server_error" });
  }
}
