// api/db/decision-rules.js — DNA 规则读写 (2026-08-10)
//
// Damon 要的「这条以后照办」：他回一封信的时候顺手把【判断依据】沉淀下来，
// 以后遇到同类先按它拟稿。DNA 攒出来的，不是我猜着写的。
//
// 🔒 存的是【判断依据】不是【回复文本】——存文本只会学出模板，换个措辞就废。
//    scene(什么情况) + logic(依据) + rule_text(结论) 三件套才可复用。
// 🔒 新规则一律 status='candidate'，只拟稿不自动执行；
//    连续被认可 3 次才升 active。Damon 改过一次就 corrected_count+1，够多就降级。
// 🔒 两步确认：前端点两次才落库（create → confirm），随时可 cancel。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const S = v => (v == null ? "" : String(v).trim());
const PROMOTE_AT = 3;      // 认可几次升 active
const DEMOTE_AT = 2;       // 被改几次降回 candidate

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!["admin", "finance", "logistics"].includes(req.user?.role)) {
    return res.status(403).json({ error: "无权限" });
  }
  const pool = getPool();
  const b = req.body || {};

  try {
    // ── 列出（可按域/场景筛）──
    if (req.method === "GET") {
      const domain = S(req.query.domain), q = S(req.query.q);
      const where = [], vals = [];
      if (domain) { vals.push(domain); where.push(`domain = $${vals.length}`); }
      if (q) { vals.push(`%${q}%`); where.push(`(scene ILIKE $${vals.length} OR rule_text ILIKE $${vals.length})`); }
      const r = await pool.query(
        `SELECT id, domain, scene, rule_text, logic, source, status, rule_kind,
                hit_count, corrected_count, active, created_at, updated_at
           FROM decision_rules
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY (status='active') DESC, updated_at DESC LIMIT 200`, vals);
      return res.json({ ok: true, rows: r.rows });
    }

    // ── 新建候选规则（第一次点：只暂存，不落库）──
    // 前端两步：先 POST {action:'draft'} 拿回预览，再 POST {action:'confirm'} 才真写。
    if (req.method === "POST") {
      const action = S(b.action) || "confirm";
      const rule = {
        domain: S(b.domain) || "未分域",
        scene: S(b.scene),
        rule_text: S(b.rule_text),
        logic: S(b.logic),
        source: S(b.source) || `Damon ${new Date().toISOString().slice(5, 10).replace('-', '')}`,
      };
      if (!rule.scene || !rule.rule_text) {
        return res.status(400).json({ ok: false, error: "scene 和 rule_text 必填" });
      }

      // 第一步：只回显预览 + 查有没有已存在的同类，不写库
      if (action === "draft") {
        const dup = await pool.query(
          `SELECT id, scene, rule_text, status FROM decision_rules
            WHERE domain=$1 AND (scene ILIKE $2 OR rule_text ILIKE $3) LIMIT 3`,
          [rule.domain, `%${rule.scene.slice(0, 12)}%`, `%${rule.rule_text.slice(0, 12)}%`]);
        return res.json({ ok: true, step: "draft", preview: rule, 已有同类: dup.rows,
          提示: "再点一次确认才会存进 DNA 库；存进去也只是候选，不会自动执行。" });
      }

      // 第二步：真写，候选态
      const r = await pool.query(
        `INSERT INTO decision_rules (domain, scene, rule_text, logic, source,
                                     active, status, rule_kind, priority, version)
         VALUES ($1,$2,$3,$4,$5, false, 'candidate', 'soft', 50, 1)
         RETURNING id, domain, scene, rule_text, status`,
        [rule.domain, rule.scene, rule.rule_text, rule.logic, rule.source]);
      return res.json({ ok: true, step: "saved", rule: r.rows[0],
        提示: "已存为候选。以后遇到同类会先按它拟稿给你看，认可 " + PROMOTE_AT + " 次才自动执行。" });
    }

    // ── 认可 / 改过 / 取消 ──
    if (req.method === "PATCH") {
      const id = Number(b.id);
      const act = S(b.act);   // approve | corrected | cancel
      if (!id || !act) return res.status(400).json({ ok: false, error: "id 和 act 必填" });

      if (act === "cancel") {
        const r = await pool.query(
          `UPDATE decision_rules SET active=false, status='cancelled', updated_at=now()
            WHERE id=$1 RETURNING id, status`, [id]);
        return r.rows[0] ? res.json({ ok: true, ...r.rows[0] })
                         : res.status(404).json({ ok: false, error: "没这条" });
      }
      if (act === "approve") {
        const r = await pool.query(
          `UPDATE decision_rules
              SET hit_count = COALESCE(hit_count,0)+1,
                  status = CASE WHEN COALESCE(hit_count,0)+1 >= $2 THEN 'active' ELSE status END,
                  active = (COALESCE(hit_count,0)+1 >= $2),
                  updated_at = now()
            WHERE id=$1 RETURNING id, status, hit_count, active`, [id, PROMOTE_AT]);
        return res.json({ ok: true, ...r.rows[0],
          提示: r.rows[0]?.active ? "已升为 active，以后同类会自动按它办" : `再认可 ${PROMOTE_AT - r.rows[0].hit_count} 次就自动执行` });
      }
      if (act === "corrected") {
        // Damon 改了它拟的稿 → 说明这条不准，降级
        const r = await pool.query(
          `UPDATE decision_rules
              SET corrected_count = COALESCE(corrected_count,0)+1,
                  status = CASE WHEN COALESCE(corrected_count,0)+1 >= $2 THEN 'candidate' ELSE status END,
                  active = CASE WHEN COALESCE(corrected_count,0)+1 >= $2 THEN false ELSE active END,
                  updated_at = now()
            WHERE id=$1 RETURNING id, status, corrected_count, active`, [id, DEMOTE_AT]);
        return res.json({ ok: true, ...r.rows[0],
          提示: r.rows[0]?.active === false ? "已降回候选，不再自动执行" : "已记一次修正" });
      }
      return res.status(400).json({ ok: false, error: "act 只能是 approve/corrected/cancel" });
    }

    return res.status(405).json({ ok: false, error: "方法不支持" });
  } catch (e) {
    console.error("[decision-rules]", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
