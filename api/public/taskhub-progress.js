// api/public/taskhub-progress.js — 任务中心新UI(thread.html)第三视图「项目进度」后端数据源
// 独立文件(遵守 CLAUDE.md「新功能拆独立文件」),不往 taskhub.js(391行)里堆。
//
//   GET /api/public/taskhub/progress → 项目级聚合(不是349条明细!):
//     按 tasks.domain 分组 → 每组 total/done/doing/open/stuck + 最近活跃时间
//     stuck 口径:status='open' AND created_at < now()-3天(未关闭超3天),这是唯一能从现有列
//     真实推出的"卡住"信号 —— updated_at 有全局触发器每次 UPDATE 都会刷新,不能拿它判断"没人动过"。
//
// 无鉴权(public,同 taskhub.js 系列约定)。只读 GET,不写库。
//
// 2026-07-22 fast-worker 首版:domain 现网分布见下方 DOMAIN_LABELS 注释,general 域 119 张 open
// 是历史杂项混合体(非单一项目),如实标注不假装成"一个项目"。

import { getPool, setCors } from "../db.js";

// 现网 domain → 展示名(2026-07-22 实测分布,见文件头);未在表里的 domain 会用原始值兜底,不会漏项
const DOMAIN_LABELS = {
  general: "未分类/历史杂项(旧 general 域,非单一项目)",
  对账: "对账",
  退税: "退税专项",
  petshop: "宠物店运营",
  宠物店: "宠物店(旧域,含义同 petshop,待合并)",
  ai基建: "AI 基建",
  customs: "报关",
  ocean: "海运",
  infra: "基础设施",
  "admin-ui": "Admin 后台",
  recon: "对账(recon,旧英文域,待与「对账」合并)",
  finance: "财务",
  luvsome: "LuvSome 小程序",
};

function labelFor(domain) {
  return DOMAIN_LABELS[domain] || `未标注域:${domain}`;
}

// 项目级聚合:排除 cancelled(不算进度),按 domain 分组统计 4 个状态桶 + stuck + 最近活跃
const PROGRESS_SQL = `
  SELECT
    domain,
    count(*)::int AS total,
    count(*) FILTER (WHERE status = 'done')::int AS done,
    count(*) FILTER (WHERE status = 'doing')::int AS doing,
    count(*) FILTER (WHERE status = 'open')::int AS open,
    count(*) FILTER (WHERE status = 'open' AND created_at < now() - interval '3 days')::int AS stuck,
    max(updated_at) AS last_activity
  FROM tasks
  WHERE status <> 'cancelled'
  GROUP BY domain
  ORDER BY last_activity DESC
`;

async function handleProgress(req, res, pool) {
  const r = await pool.query(PROGRESS_SQL);
  const projects = r.rows.map((row) => ({
    domain: row.domain,
    label: labelFor(row.domain),
    total: row.total,
    done: row.done,
    doing: row.doing,
    open: row.open,
    stuck: row.stuck,
    last_activity: row.last_activity,
  }));
  return res.status(200).json({
    success: true,
    projects,
    data_source:
      "tencent sanlyn_db.tasks 按 domain 分组聚合(真实SQL,排除cancelled) · stuck = open 任务 created_at 超3天未关闭(真实,不用updated_at因全局触发器每次UPDATE都刷新)",
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  const p = req.path || "";

  try {
    if (p.endsWith("/progress")) return await handleProgress(req, res, pool);
    return res.status(404).json({ success: false, error: "unknown taskhub-progress route" });
  } catch (err) {
    console.error("[taskhub-progress]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
