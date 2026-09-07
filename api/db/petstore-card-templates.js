// 会员卡模板主数据。只读列表,字段以已迁移表为准;敏感键在 JSON 层剔除。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireVisible } from "../moduleGate.js";

const clean = (v, m = 80) => { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; };
const PRIVATE_KEYS = [
  "cost_price", "in_price", "gross_margin", "gross_profit",
  "wholesale_price", "supplier_price", "purchase_price",
  "supplier_bank_account", "bank_account", "bank_account_no", "account_no"
];

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (!requireAuth(req, res)) return;
  const storeCode = clean(req.query?.storeCode, 32) || "63350001";
  if (!(await requireVisible(req, res, "membership_card", storeCode))) return;
  const pageSize = Math.min(Math.max(parseInt(req.query?.pageSize, 10) || 20, 1), 200);
  const page = Math.max(parseInt(req.query?.pageNumber ?? req.query?.page, 10) || 1, 1);
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `WITH grouped AS (
         SELECT t.*, count(mc.id)::int AS opened_user_count
           FROM card_templates t
           LEFT JOIN member_cards mc ON mc.template_id = t.id
          WHERE t.store_code = $1
          GROUP BY t.id
       )
       SELECT count(*) OVER() AS __total, to_jsonb(grouped) - $4::text[] AS row
         FROM grouped
        ORDER BY id DESC
        LIMIT $2 OFFSET $3`,
      [storeCode, pageSize, (page - 1) * pageSize, PRIVATE_KEYS]);
    const total = rows.length ? Number(rows[0].__total || rows.length) : 0;
    return res.status(200).json({ rows: rows.map((r) => r.row), total, page, pageSize });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
