// 单品详情:改价历史(分渠道) + 当前状态 + 系统建议 + 老板批注
// 「点开有详情,什么时候改过价格,以及建议,我可以补充」(Damon 2026-08-12)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const MARGIN = [
  [["DOGSOME","SNIFFLY","CATSOME","PETSOME"], 0.55, "自有品牌"],
  [["猫砂","砂"], 0.25, "猫砂"],
  [["粮","主食罐"], 0.20, "主粮"],
  [["零食","冻干","磨牙","肉干","肉条","海苔","饼干","猫条","罐头"], 0.30, "零食"],
  [["营养","补充剂","化毛","益生菌","鱼油","保健","片","粉"], 0.45, "保健"],
];
const COMMISSION = 0.05;   // Damon 0812 定;真实账单到手要重算

function categorize(name = "", cat = "") {
  const up = String(name).toUpperCase(), hay = String(cat) + String(name);
  for (const [keys, m, label] of MARGIN) {
    if (label === "自有品牌") { if (keys.some(k => up.includes(k))) return [m, label]; }
    else if (label === "猫砂") { if (keys.some(k => hay.includes(k)) && !hay.includes("粮")) return [m, label]; }
    else if (keys.some(k => hay.includes(k))) return [m, label];
  }
  return [0.25, "用品"];
}
function endNine(v) { const i = Math.floor(v); return (v - i < 0.9) ? i + 0.9 : i + 1.9; }

// 建议 = 一句话结论 + 依据。规则同 skill petshop-pricing-framework。
function advise(sku, todos) {
  const cost = Number(sku?.cost_price), price = Number(sku?.out_price);
  const kinds = new Set((todos || []).map(t => t.todo_type));
  const out = [];
  if (kinds.has("已过期")) out.push({ level: "red", title: "下架报损，别再定价",
    why: "系统判已过期。任何价格都不该继续卖；先让店员翻实物核日期，真过期就报损，日期没错再改回上架。" });
  if (kinds.has("快过期")) out.push({ level: "orange", title: "按剩余天数走时间折扣",
    why: "梯度：>90天正常 / 60-90观察 / 30-60打8.5折 / 15-30打7折+买赠 / 7-15打5折进特价区 / <7天清仓（食品地板=成本×0.5）。流通慢的处方粮兽药，剩<15天可到1-3折。" });
  if (kinds.has("假成本")) out.push({ level: "gray", title: "成本是脏数据，先别定价",
    why: "成本≤0.05 或 ≥9999。试吃装/赠品成本近零是正常的；其余要去核进价，成本不对算什么都错。" });
  if (kinds.has("无货位")) out.push({ level: "yellow", title: "补货位",
    why: "有库存但没绑货架号，店员在架上找不到、也没法贴价签。补完才进得了打标流程。" });
  if (Number.isFinite(cost) && Number.isFinite(price) && cost > 0.05 && cost < 9999) {
    const [m, label] = categorize(sku.product_name, sku.category);
    const formula = endNine(cost / (1 - m));
    const capped = Math.min(formula, Math.max(price * 2, cost * 1.2));
    const online = cost / (1 - COMMISSION);
    if (price < cost) out.push({ level: "red", title: `亏本卖，建议线下 ¥${capped.toFixed(2)}`,
      why: `成本¥${cost} > 售价¥${price}，卖一件亏一件。按「${label}」目标毛利${Math.round(m*100)}%算 ¥${formula.toFixed(2)}，线下封顶(原价×2 / 成本×1.2)后 ¥${capped.toFixed(2)}。外卖保本线 ¥${online.toFixed(2)}(抽成${COMMISSION*100}%)。` });
    else if (Math.abs(price - cost) < 0.005) out.push({ level: "orange", title: `零毛利，建议线下 ¥${capped.toFixed(2)}`,
      why: `售价=成本¥${cost}，卖一件白干。同上按「${label}」${Math.round(m*100)}%算。` });
    else if ((price - cost) / price < 0.10) out.push({ level: "orange", title: `毛利仅${(((price-cost)/price)*100).toFixed(1)}%`,
      why: `按「${label}」目标${Math.round(m*100)}%，参考价 ¥${capped.toFixed(2)}。是流量品可以不动，是利润品该提。` });
  }
  if ((Number(sku?.month_sale) || 0) <= 0 && !kinds.has("已过期"))
    out.push({ level: "gray", title: "月销0：先查陈列，别急着改价",
      why: "卖不动的品涨价=更卖不动，降价也未必有用。先确认有没有货位、有没有陈列、是不是根本没上架。⚠️店铺08-07起置休中，这期间的月销数据不作数。" });
  return out;
}

export async function loadDetail(pool, code) {
  const [sku, logs, todos, notes, intents] = await Promise.all([
    pool.query(`SELECT * FROM petstore_skus WHERE product_code=$1 LIMIT 1`, [code]),
    pool.query(`SELECT log_date::text AS log_date, ts, channel, old_price, new_price, rate, reason, result
                  FROM petstore_pricing_log WHERE product_code=$1 ORDER BY ts DESC LIMIT 200`, [code]),
    pool.query(`SELECT todo_type, shelf, warn_status, production_date, expire_date, stock, out_price, snapshot_date::text AS snapshot_date
                  FROM petstore_daily_todo WHERE product_code=$1
                   AND snapshot_date=(SELECT max(snapshot_date) FROM petstore_daily_todo)`, [code]),
    pool.query(`SELECT id, note, author, created_at FROM petstore_product_notes
                 WHERE product_code=$1 ORDER BY created_at DESC LIMIT 50`, [code]).catch(() => ({ rows: [] })),
    pool.query(`SELECT id, channel, old_price, target_price, reason, author, status, result, created_at, applied_at
                  FROM petstore_price_intents WHERE product_code=$1 ORDER BY created_at DESC LIMIT 30`, [code])
        .catch(() => ({ rows: [] })),
  ]);
  const s = sku.rows[0] || null;
  const t = todos.rows || [];
  return { sku: s, history: logs.rows, todos: t, notes: notes.rows || [],
           intents: intents.rows || [], advice: advise(s, t) };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  const code = String(req.query?.product_code || "").trim();
  if (!code) return res.status(400).json({ success: false, error: "product_code required" });
  try {
    res.status(200).json({ success: true, data: await loadDetail(getPool(), code) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
