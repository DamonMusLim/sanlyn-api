// 数据加工中心 · 第0层「表注册表」· 0903
// 回答一个问题:这个域到底有哪些表,谁死谁活,哪些没人管。
//
// 🔴 为什么要这一层:七层加工最多覆盖十几张表,该域实测 111 张。
//    另外九十几张【没人知道死活】—— 新表进来没人知道,老表死了也没人知道。
//
// 判据来源(全部可自动算,⛔不许人工维护清单):
//   读写心跳 = pg_stat_user_tables 的 seq_scan+idx_scan / n_tup_ins+upd+del
//              实测 stats_reset=从未重置,累计有效。⛔它是累计值不是时间序列,
//              所以"近N天无读写"要靠每日快照做差(第二版,本版先给累计值)
//   行数     = pg_class.reltuples(估算,⛔不用 count(*) 扫全表)+ 关键表精确校准
//   从未写过 = last_autoanalyze/last_analyze 双空 —— PG 只在表有变化时才 analyze
//
// ⛔ 只读接口。不写任何表、不删、不改。五条数据红线里的第1/2/3条天然满足。
// ⛔ 返回体不含任何成本/进价/毛利/银行账号字段(本接口只碰元数据,不碰业务列)
// ⛔ 缺值留 null 不填 0 ——「没有」和「取不到」必须分得开(红线第4条)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const PREFIX = "petstore";

// 生命周期五态。⚠️ C 类叫「占位/废弃候选」不叫垃圾 —— 真删要挂 Damon。
function judge(t) {
  const rows = t.row_est, r = t.read_total, w = t.write_total, everAnalyzed = t.ever_analyzed;
  // 孤儿:有人写没人读。⚠️ 写了没人用,比死表更浪费(生产了但没销售)
  if (w > 0 && r === 0) return ["孤儿", "有写无读:写" + w + "次,读0次", "high"];
  // 生产中:有行且有读写
  if (rows > 0 && r > 0 && w > 0) return ["生产中", "有行+有读+有写", "high"];
  // 有行但没人读 —— 数据在那儿没人用
  if (rows > 0 && r === 0) return ["无人读取", "有行但读0次", "high"];
  // 以下都是"没数据"的情况,靠有没有人碰过来分
  if (w > 0) return ["路线图", "写过" + w + "次但现在空:功能建了没跑起来", "medium"];
  if (r > 0) return ["采集缺口", "有人读(" + r + "次)但从没写过 —— 界面接了,数据没来", "high"];
  if (!everAnalyzed) return ["占位/废弃候选", "从未analyze+零读零写:建了就没动过", "medium"];
  return ["未归类", "读写都是0但analyze过", "low"];
}

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
    const { rows } = await pool.query(
      `SELECT c.relname AS table_name,
              GREATEST(c.reltuples, 0)::bigint          AS row_est,
              COALESCE(s.seq_scan,0)+COALESCE(s.idx_scan,0)                       AS read_total,
              COALESCE(s.n_tup_ins,0)+COALESCE(s.n_tup_upd,0)+COALESCE(s.n_tup_del,0) AS write_total,
              s.last_autoanalyze, s.last_analyze,
              (s.last_autoanalyze IS NOT NULL OR s.last_analyze IS NOT NULL)       AS ever_analyzed,
              pg_total_relation_size(c.oid)             AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE $1
        ORDER BY c.relname`, [PREFIX + "%"]);

    const items = rows.map(t => {
      const [status, why, confidence] = judge(t);
      return {
        table_name: t.table_name,
        row_est: Number(t.row_est),                    // ⚠️ 估算值,精确值要 count(*)
        read_total: Number(t.read_total),
        write_total: Number(t.write_total),
        last_write_approx: t.last_autoanalyze || t.last_analyze || null,  // null=从未,⛔不填0
        bytes: Number(t.bytes),
        lifecycle_status: status,
        evidence: why,
        confidence,                                    // 扫不到 ≠ 没有
        covered_by: null,          // 第一版留空,后续由加工日志回填。⛔留 null 不填 "未知"
        read_delta_1d: null,       // 需每日快照做差,第二版。⛔留 null 不填 0
        write_delta_1d: null
      };
    });

    const groups = {};
    for (const it of items) {
      (groups[it.lifecycle_status] ||= { status: it.lifecycle_status, count: 0, tables: [] });
      groups[it.lifecycle_status].count++;
      groups[it.lifecycle_status].tables.push(it);
    }
    // 组内按读次数降序 —— 最活跃的在前
    for (const g of Object.values(groups)) g.tables.sort((a,b)=>b.read_total-a.read_total);
    const ORDER = ["孤儿","采集缺口","无人读取","路线图","占位/废弃候选","生产中","未归类"];
    const grouped = ORDER.filter(s=>groups[s]).map(s=>groups[s]);

    return res.status(200).json({
      prefix: PREFIX,
      total: items.length,
      generated_at: new Date().toISOString(),
      note: "读写为 PG 累计值(stats_reset 从未重置);row_est 为估算;delta 与 covered_by 待第二版",
      groups: grouped,
      rows: items
    });
  } catch (e) {
    console.error("[petstore-table-registry]", e);
    return res.status(500).json({ error: "server_error" });
  }
}
