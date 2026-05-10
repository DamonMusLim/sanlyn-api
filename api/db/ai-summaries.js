// ai-summaries.js — AI 周期总结 CRUD + 月报触发
//
// GET  ?action=list&summary_type=monthly     列表
// GET  ?action=detail&id=N                    单条
// GET  ?action=latest&summary_type=monthly    最新一份（按 period_end）
// POST ?action=trigger_monthly                手工触发月报生成
// POST                                        创建（手工/AI 写入）
//
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  const action = req.query?.action;

  try {
    // ─── GET list ────────────────────────────────────────
    if (req.method === "GET" && action === "list") {
      const stype  = req.query.summary_type;
      const scope  = req.query.scope;
      const scopeId= req.query.scope_id;
      const limit  = Math.min(parseInt(req.query.limit) || 50, 200);

      const conds = ["archived_at IS NULL"];
      const params = [];
      if (stype)   { params.push(stype);   conds.push("summary_type = $" + params.length); }
      if (scope)   { params.push(scope);   conds.push("scope = $" + params.length); }
      if (scopeId) { params.push(scopeId); conds.push("scope_id = $" + params.length); }

      params.push(limit);
      const sql = `
        SELECT id, scope, scope_id, scope_label, period_start, period_end,
               summary_type, metrics, highlights, recommendations,
               diff_vs_prev, generated_by, read_by, created_at
        FROM ai_summaries
        WHERE ${conds.join(" AND ")}
        ORDER BY period_end DESC, created_at DESC
        LIMIT $${params.length}
      `;
      const r = await pool.query(sql, params);
      return res.status(200).json({ success: true, data: r.rows });
    }

    // ─── GET latest ──────────────────────────────────────
    if (req.method === "GET" && action === "latest") {
      const stype = req.query.summary_type || "monthly";
      const r = await pool.query(`
        SELECT * FROM ai_summaries
        WHERE summary_type = $1 AND archived_at IS NULL
        ORDER BY period_end DESC LIMIT 1
      `, [stype]);
      return res.status(200).json({ success: true, data: r.rows[0] || null });
    }

    // ─── GET detail ──────────────────────────────────────
    if (req.method === "GET" && action === "detail") {
      const id = parseInt(req.query.id);
      if (!id) return res.status(400).json({ error: "id required" });
      const r = await pool.query("SELECT * FROM ai_summaries WHERE id = $1", [id]);
      if (r.rows.length === 0) return res.status(404).json({ error: "not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    // ─── POST trigger_monthly ────────────────────────────
    // 计算上个月的指标 → 写 ai_summaries → 写 notifications → 触发任务
    if (req.method === "POST" && action === "trigger_monthly") {
      const b = req.body || {};
      const periodEnd = b.period_end ? new Date(b.period_end) : new Date();
      // 上月起止
      const start = new Date(periodEnd.getFullYear(), periodEnd.getMonth() - 1, 1);
      const end   = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 0);
      const startISO = start.toISOString().slice(0, 10);
      const endISO   = end.toISOString().slice(0, 10);

      // ─── 计算指标 ────────────────────────────────────
      // 1) 本月 AI 操作数 + 准确率
      const opStats = await pool.query(`
        SELECT
          COUNT(*) AS total_ops,
          COUNT(*) FILTER (WHERE result = 'accepted') AS accepted,
          COUNT(*) FILTER (WHERE result = 'edited')   AS edited,
          COUNT(*) FILTER (WHERE result = 'rejected') AS rejected,
          AVG(confidence) FILTER (WHERE result = 'accepted') AS avg_conf_accepted,
          SUM(cost_tokens) AS total_tokens
        FROM ai_operations
        WHERE created_at >= $1 AND created_at < ($2::DATE + 1)
      `, [startISO, endISO]);

      // 2) 高频改正模式（top 5）
      const topErrors = await pool.query(`
        SELECT doc_type, COUNT(*) AS cnt
        FROM ai_operations
        WHERE result IN ('edited', 'rejected')
          AND created_at >= $1 AND created_at < ($2::DATE + 1)
        GROUP BY doc_type
        ORDER BY cnt DESC
        LIMIT 5
      `, [startISO, endISO]);

      // 3) 订单完成数
      const orderStats = await pool.query(`
        SELECT
          COUNT(*) AS shipped_orders,
          COUNT(DISTINCT company_code) AS active_customers
        FROM orders
        WHERE COALESCE(raw->>'shipDate', actDelivery::TEXT) >= $1
          AND COALESCE(raw->>'shipDate', actDelivery::TEXT) <= $2
      `, [startISO, endISO]).catch(() => ({ rows: [{ shipped_orders: 0, active_customers: 0 }] }));

      const ops = opStats.rows[0];
      const accuracy = ops.total_ops > 0
        ? (parseInt(ops.accepted) / parseInt(ops.total_ops)).toFixed(3)
        : null;

      const metrics = {
        ai: {
          total_ops: parseInt(ops.total_ops || 0),
          accepted:  parseInt(ops.accepted || 0),
          edited:    parseInt(ops.edited || 0),
          rejected:  parseInt(ops.rejected || 0),
          accuracy:  parseFloat(accuracy || 0),
          avg_confidence_accepted: parseFloat(ops.avg_conf_accepted || 0),
          total_tokens: parseInt(ops.total_tokens || 0),
          top_error_doc_types: topErrors.rows,
        },
        orders: {
          shipped:          parseInt(orderStats.rows[0].shipped_orders || 0),
          active_customers: parseInt(orderStats.rows[0].active_customers || 0),
        },
      };

      // ─── AI 写文字总结（临时占位，实际接 LLM 时替换）─────
      const highlights = `${start.getFullYear()} 年 ${start.getMonth() + 1} 月 AI 月报：` +
        `共执行 ${metrics.ai.total_ops} 次 AI 任务，准确率 ${(metrics.ai.accuracy * 100).toFixed(1)}%。` +
        `${metrics.ai.edited > 0 ? `工厂/贸易/报关行修正 ${metrics.ai.edited} 次。` : ''}` +
        `本月发运 ${metrics.orders.shipped} 单，覆盖 ${metrics.orders.active_customers} 位客户。`;

      const recommendations = [];
      if (metrics.ai.accuracy < 0.85 && metrics.ai.total_ops > 10) {
        recommendations.push({
          severity: "warn",
          text: `AI 准确率 ${(metrics.ai.accuracy * 100).toFixed(1)}% 低于 85%，建议查 top_error_doc_types 提取硬规则`,
        });
      }
      if (metrics.ai.top_error_doc_types.length > 0) {
        const top = metrics.ai.top_error_doc_types[0];
        recommendations.push({
          severity: "info",
          text: `${top.doc_type} 被改正 ${top.cnt} 次，可考虑 promoted 成 hard rule`,
        });
      }

      // ─── 写 ai_summaries ─────────────────────────────
      const sumR = await pool.query(`
        INSERT INTO ai_summaries
          (scope, scope_id, scope_label, period_start, period_end,
           summary_type, metrics, highlights, recommendations, generated_by)
        VALUES ('global', 'all', '全局', $1, $2, 'monthly', $3, $4, $5, 'system-cron')
        ON CONFLICT (scope, scope_id, summary_type, period_start, period_end)
        DO UPDATE SET metrics = EXCLUDED.metrics,
                      highlights = EXCLUDED.highlights,
                      recommendations = EXCLUDED.recommendations
        RETURNING *
      `, [startISO, endISO, JSON.stringify(metrics), highlights, JSON.stringify(recommendations)]);

      const summary = sumR.rows[0];

      // ─── 写 notifications ────────────────────────────
      const notifR = await pool.query(`
        INSERT INTO notifications
          (type, level, title, body, payload, scope, scope_id,
           recipient_roles, channels, related_summary)
        VALUES ('ai_summary', 'info', $1, $2, $3, 'global', 'all',
                ARRAY['admin'], ARRAY['inapp','wecom'], $4)
        RETURNING id
      `, [
        `📊 ${start.getMonth() + 1} 月 AI 月报 · 准确率 ${(metrics.ai.accuracy * 100).toFixed(1)}%`,
        highlights,
        JSON.stringify({ metrics, recommendations, summary_id: summary.id }),
        summary.id,
      ]);

      return res.status(200).json({
        success: true,
        summary,
        notification_id: notifR.rows[0].id,
      });
    }

    // ─── POST 创建（手动/AI 写入）─────────────────────────
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.scope || !b.summary_type) {
        return res.status(400).json({ error: "scope and summary_type required" });
      }
      const r = await pool.query(`
        INSERT INTO ai_summaries
          (scope, scope_id, scope_label, period_start, period_end,
           summary_type, metrics, highlights, recommendations,
           diff_vs_prev, generated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `, [
        b.scope, b.scope_id, b.scope_label,
        b.period_start, b.period_end, b.summary_type,
        b.metrics || {}, b.highlights, b.recommendations || [],
        b.diff_vs_prev || null, b.generated_by || "manual",
      ]);
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
