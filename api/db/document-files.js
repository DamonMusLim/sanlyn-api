// document-files.js
// 单证文件清单 — 读 document_files (1845 行 SSOT)，按订单/合同号解析该票所有单证。
//
// GET /api/db/document-files?q=48-CL-1            (order_no 或 contract_no)
// GET /api/db/document-files?order_no=48-CL-1
// GET /api/db/document-files?contract_no=48-CL-1
//
// 绑定关系: document_files.bound_subject_type ∈ {order, shipping_plan}
//   - order        → bound_subject_id = orders.id / orders._id
//   - shipping_plan → bound_subject_id = orders.shipping_plan_id / orders.plan_id
//
// Returns: { ok:true, success:true, count, data:[{ doc_kind, bound_subject_type, version,
//            is_signed, display_name, uploaded_at, mime_type }] }
//
// 只读。供 table-check-engine 缺单证检测 + 单证状态面板复用。 (2026-06-16)

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // 与 orders.js 一致：handler 级 JWT 守卫(双保险)

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!requireAuth(req, res)) return; // 401 if no valid JWT

  const ref = String(req.query.q || req.query.order_no || req.query.contract_no || "").trim();
  if (!ref) return res.status(400).json({ ok: false, error: "q (order_no/contract_no) is required" });

  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const pool = getPool();

  try {
    const { rows: orders } = await pool.query(
      `SELECT id::text AS id, _id::text AS _id,
              shipping_plan_id::text AS spid, plan_id::text AS pid
         FROM orders
        WHERE order_no = $1 OR contract_no = $1
        LIMIT 5`,
      [ref]
    );
    if (!orders.length) return res.json({ ok: true, success: true, count: 0, data: [], note: "order not found" });

    const orderIds = [], planIds = [];
    for (const o of orders) {
      for (const x of [o.id, o._id]) if (x) orderIds.push(x);
      for (const x of [o.spid, o.pid]) if (x) planIds.push(x);
    }

    const { rows } = await pool.query(
      `SELECT doc_kind, bound_subject_type, version, is_signed,
              display_name, uploaded_at, mime_type
         FROM document_files
        WHERE deleted_at IS NULL
          AND ( (bound_subject_type = 'order'         AND bound_subject_id::text = ANY($1))
             OR (bound_subject_type = 'shipping_plan' AND bound_subject_id::text = ANY($2)) )
        ORDER BY doc_kind, uploaded_at DESC
        LIMIT $3`,
      [orderIds.length ? orderIds : [''], planIds.length ? planIds : [''], limit]
    );

    return res.json({ ok: true, success: true, count: rows.length, data: rows });
  } catch (e) {
    console.error("[document-files] error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
