import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 对账对平状态: 只留痕, 绝不改金额表
const STATUSES = ["未核", "待补资料", "已对平", "需人工确认"];

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    if (req.method === "GET") {
      const ledger = String(req.query.ledger || "");
      if (!["product", "freight"].includes(ledger)) return res.status(400).json({ success: false, error: "ledger required" });
      const r = await pool.query("SELECT ticket_key, status, note, confirmed_by, confirmed_at FROM recon_confirmations WHERE ledger=$1", [ledger]);
      const map = {};
      r.rows.forEach(x => { map[x.ticket_key] = x.status; });
      return res.status(200).json({ success: true, data: map, rows: r.rows });
    }
    if (req.method === "PATCH") {
      const { ticket_key, ledger, status, note } = req.body || {};
      if (!ticket_key || !["product", "freight"].includes(ledger) || !STATUSES.includes(status))
        return res.status(400).json({ success: false, error: "ticket_key/ledger/status invalid" });
      const by = (req.user && (req.user.username || req.user.name)) || "unknown";
      await pool.query(
        `INSERT INTO recon_confirmations(ticket_key, ledger, status, note, confirmed_by, confirmed_at)
         VALUES($1,$2,$3,$4,$5,now())
         ON CONFLICT (ticket_key, ledger)
         DO UPDATE SET status=EXCLUDED.status, note=EXCLUDED.note, confirmed_by=EXCLUDED.confirmed_by, confirmed_at=now()`,
        [String(ticket_key), ledger, status, note || null, by]);
      return res.status(200).json({ success: true });
    }
    res.status(405).json({ success: false, error: "GET/PATCH only" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
