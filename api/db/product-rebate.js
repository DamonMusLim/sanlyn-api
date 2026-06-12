// api/db/product-rebate.js
// 退税率 / 增值税率 reference + 批量补全端点（收敛 weight-volume-verify skill 里的裸 SQL）
//
//   GET  /api/db/product-rebate?hs_code=X
//        → 按 HS 返回 products 表的 canonical(MODE) rebate_rate + vat_rate，及业务规则期望值/是否一致。只读，内部角色。
//   POST /api/db/product-rebate   { mode: "preview" | "commit", confirm?: true }
//        → 批量补退税率（只填 NULL，绝不覆盖已有值）。写 products 主数据 = 高风险，ADMIN ONLY。
//          mode 缺省 = "preview"（dry-run，返回 HS→退税率对照表 + 边界 HS，给 Damon 核对）。
//          mode = "commit" 必须同时带 confirm:true 才真正写库。
//
// 🔴 HS 业务规则（Damon 已确认，绝不准改 — 见记忆 product_data_fill_rules）：
//      宠物食品/饲料 2309* → 退税率 0.09、增值税率 0
//      其余工业制成品   → 退税率 0.13、增值税率 0.13
//    边界 HS（尿裤 9619 / 毛皮 4303）默认按制成品 0.13，但 preview 单独标 is_boundary 给 Damon 眼校。
//
// 范围说明：本端点的 POST 只批量补 **rebate_rate**（与原裸 SQL 行为一致）；
//          vat_rate 的批量补全有意 OUT OF SCOPE（食品 vat=0 这类边界更敏感，单独走）。

import { getPool, setCors } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { writeAudit } from "./audit-helper.js";

// 内部可读角色（客户/工厂/portal/external 不可读退税率参考）
const READ_ROLES = ["admin", "logistics", "finance", "operator", "trader", "sales"];
// 写产品主数据：仅 admin
const WRITE_ROLES = ["admin"];
// 敏感边界 HS 前缀（preview 中单独高亮，需人工核对）
const BOUNDARY_PREFIXES = ["9619", "4303"];

