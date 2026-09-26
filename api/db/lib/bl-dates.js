// api/db/lib/bl-dates.js — 提单日登记（Damon 0926「提单日让录提单流程自动带上」）
// 提单日 = B/L 上的装船日（Shipped on Board Date；没有就用签发日 Date of Issue），是应收尾款到期日的起算点
// （新条款：70% 尾款提单日后 45 天；信保按「应付款日后 30 天」判已知风险）。
// 以前系统里只有计划 ETD / 实际 ATD，没有提单日 —— 录提单时把它记进 bl_dates，按提单号一条。
// 来源优先级：manual（人工改）> skill（录提单 skill）> ocr（提单识别接口）。⛔ 低优先级不覆盖高优先级。

const RANK = { ocr: 1, skill: 2, manual: 3 };

export function normalizeBlDate(v) {
  const s = String(v || "").trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) return null;                         // 2026-02-30 这种
  const now = Date.now(), t = d.getTime();
  if (t < now - 3 * 365 * 864e5 || t > now + 60 * 864e5) return null;     // 识别出离谱年份就不要
  return d.toISOString().slice(0, 10);
}

// 返回 { ok, written, reason }；⛔ 失败只返回原因，不抛——录提单主流程不能因为这一步挂掉
export async function recordBlDate(pool, { bl_no, bl_date, source = "ocr", note = null, by = null }) {
  const bl = String(bl_no || "").trim().toUpperCase().replace(/\s+/g, "");
  const d = normalizeBlDate(bl_date);
  if (!/^[A-Z0-9-]{6,30}$/.test(bl)) return { ok: false, written: false, reason: "bad_bl_no" };
  if (!d) return { ok: false, written: false, reason: "bad_bl_date" };
  if (!RANK[source]) return { ok: false, written: false, reason: "bad_source" };
  try {
    const r = await pool.query(
      `INSERT INTO bl_dates (bl_no, bl_date, source, note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (bl_no) DO UPDATE SET bl_date=EXCLUDED.bl_date, source=EXCLUDED.source, note=EXCLUDED.note,
              updated_by=EXCLUDED.updated_by, updated_at=NOW(),
              history = bl_dates.history || jsonb_build_array(jsonb_build_object(
                'bl_date', bl_dates.bl_date, 'source', bl_dates.source, 'at', bl_dates.updated_at))
        WHERE (CASE bl_dates.source WHEN 'manual' THEN 3 WHEN 'skill' THEN 2 ELSE 1 END) <= $6
          AND bl_dates.bl_date IS DISTINCT FROM EXCLUDED.bl_date
       RETURNING bl_no`,
      [bl, d, source, note, by, RANK[source]]);
    return { ok: true, written: r.rowCount > 0, reason: r.rowCount ? null : "kept_existing" };
  } catch (e) {
    console.error("[bl-dates] record failed:", e.message);
    return { ok: false, written: false, reason: e.message };
  }
}
