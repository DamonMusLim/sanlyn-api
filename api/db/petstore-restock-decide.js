import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 补货审核【写接口】—— 这是继 petstore-perm-save 之后第二个允许写库的接口。
//
// ⛔ 它只能改 petstore_restock_intents 一张表,只能改审核相关的那几列。
// ⛔ 它【不调果冻橙】,不下真实采购单 —— 批准只是记录 Damon 的决定,
//    真正下单是另一步(要先录写接口参数、先在测试品验、必须回读)。
// 🩸 记忆教训:拍板卡「点了不落地」。所以这里每一次写都必须带 decided_by,
//    数据库 CHECK 也会拦(ck_ri_decided)。写完立刻回读,把库里的真实状态返回去,
//    ⛔ 不返回"我以为写成了什么"。
const ACTIONS = Object.assign(Object.create(null), { approve: 1, reject: 1, expire: 1 });

function json(res, s, d) { return res.status(s).json(d); }
function cleanText(v, m = 500) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function decide(req, who) {
  const b = req.body || {};
  const action = cleanText(b.action, 20);
  if (!action || !Object.hasOwn(ACTIONS, action)) return { code: 400, body: { ok: false, error: "bad_action" } };

  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return { code: 400, body: { ok: false, error: "no_ids" } };
  if (ids.length > 200) return { code: 400, body: { ok: false, error: "too_many_ids" } };

  const note = cleanText(b.note, 500);
  const qty = num(b.qty);
  // 按箱采购:前端传箱数,后端算实际件数(箱数 × 每箱数量)。
  // ⛔ 不让前端自己算件数 —— 算错了库里就是错的(数据库 CHECK 也会拦)。
  const cases = num(b.cases);
  const unit = cleanText(b.buy_unit, 10) === "case" ? "case" : null;

  if (action === "reject" && !note) return { code: 400, body: { ok: false, error: "reject_needs_note" } };

  const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "expired";
  const pool = getPool();

  // 批准时:没显式给量就用建议量(COALESCE),保证 decided_qty 一定有值
  const sql = `
    UPDATE public.petstore_restock_intents
       SET status       = $1,
           decided_by   = $2,
           decided_at   = now(),
           decided_note = $3,
           buy_unit     = CASE WHEN $1 = 'approved' AND $6::text = 'case' AND case_qty > 1
                               THEN 'case' ELSE buy_unit END,
           decided_cases = CASE WHEN $1 = 'approved' AND $6::text = 'case' AND case_qty > 1
                                THEN COALESCE($7::numeric, CEIL(GREATEST(suggest_qty, COALESCE(min_order,0)) / case_qty))
                                ELSE decided_cases END,
           decided_qty  = CASE
                            WHEN $1 <> 'approved' THEN decided_qty
                            -- 按箱:件数 = 箱数 × 每箱,后端算
                            WHEN $6::text = 'case' AND case_qty > 1
                              THEN COALESCE($7::numeric, CEIL(GREATEST(suggest_qty, COALESCE(min_order,0)) / case_qty)) * case_qty
                            ELSE COALESCE($4::numeric, suggest_qty)
                          END
     WHERE id = ANY($5::bigint[])
       AND status = 'proposed'          -- ⛔ 只动待审的,已决定的不许被覆盖
     RETURNING id, product_code, product_name, status, decided_by, decided_at, decided_qty, decided_cases, buy_unit, decided_note`;

  const r = await pool.query(sql, [status, who, note, qty, ids, unit, cases]);

  // 🔴 回读:把这批 id 在库里的真实状态再查一遍,返回真实值而不是"我以为写成了什么"
  const back = await pool.query(
    `SELECT id, status, decided_by, decided_at, decided_qty, decided_cases, buy_unit, case_qty
       FROM public.petstore_restock_intents WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids]);

  const changed = r.rows.length;
  const skipped = ids.length - changed;
  return { code: 200, body: {
    ok: true, action, requested: ids.length, changed, skipped,
    skipped_reason: skipped ? "这些不是待审状态(可能已被决定过)" : null,
    rows: r.rows,
    readback: back.rows,          // ⛔ 判据看这个,不看 changed
  } };
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });
    // 谁在拍板:从鉴权信息取,⛔ 不许前端自己传 decided_by
    const who = req.user?.username || req.user?.name || "unknown";
    if (!who || who === "unknown") return json(res, 401, { ok: false, error: "no_identity" });
    const out = await decide(req, who);
    return json(res, out.code, out.body);
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
