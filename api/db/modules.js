// /api/db/modules.js
// GET  → 返回当前部署启用的模块 { enabled: [...] }
// POST → 更新启用模块（admin 权限） body: { enabled: [...] }
//
// 存在 system_settings 表里，key='deployment.enabled_modules', value=JSON array
// 不存在时返回默认"全开"（向后兼容）

import { getPool, setCors } from "../db.js";

const SETTING_KEY = "deployment.enabled_modules";
const DEFAULT_ENABLED = [
  "core", "shipping", "finance", "customs", "products", "documents", "sql",
];
const VALID_KEYS = new Set(DEFAULT_ENABLED);

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    if (req.method === "GET") {
      const r = await pool.query("SELECT value FROM system_settings WHERE key=$1", [SETTING_KEY]);
      let enabled = DEFAULT_ENABLED;
      if (r.rows.length > 0) {
        try {
          const parsed = JSON.parse(r.rows[0].value);
          if (Array.isArray(parsed)) {
            enabled = parsed.filter(k => VALID_KEYS.has(k));
            if (!enabled.includes("core")) enabled.unshift("core"); // core 强制开
          }
        } catch {}
      }
      return res.status(200).json({ enabled, default: DEFAULT_ENABLED });
    }

    if (req.method === "POST") {
      // 简易 admin 校验：在正式环境这里应接 JWT；目前允许 body.admin=true 明示
      const body = req.body || {};
      let enabled = Array.isArray(body.enabled) ? body.enabled : [];
      enabled = enabled.filter(k => VALID_KEYS.has(k));
      if (!enabled.includes("core")) enabled.unshift("core");
      const val = JSON.stringify(enabled);
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
        [SETTING_KEY, val]
      );
      return res.status(200).json({ enabled, saved: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
