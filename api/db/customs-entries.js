// api/db/customs-entries.js — 报关单编号读写 (2026-08-12)
//
// 为什么：报关行回传报关单/放行通知书后，报关单编号要落库，FE 才做得了。
// 之前只能手工 psql 写 —— 邮件自动入库那条链没有落点。
//
// 🔒 幂等：entry_id 唯一。重复推同一份不会重复建行，只更新状态。
// 🔒 绝不造数：blNo 匹配不到票就返回 404 并说清，不新建票、不猜。
// 🔒 一票可按柜拆多份报关单 → container_no 区分，不是覆盖。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const S = v => (v == null ? "" : String(v).trim());
const D = v => { const s = S(v); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!["admin", "finance", "logistics"].includes(req.user?.role)) {
    return res.status(403).json({ error: "无权限" });
  }
  const pool = getPool();

  try {
    if (req.method === "GET") {
      const bl = S(req.query.bl), planId = S(req.query.plan_id);
      const where = [], vals = [];
      if (bl) { vals.push(bl); where.push(`ce.bl_no = $${vals.length}`); }
      if (planId) { vals.push(Number(planId)); where.push(`ce.shipping_plan_id = $${vals.length}`); }
      const r = await pool.query(
        `SELECT ce.*, sp.shipment_no FROM customs_entries ce
           LEFT JOIN shipping_plans sp ON sp.id = ce.shipping_plan_id
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY ce.id DESC LIMIT 100`, vals);
      return res.json({ ok: true, rows: r.rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const entryId = S(b.entry_id), blNo = S(b.bl_no);
      if (!entryId) return res.status(400).json({ ok: false, error: "entry_id 必填" });
      if (!/^\d{18}$/.test(entryId)) {
        return res.status(400).json({ ok: false, error: `报关单编号应为18位数字，收到「${entryId}」` });
      }
      if (!blNo) return res.status(400).json({ ok: false, error: "bl_no 必填" });

      // 匹配票 —— 匹配不到就明说，绝不新建
      const plan = (await pool.query(
        `SELECT id, shipment_no FROM shipping_plans
          WHERE bl_no=$1 OR raw->>'blNo'=$1 LIMIT 1`, [blNo])).rows[0];
      if (!plan) {
        return res.status(404).json({ ok: false, error: `提单号 ${blNo} 在系统里找不到对应的票`,
          hint: "不自动建票。确认提单号是否正确，或先把这票录进 shipping_plans。" });
      }
      const orders = (await pool.query(
        `SELECT order_no FROM orders WHERE shipping_plan_id=$1 ORDER BY order_no`, [plan.id])).rows.map(x => x.order_no);

      const r = await pool.query(
        `INSERT INTO customs_entries
           (shipping_plan_id, bl_no, entry_id, container_no, order_nos, status,
            declared_at, released_at, broker, doc_url, note)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,'declared'),$7,$8,$9,$10,$11)
         ON CONFLICT (entry_id) DO UPDATE SET
           status      = COALESCE(EXCLUDED.status, customs_entries.status),
           released_at = COALESCE(EXCLUDED.released_at, customs_entries.released_at),
           declared_at = COALESCE(EXCLUDED.declared_at, customs_entries.declared_at),
           broker      = COALESCE(EXCLUDED.broker, customs_entries.broker),
           doc_url     = COALESCE(EXCLUDED.doc_url, customs_entries.doc_url),
           note        = COALESCE(EXCLUDED.note, customs_entries.note),
           updated_at  = now()
         RETURNING id, entry_id, bl_no, status, released_at,
                   (xmax = 0) AS 新建`,
        [plan.id, blNo, entryId, S(b.container_no) || null, orders,
         S(b.status) || null, D(b.declared_at), D(b.released_at),
         S(b.broker) || null, S(b.doc_url) || null, S(b.note) || null]);

      const row = r.rows[0];
      return res.json({ ok: true, 动作: row.新建 ? "新建" : "更新已有", shipment_no: plan.shipment_no,
        订单: orders, ...row });
    }

    if (req.method === "PATCH") {
      const b = req.body || {};
      const id = Number(b.id), entryId = S(b.entry_id);
      if (!id && !entryId) return res.status(400).json({ ok: false, error: "id 或 entry_id 必填" });
      const sets = [], vals = [];
      for (const [k, v] of [["status", S(b.status)], ["released_at", D(b.released_at)],
                            ["doc_url", S(b.doc_url)], ["note", S(b.note)]]) {
        if (v) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
      }
      if (!sets.length) return res.status(400).json({ ok: false, error: "没有要改的字段" });
      vals.push(id || entryId);
      const r = await pool.query(
        `UPDATE customs_entries SET ${sets.join(", ")}, updated_at=now()
          WHERE ${id ? "id" : "entry_id"} = $${vals.length} RETURNING *`, vals);
      return r.rows[0] ? res.json({ ok: true, ...r.rows[0] })
                       : res.status(404).json({ ok: false, error: "没这条" });
    }

    return res.status(405).json({ ok: false, error: "方法不支持" });
  } catch (e) {
    console.error("[customs-entries]", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
