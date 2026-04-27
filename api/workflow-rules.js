// api/workflow-rules.js
// GET  /api/workflow-rules          — 列出规则
// POST /api/workflow-rules          — 新建规则
// PATCH /api/workflow-rules?id=N    — 更新规则
// DELETE /api/workflow-rules?id=N   — 删除规则
// POST /api/workflow-rules?action=fire — 手动触发测试

import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";
import { fireEvent } from "./workflow-engine.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  var pool = getPool();
  var { id, action } = req.query;

  // ── GET: 列出规则 ───────────────────────────────────────────────
  if (req.method === "GET") {
    var { trigger, company_code, company_type, active_only = "1" } = req.query;
    var q = `SELECT * FROM workflow_rules WHERE tenant_id = $1`, p = ["SANLYN"], i = 2;
    if (trigger)      { q += ` AND trigger = $${i++}`;      p.push(trigger); }
    if (company_code) { q += ` AND company_code = $${i++}`; p.push(company_code); }
    if (company_type) { q += ` AND company_type = $${i++}`; p.push(company_type); }
    if (active_only === "1") { q += ` AND is_active = true`; }
    q += ` ORDER BY priority DESC, id ASC`;
    var { rows } = await pool.query(q, p);
    return res.status(200).json({ ok: true, data: rows });
  }

  // ── POST: 新建规则 or 手动触发 ───────────────────────────────────
  if (req.method === "POST") {
    if (action === "fire") {
      // 手动触发（测试 + 运营补触发）
      var { trigger: t, context: ctx } = req.body || {};
      if (!t) return res.status(400).json({ error: "trigger required" });
      var results = await fireEvent(t, ctx || {});
      return res.status(200).json({ ok: true, fired: results.length, results });
    }

    var { name, company_code, company_type, trigger: trg, condition, action: act, action_config, priority } = req.body || {};
    if (!name || !trg || !act) return res.status(400).json({ error: "name, trigger, action required" });

    var { rows: [row] } = await pool.query(
      `INSERT INTO workflow_rules
         (name, company_code, company_type, trigger, condition, action, action_config, priority, tenant_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,'SANLYN')
       RETURNING *`,
      [
        name,
        company_code || null,
        company_type || "all",
        trg,
        JSON.stringify(condition || {}),
        act,
        JSON.stringify(action_config || {}),
        priority || 0,
      ]
    );
    return res.status(201).json({ ok: true, data: row });
  }

  // ── PATCH: 更新规则 ──────────────────────────────────────────────
  if (req.method === "PATCH") {
    if (!id) return res.status(400).json({ error: "id required" });
    var allowed = ["name","company_code","company_type","trigger","condition","action","action_config","priority","is_active"];
    var body = req.body || {};
    var sets = [], params = [], idx = 1;
    for (var k of allowed) {
      if (k in body) {
        var val = (k === "condition" || k === "action_config") ? JSON.stringify(body[k]) : body[k];
        sets.push(`${k} = $${idx++}`);
        params.push(val);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "nothing to update" });
    sets.push(`updated_at = NOW()`);
    params.push(id);
    var { rows: [updated] } = await pool.query(
      `UPDATE workflow_rules SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      params
    );
    if (!updated) return res.status(404).json({ error: "rule not found" });
    return res.status(200).json({ ok: true, data: updated });
  }

  // ── DELETE: 软删（is_active = false） ────────────────────────────
  if (req.method === "DELETE") {
    if (!id) return res.status(400).json({ error: "id required" });
    if (req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
    await pool.query(`UPDATE workflow_rules SET is_active = false, updated_at = NOW() WHERE id = $1`, [id]);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
