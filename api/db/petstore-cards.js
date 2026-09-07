// P1 次卡/会员卡。⚠️ 属 membership_card 模块。
// 🔴 会计口径:卖卡收的钱是【预收负债】不是收入,核销一次确认一次。
//    汇总里的 liability = 未核销次数 × 每次单价 = 我们还欠客户多少钱。
//    ⛔ 别把 paid_amount 当营业额报给老板 —— 那是虚增。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const clean = (v, m = 80) => { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; };

async function gateOf(pool, storeCode) {
  const { rows } = await pool.query(
    `SELECT status::text FROM tenant_module_entitlements
      WHERE store_code=$1 AND module_code='membership_card'`, [storeCode]);
  const st = rows[0]?.status || "disabled";
  return { visible: st !== "disabled", writable: st === "enabled" };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (!requireAuth(req, res)) return;

  const storeCode = clean(req.query?.storeCode, 32) || "63350001";
  const pool = getPool();
  try {
    const gate = await gateOf(pool, storeCode);
    if (!gate.visible) return res.status(403).json({ error: "module_disabled", module: "membership_card" });

    const page = Math.max(1, parseInt(req.query?.page || "1", 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(req.query?.pageSize || 20, 10) || 20));
    const kw = clean(req.query?.q, 40);
    const st = clean(req.query?.status, 16);

    const args = [storeCode];
    let where = "c.store_code = $1";
    if (kw) { args.push("%" + kw + "%"); where += ` AND (c.owner_name ILIKE $${args.length} OR c.owner_phone ILIKE $${args.length} OR c.card_no ILIKE $${args.length})`; }
    if (st === "active")   where += " AND c.status='active' AND c.remaining_times > 0";
    if (st === "used_up")  where += " AND c.remaining_times <= 0";
    if (st === "expiring") where += " AND c.expires_at BETWEEN CURRENT_DATE AND CURRENT_DATE+30 AND c.remaining_times > 0";
    if (st === "expired")  where += " AND c.expires_at < CURRENT_DATE AND c.remaining_times > 0";

    const total = (await pool.query(
      `SELECT count(*)::int n FROM member_cards c WHERE ${where}`, args)).rows[0].n;

    args.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT c.id, c.card_no, c.owner_name, c.owner_phone, c.total_times, c.used_times,
              c.remaining_times, c.paid_amount, c.sold_at, c.expires_at, c.status, c.sold_by,
              t.name AS template_name, t.service_name, t.card_type,
              p.name AS pet_name, p.avatar_url, p.breed,
              CASE WHEN c.expires_at IS NULL THEN NULL ELSE (c.expires_at - CURRENT_DATE) END AS days_left,
              CASE
                WHEN c.remaining_times <= 0 THEN '已用完'
                WHEN c.expires_at IS NOT NULL AND c.expires_at < CURRENT_DATE THEN '已过期'
                WHEN c.expires_at IS NOT NULL AND c.expires_at <= CURRENT_DATE+30 THEN '即将过期'
                ELSE '正常'
              END AS card_state,
              -- 单次成本(确认收入用):售价 ÷ 总次数
              CASE WHEN COALESCE(c.total_times,0) > 0
                   THEN ROUND(c.paid_amount / c.total_times, 2) ELSE NULL END AS per_use
         FROM member_cards c
         LEFT JOIN card_templates t ON t.id = c.template_id
         LEFT JOIN pet_profiles  p ON p.id = c.pet_id
        WHERE ${where}
        ORDER BY (c.expires_at IS NULL), c.expires_at ASC, c.id DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`, args);

    // 🔴 负债汇总。有效期内和已过期【分开算】——
    //    过期卡还剩的次数,法律上还欠不欠客户是【经营决策】不是技术问题
    //    (中国预付卡规定,过期余额通常不能直接没收)。
    //    ⛔ 不许把两者合成一个数报给老板 —— 那样他看不见这笔潜在纠纷。
    const sum = (await pool.query(
      `SELECT count(*)::int cards,
              COALESCE(SUM(remaining_times),0)::int remaining_times,
              COALESCE(SUM(CASE WHEN COALESCE(total_times,0)>0
                     AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
                   THEN remaining_times * (paid_amount/total_times) ELSE 0 END),0)::numeric(14,2) liability_active,
              COALESCE(SUM(CASE WHEN COALESCE(total_times,0)>0
                     AND expires_at IS NOT NULL AND expires_at < CURRENT_DATE
                   THEN remaining_times * (paid_amount/total_times) ELSE 0 END),0)::numeric(14,2) liability_expired,
              count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < CURRENT_DATE
                                 AND remaining_times > 0)::int expired_with_balance
         FROM member_cards WHERE store_code=$1 AND status='active'`, [storeCode])).rows[0];

    return res.status(200).json({ rows, total, page, pageSize: size, summary: sum, writable: gate.writable });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
