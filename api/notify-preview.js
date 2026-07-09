// api/notify-preview.js — POST /api/notify/preview { project_key, context } → 只解析不发送
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

    const result = await runNotification(pool, project, { context: b.context || {}, dryRun: true });
    return res.json({ success: true, ...result });
  } catch (e) {
    console.error("[notify-preview]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
