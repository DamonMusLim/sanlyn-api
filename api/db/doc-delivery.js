// api/db/doc-delivery.js — 对外发资料：清单 / 打包 / 留痕 (2026-08-08)
//
// 为什么有这个接口：
//   报关行、船东、客户各要的单据不一样、偏好的格式也不一样（报关行/船东要 xlsx——
//   他们要把数字复制进自己的报关/舱单系统；客户要 pdf）。以前是人凭记忆挑文件、
//   手工发，系统里查不到"发没发、发的哪一版"（doc_sends 长期 0 行）。
//
// 🔒 边界：本接口【只准备】，不发送。发邮件/发微信是对外不可逆动作，由人点。
//         人发完回来调 POST 记一笔留痕（连数字快照一起存，事后能证明发的是哪一版）。
// 🔒 绝不造数：清单来自 doc_delivery_profiles 配置表，不写死在代码里。
//
// GET  /api/db/doc-delivery?bl=<BL>&role=报关行   → 该发哪些、每份的下载链接、数字自检
// POST /api/db/doc-delivery                      → 记一笔发件留痕
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const S = v => (v == null ? "" : String(v).trim());
const N = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// 单据键 → 下载 URL 构造。集中在这里，避免各处手拼 URL 拼错参数
// （2026-08-08 血泪：ids 传法一错静默出半票；?token= 忘了带出全白 PDF）。
function buildUrl(docKey, format, ctx) {
  const { blNo, mainOrder } = ctx;
  const q = s => encodeURIComponent(s == null ? "" : String(s));
  switch (docKey) {
    case "pack_customs":
      // 不传 ids —— 服务端按 shipping_plan_id 自动补全本票范围（根治后行为）
      return `/api/db/documents?type=pack&id=${q(mainOrder)}&audience=customer&customs=1&format=${q(format)}`;
    case "pack_customer":
      return `/api/db/documents?type=pack&id=${q(mainOrder)}&audience=customer&format=${q(format)}`;
    case "customs_decl":
      return `/api/db/shipping-plan-pdf?type=customs_decl&bl=${q(blNo)}&format=${q(format)}`;
    case "si":
      return `/api/db/shipping-plan-pdf?type=si&bl=${q(blNo)}&format=${q(format)}`;
    case "quarantine_report":
      return null; // 已归档件，走 document_uploads 里的真实 URL
    default:
      return null;
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!["admin", "finance", "logistics"].includes(req.user?.role)) {
    return res.status(403).json({ error: "无权限" });
  }
  const pool = getPool();

  // ── POST：记一笔发件留痕 ──
  if (req.method === "POST") {
    const b = req.body || {};
    if (!S(b.recipient_role) || !S(b.recipient)) {
      return res.status(400).json({ error: "recipient_role 和 recipient 必填" });
    }
    const r = await pool.query(
      `INSERT INTO doc_deliveries
         (shipping_plan_id,bl_no,recipient_role,recipient,channel,files,totals_snapshot,sent_by,note)
       VALUES ($1,$2,$3,$4,COALESCE($5,'email'),COALESCE($6,'[]'::jsonb),$7,$8,$9)
       RETURNING id, sent_at`,
      [N(b.shipping_plan_id), S(b.bl_no) || null, S(b.recipient_role), S(b.recipient),
       S(b.channel) || null, JSON.stringify(b.files || []),
       b.totals_snapshot ? JSON.stringify(b.totals_snapshot) : null,
       S(req.user?.username) || null, S(b.note) || null]
    );
    return res.json({ ok: true, id: r.rows[0].id, sent_at: r.rows[0].sent_at });
  }

  // ── GET：出清单 ──
  const bl = S(req.query.bl), role = S(req.query.role) || "报关行";
  if (!bl) return res.status(400).json({ error: "需要 bl" });

  const plan = (await pool.query(
    `SELECT id, bl_no, shipment_no, etd FROM shipping_plans WHERE bl_no=$1 LIMIT 1`, [bl]
  )).rows[0];
  if (!plan) return res.status(404).json({ error: "查无此提单", bl });

  // 本票全部订单 + 合计（发出去的每份单据都要跟它对得上）
  const ords = (await pool.query(
    `SELECT order_no, contract_no, total_qty, net_weight, gross_weight, total_amount, ciq_application_no
       FROM orders WHERE shipping_plan_id=$1 ORDER BY order_no`, [plan.id]
  )).rows;
  const totals = ords.reduce((a, o) => ({
    qty_ctn: a.qty_ctn + (N(o.total_qty) || 0),
    net_kg:  Math.round((a.net_kg  + (N(o.net_weight)   || 0)) * 100) / 100,
    gross_kg:Math.round((a.gross_kg+ (N(o.gross_weight) || 0)) * 100) / 100,
    amount:  Math.round((a.amount  + (N(o.total_amount) || 0)) * 100) / 100,
  }), { qty_ctn: 0, net_kg: 0, gross_kg: 0, amount: 0 });

  const profiles = (await pool.query(
    `SELECT doc_key, doc_label, format, required, sort_order, note
       FROM doc_delivery_profiles WHERE recipient_role=$1 AND active
       ORDER BY sort_order, doc_key`, [role]
  )).rows;
  if (!profiles.length) {
    return res.status(404).json({ error: "没有这个收件方的发件配置", role,
      hint: "在 doc_delivery_profiles 表里配置；配置是数据不是代码。" });
  }

  // 已归档件（检疫报告等）取真实 URL
  const orderNos = ords.map(o => o.order_no).filter(Boolean);
  const uploads = orderNos.length ? (await pool.query(
    `SELECT DISTINCT ON (doc_type) doc_type, url, name
       FROM document_uploads WHERE doc_id = ANY($1::text[])
       ORDER BY doc_type, uploaded_at DESC`, [orderNos]
  )).rows : [];
  const upByType = {};
  uploads.forEach(u => { upByType[u.doc_type] = u; });

  const gaps = [];
  const items = profiles.map(p => {
    let url = buildUrl(p.doc_key, p.format, { blNo: plan.bl_no, mainOrder: orderNos[0] });
    let source = "generate";
    if (!url) {
      const up = upByType[p.doc_key];
      if (up) { url = up.url; source = "archived"; }
    }
    if (!url && p.required) gaps.push(`缺【${p.doc_label}】——${p.doc_key} 既没有生成方式也没有归档件`);
    return { doc_key: p.doc_key, label: p.doc_label, format: p.format,
             required: p.required, source, url, note: p.note };
  });

  // 上次发件
  const last = (await pool.query(
    `SELECT id, recipient, channel, sent_at, sent_by, totals_snapshot
       FROM doc_deliveries WHERE bl_no=$1 AND recipient_role=$2
       ORDER BY sent_at DESC LIMIT 1`, [plan.bl_no, role]
  )).rows[0] || null;
  // 发过之后数字变了 → 必须重发（这是最容易漏的：改了单没重发）
  let stale = false;
  if (last && last.totals_snapshot) {
    const t = last.totals_snapshot;
    stale = ["qty_ctn", "net_kg", "gross_kg", "amount"].some(k => Number(t[k]) !== Number(totals[k]));
  }

  if (!ords.length) gaps.push("本票下没有订单");
  if (role === "报关行" && !ords.some(o => o.ciq_application_no)) {
    gaps.push("报检还没做（没有检验检疫编号）——报关随附单证填不了");
  }

  res.json({
    bl: plan.bl_no, shipment_no: plan.shipment_no, plan_id: plan.id,
    role,
    orders: ords.map(o => ({ order_no: o.order_no, contract_no: o.contract_no,
      qty_ctn: N(o.total_qty), ciq_no: o.ciq_application_no })),
    totals,
    items,
    already_sent: last,
    stale,                       // true = 发过了但数字已经变，要重发
    gaps,
    ready: gaps.length === 0,
    notice: "此接口只准备文件清单，不发送。发出去是对外动作由人点；发完请 POST 一笔留痕（带 totals 快照）。",
  });
}
