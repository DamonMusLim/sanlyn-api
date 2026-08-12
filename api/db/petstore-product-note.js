// 老板批注 + 采纳建议改价(闭环入口)
//   action=note   → 只记思路,进 petstore_product_notes
//   action=price  → 落一条待执行改价指令,进 petstore_price_intents(status=pending)
//                   由 Studio 的 run_pricing.py intents 执行,回写 status/result/applied_at
// 「点开有详情…以及建议,我可以补充」「要能闭环」(Damon 2026-08-12)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const DDL = `
CREATE TABLE IF NOT EXISTS petstore_product_notes (
  id BIGSERIAL PRIMARY KEY, product_code TEXT NOT NULL, note TEXT NOT NULL,
  author TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS ix_ppn_code ON petstore_product_notes(product_code, created_at DESC);
CREATE TABLE IF NOT EXISTS petstore_price_intents (
  id BIGSERIAL PRIMARY KEY, product_code TEXT NOT NULL, product_name TEXT,
  channel TEXT NOT NULL DEFAULT '门店', old_price NUMERIC, target_price NUMERIC NOT NULL,
  reason TEXT, author TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending / applied / failed / cancelled
  result TEXT, created_at TIMESTAMPTZ DEFAULT now(), applied_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS ix_ppi_pending ON petstore_price_intents(status, created_at);
CREATE INDEX IF NOT EXISTS ix_ppi_code ON petstore_price_intents(product_code, created_at DESC);
CREATE TABLE IF NOT EXISTS petstore_price_lock (
  product_code TEXT PRIMARY KEY, product_name TEXT, locked BOOLEAN NOT NULL DEFAULT true,
  reason TEXT, locked_by TEXT, locked_at TIMESTAMPTZ DEFAULT now());`;

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST required" });
  if (!requireAuth(req, res)) return;
  const b = req.body || {};
  const code = String(b.product_code || "").trim();
  if (!code) return res.status(400).json({ success: false, error: "product_code 必填" });
  const author = req.user?.username || req.user?.name || "damon";
  try {
    const pool = getPool();
    await pool.query(DDL);
    // 🔒 锁价:这个品不再被任何自动调价碰(Damon 0812「不监控产品多一个设置,流量品就稳定了」)
    if (["lock", "unlock"].includes(String(b.action || ""))) {
      const locked = b.action === "lock";
      const r = await pool.query(
        `INSERT INTO petstore_price_lock (product_code, product_name, locked, reason, locked_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (product_code) DO UPDATE SET locked=EXCLUDED.locked, reason=EXCLUDED.reason,
           locked_by=EXCLUDED.locked_by, locked_at=now(), product_name=COALESCE(EXCLUDED.product_name, petstore_price_lock.product_name)
         RETURNING *`,
        [code, b.product_name || null, locked, String(b.reason || "").trim() || (locked ? "老板锁价" : "解锁"), author]);
      return res.status(200).json({ success: true, kind: "lock", data: r.rows[0] });
    }
    if (String(b.action || "note") === "price") {
      const target = Number(b.target_price);
      if (!Number.isFinite(target) || target <= 0)
        return res.status(400).json({ success: false, error: "target_price 必须是正数" });
      // origin=system(Cora等自动管线) → proposed,必须走 店长审→Claude终审
      // origin=boss / 缺省(老板在详情页点的) → pending 直通,他自己就是终审
      const origin = String(b.origin || "boss");
      const initStatus = origin === "system" ? "proposed" : "pending";
      const r = await pool.query(
        `INSERT INTO petstore_price_intents (product_code, product_name, channel, old_price, target_price, reason, author, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [code, b.product_name || null, b.channel || "门店", b.old_price ?? null, target,
         String(b.reason || "").trim() || "老板在详情页采纳", author, initStatus]);
      if (String(b.note || "").trim())
        await pool.query(`INSERT INTO petstore_product_notes (product_code, note, author) VALUES ($1,$2,$3)`,
          [code, b.note.trim(), author]);
      return res.status(200).json({ success: true, kind: "intent", data: r.rows[0] });
    }
    const note = String(b.note || "").trim();
    if (!note) return res.status(400).json({ success: false, error: "note 必填" });
    const r = await pool.query(
      `INSERT INTO petstore_product_notes (product_code, note, author) VALUES ($1,$2,$3)
       RETURNING id, note, author, created_at`, [code, note, author]);
    res.status(200).json({ success: true, kind: "note", data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
