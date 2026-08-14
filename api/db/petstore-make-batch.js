// /api/db/petstore-make-batch —— 待办页「任务模板」按钮的后端。
// (Damon 2026-08-13：红框那里放任务模板 + Damon 专用价格确认)
//
// 做的事：按待办类型从 petstore_daily_todo 圈出今天要做的商品 → 调本机 clerk 服务建批次 → 回链接。
// ⚠️ 圈到 0 件不是失败也不是成功 —— 明确回 count:0，前端显示「这一类现在没有要做的」，
//    不许显示「已生成」糊弄人（0812 那条教训：success 只能表示真的做了事）。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import fs from "node:fs";

const CLERK = "http://127.0.0.1:7432";
const STORE = "63350001";

// 待办类型 → 任务包用途 + 卡片 kind
const KINDS = {
  "已过期":     { purpose: "【已过期】下架 + 核实袋子上的实际日期", kind: "review_expired" },
  "无货位":     { purpose: "【无货位】找到实物、补货架号",         kind: "stocktake" },
  "快过期":     { purpose: "【快过期】核实日期 + 按档贴折扣标",     kind: "verify_expiry" },
  "无生产日期": { purpose: "【补日期】照袋子补生产日期",           kind: "verify_expiry" },
};

function adminToken() {
  try {
    for (const line of fs.readFileSync("/opt/pet-ai-clerk/.env", "utf8").split("\n"))
      if (line.startsWith("CLERK_ADMIN_TOKEN=")) return line.slice(18).trim();
  } catch { /* 本机直连时 clerk 守卫会放行，拿不到也不致命 */ }
  return "";
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST required" });
  if (!requireAuth(req, res)) return;

  const { kind, owner = null, limit = 300 } = req.body || {};
  const p = getPool();

  try {
    // ── 老板专属：价格确认卡由 Studio 的 boss_cards.py 生成，这里只回它的链接 ──
    if (kind === "价格确认") {
      const r = await p.query(
        `SELECT product_code, product_name, spec, shelf, out_price, stock, month_sale,
                todo_type, warn_status, expire_date
           FROM petstore_daily_todo
          WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM petstore_daily_todo)
            AND todo_type IN ('亏本卖','零毛利','假成本','白送','已过期','快过期')
            AND stock > 0
          ORDER BY shelf NULLS LAST LIMIT $1`, [limit]);
      return res.json({
        success: true,
        data: {
          count: r.rows.length,
          link: "https://pet.sanlyn.cn/m/clerk/7c4074d5252b",
          note: "老板专属批次（owner_role=boss，店员打不开）。卡片内容每天 07:20 由 boss_cards.py 重建。",
        },
      });
    }

    const cfg = KINDS[kind];
    if (!cfg) return res.status(400).json({ success: false, error: `未知模板 ${kind}` });

    const r = await p.query(
      `SELECT product_code, product_name, spec, shelf, out_price, stock, month_sale,
              production_date, expire_date, warn_status, barcode
         FROM petstore_daily_todo
        WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM petstore_daily_todo)
          AND todo_type = $1 AND stock > 0
        ORDER BY shelf NULLS LAST, product_code LIMIT $2`, [kind, limit]);

    if (r.rows.length === 0)
      return res.json({ success: true, data: { count: 0, link: null, kind } });

    const products = r.rows.map((x) => ({
      product_code: x.product_code, product_name: x.product_name,
      spec: x.spec || "", shelf_list: x.shelf ? JSON.stringify([x.shelf]) : "",
      stock: Number(x.stock || 0), out_price: Number(x.out_price || 0),
      month_sale: Number(x.month_sale || 0),
      sys_expiry: x.expire_date ? String(x.expire_date).slice(0, 10) : "",
      warn_status: x.warn_status || "", barcode: x.barcode || "",
    }));

    const gr = await fetch(`${CLERK}/generate-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Clerk-Admin": adminToken() },
      body: JSON.stringify({
        products, purpose: cfg.purpose, store_code: STORE, kind: cfg.kind,
      }),
    });
    const gj = await gr.json();
    if (!gj.ok) throw new Error(gj.error || "clerk generate-link 失败");

    return res.json({
      success: true,
      data: { count: gj.task_count, link: gj.public_url, token: gj.token, purpose: gj.purpose, reused: !!gj.reused },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
}