function isFoodHs(hs) {
  return typeof hs === "string" && hs.startsWith("2309");
}
function isBoundaryHs(hs) {
  return typeof hs === "string" && BOUNDARY_PREFIXES.some((p) => hs.startsWith(p));
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ─────────────────────────────────────────────────────────────
  // GET — 按 HS 读 canonical 退税率/增值税率
  // ─────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    if (!requireRole(req, res, READ_ROLES)) return;
    try {
      const pool = getPool();
      const hs_code = (req.query.hs_code || "").trim();
      if (!hs_code) return res.status(400).json({ error: "hs_code required" });

      const { rows } = await pool.query(
        `SELECT
           MODE() WITHIN GROUP (ORDER BY rebate_rate) AS rebate_mode,
           MODE() WITHIN GROUP (ORDER BY vat_rate)    AS vat_mode,
           COUNT(*) FILTER (WHERE rebate_rate IS NOT NULL) AS rebate_n,
           COUNT(*) FILTER (WHERE vat_rate    IS NOT NULL) AS vat_n,
           ARRAY_AGG(DISTINCT rebate_rate) FILTER (WHERE rebate_rate IS NOT NULL) AS rebate_distinct,
           ARRAY_AGG(DISTINCT vat_rate)    FILTER (WHERE vat_rate    IS NOT NULL) AS vat_distinct
         FROM products
         WHERE hs_code = $1 AND active = true`,
        [hs_code]
      );
      const r = rows[0] || {};

      const isFood = isFoodHs(hs_code);
      const expected_rebate = isFood ? 0.09 : 0.13;
      const expected_vat = isFood ? 0 : 0.13;

      const rebate_mode = r.rebate_mode == null ? null : Number(r.rebate_mode);
      const vat_mode = r.vat_mode == null ? null : Number(r.vat_mode);
      const match = rebate_mode == null ? null : rebate_mode === expected_rebate;

      return res.status(200).json({
        hs_code,
        rebate: {
          canonical: rebate_mode,
          mode: rebate_mode,
          distinct: (r.rebate_distinct || []).map(Number),
          sample_count: Number(r.rebate_n || 0),
        },
        vat: {
          canonical: vat_mode,
          mode: vat_mode,
          distinct: (r.vat_distinct || []).map(Number),
          sample_count: Number(r.vat_n || 0),
        },
        hs_rule: {
          category: isFood ? "pet_food_feed_2309" : "manufactured_other",
          expected_rebate,
          expected_vat,
        },
        match,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // POST — 批量补 rebate_rate（高风险，ADMIN ONLY，只填 NULL）
  // ─────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    if (!requireRole(req, res, WRITE_ROLES)) return;

    const body = req.body || {};
    const mode = body.mode || "preview";
    if (mode !== "preview" && mode !== "commit") {
      return res.status(400).json({ error: "mode must be 'preview' or 'commit'" });
    }

    const pool = getPool();

    // 共用 WHERE：只补 NULL、active、有 hs_code 的行，绝不覆盖已有值
    const WHERE =
      "rebate_rate IS NULL AND active = true AND hs_code IS NOT NULL AND hs_code <> ''";
    const FILL = "CASE WHEN hs_code LIKE '2309%' THEN 0.09 ELSE 0.13 END";

    // ── PREVIEW（dry-run，不写）──
    if (mode === "preview") {
      try {
        const { rows } = await pool.query(
          `SELECT hs_code,
                  COUNT(*)            AS null_count,
                  ${FILL}             AS new_rebate
           FROM products
           WHERE ${WHERE}
           GROUP BY hs_code
           ORDER BY hs_code`
        );
        const groups = rows.map((row) => ({
          hs_code: row.hs_code,
          null_count: Number(row.null_count),
          new_rebate: Number(row.new_rebate),
          is_food: isFoodHs(row.hs_code),
          is_boundary: isBoundaryHs(row.hs_code),
        }));
        const total_affected = groups.reduce((s, g) => s + g.null_count, 0);
        return res.status(200).json({
          mode: "preview",
          committed: false,
          total_affected,
          groups,
          boundary_hs: groups.filter((g) => g.is_boundary),
          note: "Preview only — no rows written. Send {mode:'commit', confirm:true} to apply. Boundary HS (9619/4303) need manual confirmation.",
        });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── COMMIT（真正写库）──
    if (body.confirm !== true) {
      return res.status(400).json({ error: "commit requires confirm:true" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE products
         SET rebate_rate = ${FILL},
             updated_at = NOW()
         WHERE ${WHERE}
         RETURNING sku, hs_code, rebate_rate`
      );
      await client.query("COMMIT");

      // 按 (hs_code,new rebate) 汇总
      const byHs = {};
      for (const row of rows) {
        const k = row.hs_code;
        if (!byHs[k]) byHs[k] = { hs_code: k, count: 0, new_rebate: Number(row.rebate_rate) };
        byHs[k].count += 1;
      }
      const groups = Object.values(byHs).sort((a, b) =>
        a.hs_code < b.hs_code ? -1 : a.hs_code > b.hs_code ? 1 : 0
      );

      // 审计（best-effort，不因审计失败而失败请求）
      try {
        await writeAudit(pool, req, {
          action: "product.rebate_batch_fill",
          entity_type: "products",
          entity_id: null,
          before: { rebate_rate: null },
          after: { updated_count: rows.length },
          note: "Batch-filled rebate_rate by HS rule (2309*=0.09 else 0.13); only NULLs on active products.",
          detail: { groups },
        });
      } catch (e) {
        console.error("[product-rebate] audit write failed:", e.message);
      }

      return res.status(200).json({
        mode: "commit",
        committed: true,
        updated_count: rows.length,
        groups,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
