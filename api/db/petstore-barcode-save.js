import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 一品多码维护【写接口】—— 第三个允许写库的接口。
//
// ⛔ 只能改 petstore_product_barcodes 一张表。
// ⛔ 它【不写回果冻橙】。果冻橙那边的「一品多码」标签页目前「暂无数据」,
//    要推过去得先录它的写接口参数(还没录)。现在只维护我们自己这份。
// 🔴 箱进价是成本:可以写进库(定价要用),但查询接口永远不返回。
// 🩸 写完立刻回读,返回库里的真实状态,⛔ 不返回"我以为写成了什么"。
const ACTIONS = Object.assign(Object.create(null), { add: 1, update: 1, remove: 1, set_primary: 1 });
const KINDS   = Object.assign(Object.create(null), { vendor: 1, instore: 1, upca: 1, unknown: 1 });

function json(res, s, d) { return res.status(s).json(d); }
function cleanText(v, m = 60) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }
function num(v) { if (v === null || v === undefined || v === "") return null;
                  const n = Number(v); return Number.isFinite(n) ? n : null; }

// 条码类型自动判(跟汇总时同一套规则,别两处不一致)
function guessKind(bc) {
  if (/^69/.test(bc)) return "vendor";
  if (/^2[0-9]/.test(bc)) return "instore";
  if (/^[0-9]{11,12}$/.test(bc)) return "upca";
  if (/^[0-9]{13}$/.test(bc)) return "vendor";
  return "unknown";
}

async function run(req, who) {
  const b = req.body || {};
  const action = cleanText(b.action, 20);
  if (!action || !Object.hasOwn(ACTIONS, action)) return { code: 400, body: { ok: false, error: "bad_action" } };

  const pc = cleanText(b.product_code, 60);
  const bc = cleanText(b.barcode, 60);
  if (!pc) return { code: 400, body: { ok: false, error: "product_code_required" } };
  if (!bc) return { code: 400, body: { ok: false, error: "barcode_required" } };
  if (!/^[0-9A-Za-z-]{4,32}$/.test(bc)) return { code: 400, body: { ok: false, error: "bad_barcode_format" } };

  const pool = getPool();
  // 商品必须存在,别给不存在的商品挂码
  const chk = await pool.query("SELECT 1 FROM public.petstore_skus WHERE product_code = $1 LIMIT 1", [pc]);
  if (!chk.rowCount) return { code: 404, body: { ok: false, error: "product_not_found" } };

  const kind = (cleanText(b.code_kind, 20) && Object.hasOwn(KINDS, b.code_kind)) ? b.code_kind : guessKind(bc);
  const packType = cleanText(b.pack_type, 20);
  const packQty  = num(b.pack_qty);
  const boxIn    = num(b.box_in_price);
  const boxOut   = num(b.box_out_price);

  // 前端能少犯几个错就少几个 —— 数据库 CHECK 也会拦,但这里先给人话
  if (packQty !== null && packQty <= 0) return { code: 400, body: { ok: false, error: "pack_qty_must_be_positive" } };
  if ((boxIn !== null || boxOut !== null) && (packQty === null || packQty <= 1))
    return { code: 400, body: { ok: false, error: "box_price_needs_pack_qty_gt_1" } };
  if (boxIn !== null && boxOut !== null && boxOut < boxIn)
    return { code: 400, body: { ok: false, error: "box_out_price_lower_than_in_price" } };

  if (action === "remove") {
    await pool.query(
      "DELETE FROM public.petstore_product_barcodes WHERE product_code = $1 AND barcode = $2 AND NOT is_primary",
      [pc, bc]);
    // ⛔ 主码不许删(删了就没有打价签的码了),上面 NOT is_primary 已经挡住
  } else if (action === "set_primary") {
    await pool.query("UPDATE public.petstore_product_barcodes SET is_primary = false WHERE product_code = $1", [pc]);
    await pool.query(
      "UPDATE public.petstore_product_barcodes SET is_primary = true, maintained_by = $3, maintained_at = now() WHERE product_code = $1 AND barcode = $2",
      [pc, bc, who]);
  } else {
    await pool.query(`
      INSERT INTO public.petstore_product_barcodes
        (product_code, barcode, code_kind, source, pack_type, pack_qty,
         box_in_price, box_out_price, maintained_by, maintained_at)
      VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,$8,now())
      ON CONFLICT (product_code, barcode) DO UPDATE SET
        code_kind = EXCLUDED.code_kind, pack_type = EXCLUDED.pack_type,
        pack_qty = EXCLUDED.pack_qty, box_in_price = EXCLUDED.box_in_price,
        box_out_price = EXCLUDED.box_out_price,
        maintained_by = EXCLUDED.maintained_by, maintained_at = now(),
        last_seen = now()`,
      [pc, bc, kind, packType, packQty, boxIn, boxOut, who]);
  }

  // 🔴 回读:返回这个商品现在库里真实的全部条码(⛔ 不含 box_in_price,那是成本)
  const back = await pool.query(`
    SELECT barcode, code_kind, is_primary, pack_type, pack_qty, box_out_price,
           source, maintained_by, maintained_at
      FROM public.petstore_product_barcodes
     WHERE product_code = $1 ORDER BY is_primary DESC, pack_qty NULLS FIRST, id`, [pc]);
  return { code: 200, body: { ok: true, action, product_code: pc, barcodes: back.rows } };
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });
    const who = req.user?.username || req.user?.name || "";
    if (!who) return json(res, 401, { ok: false, error: "no_identity" });
    const out = await run(req, who);
    return json(res, out.code, out.body);
  } catch (e) {
    // 数据库 CHECK 拦下的,把约束名透给前端,让人知道是哪条规矩
    const m = String(e.message || "");
    const cons = (m.match(/constraint "([^"]+)"/) || [])[1];
    return json(res, cons ? 400 : 500, { ok: false, error: cons || m || "server_error" });
  }
}
