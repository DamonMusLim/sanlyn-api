// /api/db/qc-notify.js
// QC 审核结果通知 — 发企微 webhook 给 Damon
//
//   POST /api/db/qc-notify
//     body: { qc_id, factory, order_no, result, reason? }
//     -> 200 { ok, wecom }

import { getPool, setCors } from "../db.js";

async function sendWecom(text) {
  var url = process.env.WECOM_WEBHOOK_URL;
  if (!url) return { skipped: true, reason: "no WECOM_WEBHOOK_URL" };
  try {
    var r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    });
    var d = await r.json();
    return d.errcode === 0 ? { ok: true } : { ok: false, errcode: d.errcode, errmsg: d.errmsg };
  } catch (e) {
    console.error("[qc-notify] wecom failed:", e.message);
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    var pool = getPool();
    var { qc_id, factory, order_no, result, reason } = req.body || {};

    // 查 qc_checks 拿详情（可选 — 如果前端传了 qc_id）
    var detail = null;
    if (qc_id) {
      var r = await pool.query("SELECT * FROM qc_checks WHERE id = $1", [parseInt(qc_id)]);
      detail = r.rows[0] || null;
    }

    var displayOrderNo  = order_no  || detail?.order_contract_no || "N/A";
    var displayFactory  = factory   || detail?.factory_code      || "N/A";
    var displayResult   = result    || detail?.qc_result         || "N/A";
    var displayPass     = displayResult === "pass" || displayResult === "approved";
    var resultLabel     = displayPass ? "通过 ✅" : "拒绝 ❌";

    var lines = [
      "🔬 QC 审核通知",
      "订单：" + displayOrderNo,
      "工厂：" + displayFactory,
      "结果：" + resultLabel,
    ];
    if (reason) lines.push("原因：" + reason);
    if (qc_id) lines.push("QC ID：#" + qc_id);

    var wecomResult = await sendWecom(lines.join("\n"));

    return res.status(200).json({ ok: true, wecom: wecomResult });
  } catch (err) {
    console.error("[qc-notify] error:", err);
    return res.status(500).json({ error: err.message });
  }
}
