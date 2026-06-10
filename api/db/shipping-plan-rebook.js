// /api/db/shipping-plan-rebook.js — 换航次（rebook）原子操作
//
// 业务场景：已订舱的航次没赶上（未下舱单/甩柜/主动取消）→ 改订新航次。
// 旧航次必须留痕，不能直接覆盖主表字段。
//
// POST /api/db/shipping-plan-rebook
//   body: {
//     id,                              // shipping_plans.id (integer)
//     reason,                          // 必填：为什么换（如"未下舱单未赶上"）
//     status,                          // 旧航次结局: missed(没赶上)|cancelled(主动取消)|rolled(船司甩柜) 默认 missed
//     new: { carrier?, vessel?, voyage?, etd?, eta? }   // 新航次，至少给一个字段
//   }
// 行为（单条 UPDATE 原子完成）：
//   1. 当前主表 shipping_line/vessel/voyage/etd/eta 追加进 raw.booking_history[]
//      （seq 自增，带 status/reason/replaced_at/replaced_by）
//   2. 主表写入新航次字段（未提供的字段清空——换船后旧 ETD/ETA 不可残留）
//
// GET /api/db/shipping-plan-rebook?id=383 → 该计划的 booking_history + 当前航次
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }

  var pool = getPool();

  if (req.method === "GET") {
    try {
      var id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: "id required" });
      var r = await pool.query(
        "SELECT id, shipment_no, shipping_line, carrier_code, vessel, voyage, etd, eta, COALESCE(raw->'booking_history','[]'::jsonb) AS booking_history FROM shipping_plans WHERE id=$1",
        [id]
      );
      if (!r.rows.length) return res.status(404).json({ error: "Not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    try {
      var b = req.body || {};
      var pid = parseInt(b.id, 10);
      if (!pid) return res.status(400).json({ error: "id required" });
      if (!b.reason || !String(b.reason).trim()) {
        return res.status(400).json({ error: "reason required: 换航次必须写原因（留痕铁律）" });
      }
      var st = String(b.status || "missed").toLowerCase();
      if (["missed", "cancelled", "rolled"].indexOf(st) < 0) {
        return res.status(400).json({ error: "status must be missed|cancelled|rolled" });
      }
      var nv = b.new || {};
      if (!nv.carrier && !nv.vessel && !nv.voyage && !nv.etd && !nv.eta) {
        return res.status(400).json({ error: "new booking required: 至少提供 carrier/vessel/voyage/etd/eta 之一" });
      }

      // 原子 UPDATE：旧航次 push 进 history，新航次写主表
      var r = await pool.query(
        `UPDATE shipping_plans SET
           raw = jsonb_set(
             COALESCE(raw,'{}'::jsonb),
             '{booking_history}',
             COALESCE(raw->'booking_history','[]'::jsonb) || jsonb_build_object(
               'seq',     jsonb_array_length(COALESCE(raw->'booking_history','[]'::jsonb)) + 1,
               'carrier', COALESCE(shipping_line, carrier_code, ''),
               'vessel',  COALESCE(vessel,''),
               'voyage',  COALESCE(voyage,''),
               'etd',     COALESCE(etd::text,''),
               'eta',     COALESCE(eta::text,''),
               'status',  $2::text,
               'reason',  $3::text,
               'replaced_at', to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD'),
               'replaced_by', trim(concat_ws(' ', $4::text, concat_ws('/', NULLIF($5::text,''), NULLIF($6::text,''))))
             )
           ),
           shipping_line = COALESCE($4, shipping_line),
           carrier_code  = COALESCE($4, carrier_code),
           vessel = $5, voyage = $6,
           etd = NULLIF($7,'')::date, eta = NULLIF($8,'')::date,
           updated_at = now()
         WHERE id = $1
         RETURNING id, shipment_no, shipping_line, vessel, voyage, etd, eta,
                   jsonb_array_length(raw->'booking_history') AS history_count`,
        [pid, st, String(b.reason).trim(),
         nv.carrier || null, nv.vessel || null, nv.voyage || null,
         nv.etd || "", nv.eta || ""]
      );
      if (!r.rows.length) return res.status(404).json({ error: "Not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
