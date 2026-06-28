// customs-declaration.js
// POST /api/db/customs-declaration
//   报关申报要素写入端点 — 替代已废弃的简道云 jdy_create_customs_doc。
//   把 customs-declaration skill 审核通过的申报要素写回 products 表的 canonical 列
//   （申报要素的唯一真值就在 products，见 skill 铁律）。
//
// 设计要点：
//   • products.sku 不唯一（86 个重复 sku，最多 7 行）→ 绝不按 sku 盲改。
//     标识符优先级 id(PK,唯一) > barcode > sku；命中多行 → 409 列候选，交 skill 消歧。
//   • 申报要素铁律：缺字段 STOP，不编造、不兜底 → declaration_name/declaration_elements/
//     hs_code 为必填核心，空值 400 拒绝；只写显式传入的非空字段。
//   • 仅 admin / logistics 可写（内部报关操作）。
import { getPool, setCors } from "../db.js";
import { requireRole } from "../auth.js";

// 可写回 products 的申报要素列（白名单，防止任意列注入）
const WRITABLE = [
  "declaration_name",
  "declaration_elements",
  "hs_code",
  "factory_city",
  "factory_name",
  "declaration_amount",
];
// 审核通过写入时必须齐备的核心要素（缺则 STOP）
const REQUIRED = ["declaration_name", "declaration_elements", "hs_code"];

function blank(v) {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireRole(req, res, ["admin", "logistics"])) return;

  const pool = getPool();
  const b = req.body || {};

  // ── 1. 解析标识符 → 唯一 product id（fail-closed 消歧）──
  const { id, barcode, sku } = b;
  let key, val;
  if (!blank(id))            { key = "id";      val = id; }
  else if (!blank(barcode))  { key = "barcode"; val = String(barcode).trim(); }
  else if (!blank(sku))      { key = "sku";     val = String(sku).trim(); }
  else {
    return res.status(400).json({ error: "identifier required", message: "需提供 id / barcode / sku 之一" });
  }

  let target;
  try {
    const found = await pool.query(
      `SELECT id, sku, barcode, product_name FROM products WHERE ${key} = $1`,
      [val]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ error: "product not found", message: `按 ${key}=${val} 未找到产品` });
    }
    if (found.rows.length > 1) {
      // 多义 → 不猜，回候选交 skill/Damon 选 id
      return res.status(409).json({
        error: "ambiguous identifier",
        message: `${key}=${val} 命中 ${found.rows.length} 条产品，请改用唯一 id 指定`,
        candidates: found.rows,
      });
    }
    target = found.rows[0];
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // ── 2. 必填核心要素校验（缺字段 STOP，不兜底）──
  const missing = REQUIRED.filter(f => blank(b[f]));
  if (missing.length) {
    return res.status(400).json({
      error: "missing required declaration fields",
      message: `申报要素缺字段，拒绝写入（不编造）：${missing.join(", ")}`,
      missing,
    });
  }

  // ── 3. 组装写入集（只写显式传入的非空白名单字段）──
  const sets = [], vals = [];
  for (const f of WRITABLE) {
    if (!blank(b[f])) {
      vals.push(typeof b[f] === "string" ? b[f].trim() : b[f]);
      sets.push(`${f} = $${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: "no declaration fields to write" });

  // hs_code 来自 skill 人工确认 → 标注 provenance + 标记已核
  vals.push("customs-declaration-skill");
  sets.push(`hs_source = $${vals.length}`);
  vals.push(true);
  sets.push(`hs_verified = $${vals.length}`);

  vals.push(target.id);
  const sql = `UPDATE products SET ${sets.join(", ")}, updated_at = NOW()
               WHERE id = $${vals.length}
               RETURNING id, sku, barcode, product_name,
                         declaration_name, declaration_elements, hs_code,
                         factory_city, factory_name, declaration_amount, hs_verified`;
  try {
    const r = await pool.query(sql, vals);
    return res.status(200).json({ success: true, written: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
