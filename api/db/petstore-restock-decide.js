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
const ACTIONS = Object.assign(Object.create(null), { approve: 1, reject: 1, expire: 1, execute: 1 });

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
  // 进货时【顺手填】的箱规 —— Damon 0831:「不用特意去填,不进货你去填就麻烦了」。
  // 填一次就记进 petstore_product_pack,下次这个品自动带出来。
  const packQty  = num(b.case_qty);
  const packUnit = cleanText(b.pack_unit, 20);
  if (packQty !== null && (!Number.isInteger(packQty) || packQty <= 1 || packQty > 10000)) {
    // codex 审出:numeric 列 + CHECK 都不拦小数,100.5 会算出小数件数
    return { code: 400, body: { ok: false, error: "bad_case_qty", hint: "箱规要是大于1、不超过10000的整数" } };
  }

  if (action === "reject" && !note) return { code: 400, body: { ok: false, error: "reject_needs_note" } };
  // codex 审出:绕开前端直接 POST 多个 id + 一个 case_qty,会把同一个箱规写到一批商品上。
  // 箱规是【一个商品一个】的事实,后端必须自己兜住,不能指望前端只在单选时带。
  if (packQty !== null && ids.length !== 1) {
    return { code: 400, body: { ok: false, error: "case_qty_needs_single", hint: "填箱规一次只能一个商品" } };
  }

  const pool = getPool();

  // execute:已导出并在果冻橙导入完成后,标记这批已执行。
  // 🩸 为什么必须有这一步:导出口只导【已批准且未执行】的。不标记的话,
  //    下次点导出会把同一批再导一遍 —— 那就是重复下单,是花钱的错。
  if (action === "execute") {
    const orderNo = cleanText(b.order_no, 60);
    if (!orderNo) return { code: 400, body: { ok: false, error: "execute_needs_order_no", hint: "要填果冻橙那边的要货单号,不然对不上账" } };
    const r0 = await pool.query(
      // 🩸 库是 SQL_ASCII —— SQL 里【不许出现中文字面量】(拼一个「·」就报
      //    invalid byte sequence for encoding "UTF8")。备注要拼就在 JS 里拼好再当参数传。
      `UPDATE public.petstore_restock_intents
          SET exec_status = 'executed', exec_at = now(), exec_order_no = $1,
              decided_note = COALESCE($2::text, decided_note)
        WHERE id = ANY($3::bigint[])
          AND status = 'approved'
          AND COALESCE(exec_status,'') <> 'executed'
        RETURNING id, product_code, exec_status, exec_at, exec_order_no`,
      [orderNo, note ? note : null, ids]);
    const back0 = await pool.query(
      `SELECT id, status, exec_status, exec_at, exec_order_no, decided_qty
         FROM public.petstore_restock_intents WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids]);
    return { code: 200, body: {
      ok: true, action, requested: ids.length, changed: r0.rows.length,
      skipped: ids.length - r0.rows.length,
      skipped_reason: ids.length - r0.rows.length ? "这些不是【已批准且未执行】(可能已经标过了)" : null,
      rows: r0.rows, readback: back0.rows,
    } };
  }

  const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "expired";

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

  // 一个事务里三步:①学箱规 ②回填到这些待审行 ③再做审核写入。
  // 顺序不能反 —— 第③步的 SQL 读的就是 case_qty 这一列。
  const client = await pool.connect();
  let r;
  try {
    await client.query("BEGIN");

    // ① 这次填的箱规,先只写进【这一行】,不动全局记忆。
    //    codex 审出:先写全局的话,一个 status 已经不是 proposed、实际 changed=0 的请求
    //    照样会把全店的箱规改掉。所以顺序必须是「先落这一行 → 审核真生效了 → 才敢记住」。
    if (status === "approved" && unit === "case" && packQty !== null) {
      await client.query(
        `UPDATE public.petstore_restock_intents
            SET case_qty = $1::numeric
          WHERE id = ANY($2::bigint[]) AND status = 'proposed'`, [packQty, ids]);
    }

    // ② 回填:待审行还没有箱规的,从已学到的箱规里带出来
    await client.query(
      `UPDATE public.petstore_restock_intents r
          SET case_qty = p.pack_qty
         FROM public.petstore_product_pack p
        WHERE p.product_code = r.product_code
          AND r.id = ANY($1::bigint[]) AND r.status = 'proposed'
          AND r.case_qty IS NULL`, [ids]);

    // ③ 审核写入
    r = await client.query(sql, [status, who, note, qty, ids, unit, cases]);

    // ④ 审核【真的生效了】才记住箱规。changed=0 的请求什么都改不了。
    if (status === "approved" && unit === "case" && packQty !== null && r.rows.length === 1) {
      await client.query(
        `INSERT INTO public.petstore_product_pack
                (product_code, pack_qty, unit_name, learned_from, updated_by)
         VALUES ($1, $2::numeric, $3::text, 'restock_approve', $4::text)
         ON CONFLICT (product_code) DO UPDATE
            SET pack_qty = EXCLUDED.pack_qty, unit_name = EXCLUDED.unit_name,
                learned_from = EXCLUDED.learned_from, updated_by = EXCLUDED.updated_by,
                updated_at = now()`,
        [r.rows[0].product_code, packQty, packUnit, who]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // 🔴 回读:把这批 id 在库里的真实状态再查一遍,返回真实值而不是"我以为写成了什么"
  const back = await pool.query(
    `SELECT r.id, r.status, r.decided_by, r.decided_at, r.decided_qty, r.decided_cases,
            r.buy_unit, r.case_qty, p.updated_by AS pack_by, p.learned_from AS pack_src
       FROM public.petstore_restock_intents r
       LEFT JOIN public.petstore_product_pack p ON p.product_code = r.product_code
      WHERE r.id = ANY($1::bigint[]) ORDER BY r.id`, [ids]);

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
