// change-password.js
// Authenticated user changes their own password
// POST /api/db/change-password
//   body: { oldPassword, newPassword }
//   返回: { success: true }
//
// 校验:
//   - 必须有 valid JWT (req.user)
//   - oldPassword 必须匹配
//   - newPassword 长度 >= 8
//   - bcrypt hash 后存储

import { getPool, setCors } from "../db.js";
import { writeAudit } from "./audit-helper.js";
import bcrypt from "bcryptjs";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  var { oldPassword, newPassword } = req.body || {};
  if (!oldPassword) return res.status(400).json({ error: "oldPassword required" });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: "newPassword must be at least 8 chars" });
  if (oldPassword === newPassword) return res.status(400).json({ error: "new password must differ from old" });

  var pool = getPool();
  try {
    // Fetch current password hash
    var r = await pool.query(
      "SELECT id, username, password FROM accounts WHERE id = $1 OR username = $2 LIMIT 1",
      [req.user.uid, req.user.username]
    );
    if (!r.rows.length) return res.status(404).json({ error: "account not found" });
    var u = r.rows[0];

    // Verify old password (bcrypt or plaintext legacy)
    var ok;
    if (u.password && (u.password.startsWith("$2b$") || u.password.startsWith("$2a$"))) {
      ok = await bcrypt.compare(oldPassword, u.password);
    } else {
      ok = (oldPassword === u.password);
    }
    if (!ok) return res.status(401).json({ error: "old password incorrect" });

    // Hash new password
    var hash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE accounts SET password = $1 WHERE id = $2", [hash, u.id]);

    // Audit
    writeAudit(pool, req, {
      action: "account.change_password",
      entity_type: "account",
      entity_id: u.id,
      diff_summary: "password rotated",
      note: "self-service password change",
    }).catch(() => {});

    return res.status(200).json({ success: true, message: "Password updated. Use the new password next login." });
  } catch (e) {
    console.error("[change-password]", e);
    return res.status(500).json({ error: e.message });
  }
}
