// api/notify-trigger.js — POST /api/notify/trigger { project_key, context, source_module, source_action }
// 任何模块按钮只需绑一个 project_key，调用本接口即可，不需要知道发给谁/用什么模版/走什么渠道。
import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";
import { ensureNotificationProjects } from "./db/notification-projects.js";
import { runNotification } from "./lib/notify-core.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const pool = getPool();
  try {
    await ensureNotificationProjects(pool);
    const b = req.body || {};
    if (!b.project_key) return res.status(400).json({ error: "project_key 必填" });
    const pr = await pool.query(`SELECT * FROM notification_projects WHERE project_key=$1`, [b.project_key]);
    const project = pr.rows[0];
    if (!project) return res.status(404).json({ error: "找不到通知项目: " + b.project_key });
    if (!project.is_active) return res.status(409).json({ error: "该通知项目已停用" });

    const user = (req.user && (req.user.username || req.user.name)) || "system";
    const result = await runNotification(pool, project, {
      context: b.context || {}, sourceModule: b.source_module, sourceAction: b.source_action,
      triggeredBy: user, dryRun: !!b.dry_run,
    });
    return res.json({ success: true, ...result });
  } catch (e) {
    console.error("[notify-trigger]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
