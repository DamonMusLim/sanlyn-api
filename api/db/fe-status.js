// api/db/fe-status.js — FE 原产地证 按BL记进度(办到第几步)
// GET  /api/db/fe-status?bl=<BL>           → { level, cert_no, updated_at }
// PATCH /api/db/fe-status { bl, level, cert_no? } → 更新进度
// level: 0未办 / 3暂存完成 / 4已申报 / 5已签发 / 6已打印归档
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

async function ensure(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fe_certs (
      bl_no TEXT PRIMARY KEY,
      level INTEGER DEFAULT 0,
      cert_no TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`).catch(() => {});
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    await ensure(pool);
    if (req.method === "PATCH") {
      const { bl, level, cert_no } = req.body || {};
      if (!bl) return res.status(400).json({ error: "bl 必填" });
      const lv = Math.max(0, Math.min(6, parseInt(level ?? 0, 10) || 0));
      await pool.query(
        `INSERT INTO fe_certs (bl_no, level, cert_no, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (bl_no) DO UPDATE SET level=EXCLUDED.level,
           cert_no=COALESCE(EXCLUDED.cert_no, fe_certs.cert_no), updated_at=now()`,
        [bl, lv, cert_no || null]);
      return res.json({ success: true, bl, level: lv, cert_no: cert_no || null });
    }
    const bl = req.query.bl;
    if (!bl) return res.status(400).json({ error: "bl 必填" });
    const r = await pool.query(`SELECT level, cert_no, updated_at FROM fe_certs WHERE bl_no=$1`, [bl]);
    const row = r.rows[0] || { level: 0, cert_no: null, updated_at: null };
    return res.json({ success: true, bl, ...row });
  } catch (e) {
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
