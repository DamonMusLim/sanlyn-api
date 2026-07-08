// api/db/email-templates.js — 邮件模版中心 CRUD
// 可编辑的邮件模版库（主题+HTML正文+变量），供「📧 邮件模版中心」编辑/新增/预览。
// 占位符用 {{变量名}}（前端预览与将来发送统一走 mustache 渲染，不做 JS eval）。
// GET    /api/db/email-templates            → { data:[...] }
// GET    /api/db/email-templates?key=pi     → { data:{...} }
// POST   { tpl_key,name,category,sender,subject,html,variables,is_active }
// PATCH  { id, ...fields }
// DELETE ?id=   （is_system 内置模版禁止删除，只能改）
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ── 7 个内置模版（占位符 = 系统字段目录 canonical_key，发送时按订单解析填充）──
// 隔离铁律：客户模版只引用 orders/shipping_plans 客户侧字段，绝不引用工厂价/成本字段。
const SEED = [
  {
    tpl_key: "pi", name: "形式发票 Proforma Invoice", category: "shipping_customer", sender: "oceanbaby",
    subject: "Proforma Invoice - {{orders.contract_no}}",
    variables: ["orders.company_name_en","orders.contract_no","orders.customer_total_amount","orders.payment_terms","orders.etd"],
    html: `<p>Dear {{orders.company_name_en}},</p>
<p>Please find the Proforma Invoice for your reference.</p>
<table class="kv">
  <tr><td><b>Contract No.</b></td><td>{{orders.contract_no}}</td></tr>
  <tr><td><b>Amount</b></td><td>USD {{orders.customer_total_amount}}</td></tr>
  <tr><td><b>Payment Terms</b></td><td>{{orders.payment_terms}}</td></tr>
  <tr><td><b>ETD</b></td><td>{{orders.etd}}</td></tr>
</table>
<p>Please confirm the order and arrange payment at your earliest convenience.</p>
<p>Best regards,<br>Sanlyn Team</p>`,
  },
  {
    tpl_key: "po", name: "采购订单 Purchase Order", category: "factory", sender: "petbaby",
    subject: "Purchase Order - {{orders.contract_no}}",
    variables: ["orders.factory","orders.contract_no","orders.products","orders.total_qty","orders.delivery_date"],
    html: `<p>Dear {{orders.factory}},</p>
<p>Please find the Purchase Order details as follows:</p>
<table class="kv">
  <tr><td><b>PO No.</b></td><td>{{orders.contract_no}}</td></tr>
  <tr><td><b>Product</b></td><td>{{orders.products}}</td></tr>
  <tr><td><b>Quantity</b></td><td>{{orders.total_qty}}</td></tr>
  <tr><td><b>Required Delivery Date</b></td><td>{{orders.delivery_date}}</td></tr>
</table>
<p>Please confirm receipt and advise the production schedule.</p>
<p>Best regards,<br>Sanlyn Purchasing</p>`,
  },
  {
    tpl_key: "delivery_confirm", name: "交期确认 Delivery Confirmed", category: "shipping_customer", sender: "oceanbaby",
    subject: "Delivery Schedule Confirmed - {{orders.contract_no}}",
    variables: ["orders.company_name_en","orders.contract_no","orders.delivery_date","orders.etd"],
    html: `<p>Dear {{orders.company_name_en}},</p>
<p>The factory has confirmed the production schedule for your order.</p>
<table class="kv">
  <tr><td><b>Contract No.</b></td><td>{{orders.contract_no}}</td></tr>
  <tr><td><b>Confirmed Delivery Date</b></td><td>{{orders.delivery_date}}</td></tr>
  <tr><td><b>Estimated Shipment</b></td><td>{{orders.etd}}</td></tr>
</table>
<p>Kindly arrange the payment to ensure timely shipment.</p>
<p>Best regards,<br>Sanlyn Team</p>`,
  },
  {
    tpl_key: "shipping_notice", name: "出运通知 Shipping Notice", category: "shipping_customer", sender: "oceanbaby",
    subject: "Shipping Notice - {{orders.order_no}}",
    variables: ["orders.company_name_en","orders.order_no","shipping_plans.vessel","shipping_plans.voyage","orders.pol","shipping_plans.pod","orders.etd","orders.eta","shipping_plans.cutoff_date","shipping_plans.container_no"],
    html: `<p>Dear {{orders.company_name_en}},</p>
<p>Please be informed of the following shipping schedule:</p>
<table class="kv">
  <tr><td><b>Shipment No.</b></td><td>{{orders.order_no}}</td></tr>
  <tr><td><b>Vessel / Voyage</b></td><td>{{shipping_plans.vessel}} / {{shipping_plans.voyage}}</td></tr>
  <tr><td><b>POL</b></td><td>{{orders.pol}}</td></tr>
  <tr><td><b>POD</b></td><td>{{shipping_plans.pod}}</td></tr>
  <tr><td><b>ETD</b></td><td>{{orders.etd}}</td></tr>
  <tr><td><b>ETA</b></td><td>{{orders.eta}}</td></tr>
  <tr><td><b>Cut-off Date</b></td><td>{{shipping_plans.cutoff_date}}</td></tr>
  <tr><td><b>Container No.</b></td><td>{{shipping_plans.container_no}}</td></tr>
</table>
<p>Please arrange accordingly.</p>
<p>Best regards,<br>Sanlyn Logistics</p>`,
  },
  {
    tpl_key: "documents", name: "单据送达 Shipping Documents", category: "shipping_customer", sender: "oceanbaby",
    subject: "Shipping Documents - {{orders.contract_no}}",
    variables: ["orders.company_name_en","orders.contract_no","orders.bl_no","shipping_plans.vessel","orders.eta"],
    html: `<p>Dear {{orders.company_name_en}},</p>
<p>Please find the shipping documents for your order:</p>
<table class="kv">
  <tr><td><b>Contract No.</b></td><td>{{orders.contract_no}}</td></tr>
  <tr><td><b>B/L No.</b></td><td>{{orders.bl_no}}</td></tr>
  <tr><td><b>Vessel</b></td><td>{{shipping_plans.vessel}}</td></tr>
  <tr><td><b>ETA</b></td><td>{{orders.eta}}</td></tr>
</table>
<p>Documents attached: Bill of Lading (B/L), Commercial Invoice, Packing List, Proforma Invoice.</p>
<p>Please confirm receipt.</p>
<p>Best regards,<br>Sanlyn Team</p>`,
  },
  {
    tpl_key: "payment_reminder", name: "催款 Payment Reminder", category: "finance", sender: "oceanbaby",
    subject: "Payment Reminder - {{orders.contract_no}}",
    variables: ["orders.company_name_en","orders.contract_no","orders.customer_total_amount","amountPaid","amountBalance","dueDate"],
    html: `<p>Dear {{orders.company_name_en}},</p>
<p>This is a friendly reminder regarding the outstanding payment.</p>
<table class="kv">
  <tr><td><b>Contract No.</b></td><td>{{orders.contract_no}}</td></tr>
  <tr><td><b>Total Amount</b></td><td>USD {{orders.customer_total_amount}}</td></tr>
  <tr><td><b>Paid</b></td><td>USD {{amountPaid}}</td></tr>
  <tr><td><b>Balance Due</b></td><td style="color:#e53e3e;"><b>USD {{amountBalance}}</b></td></tr>
  <tr><td><b>Due Date</b></td><td>{{dueDate}}</td></tr>
</table>
<p>Kindly arrange the payment at your earliest convenience.</p>
<p>Best regards,<br>Sanlyn Finance</p>`,
  },
  {
    tpl_key: "custom", name: "自定义 Custom", category: "other", sender: "oceanbaby",
    subject: "{{subject}}",
    variables: ["subject","body"],
    html: `<p>{{body}}</p>`,
  },
];

async function ensure(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id          SERIAL PRIMARY KEY,
      tpl_key     TEXT UNIQUE,
      name        TEXT,
      category    TEXT DEFAULT 'other',
      sender      TEXT DEFAULT 'oceanbaby',
      subject     TEXT,
      html        TEXT,
      variables   JSONB DEFAULT '[]'::jsonb,
      is_active   BOOLEAN DEFAULT true,
      is_system   BOOLEAN DEFAULT false,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ DEFAULT now(),
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `).catch(() => {});
  // 首次为空时播种 7 个内置模版
  const c = await pool.query(`SELECT count(*)::int AS n FROM email_templates`);
  if (c.rows[0].n === 0) {
    for (const s of SEED) {
      await pool.query(
        `INSERT INTO email_templates (tpl_key,name,category,sender,subject,html,variables,is_system)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT (tpl_key) DO NOTHING`,
        [s.tpl_key, s.name, s.category, s.sender, s.subject, s.html, JSON.stringify(s.variables)]
      );
    }
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    await ensure(pool);
    const user = (req.user && (req.user.username || req.user.name)) || "admin";

    if (req.method === "GET") {
      if (req.query.key) {
        const r = await pool.query(`SELECT * FROM email_templates WHERE tpl_key=$1`, [req.query.key]);
        return res.json({ data: r.rows[0] || null });
      }
      const r = await pool.query(`SELECT * FROM email_templates ORDER BY is_system DESC, id ASC`);
      return res.json({ data: r.rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      let key = (b.tpl_key || "").trim();
      if (!key) key = "tpl_" + Date.now();
      if (!/^[a-z0-9_]+$/i.test(key)) return res.status(400).json({ error: "tpl_key 只能用字母数字下划线" });
      const r = await pool.query(
        `INSERT INTO email_templates (tpl_key,name,category,sender,subject,html,variables,is_active,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tpl_key) DO NOTHING RETURNING *`,
        [key, b.name || key, b.category || "other", b.sender || "oceanbaby",
         b.subject || "", b.html || "", JSON.stringify(b.variables || []),
         b.is_active !== false, user]
      );
      if (!r.rows[0]) return res.status(409).json({ error: "tpl_key 已存在" });
      return res.json({ success: true, data: r.rows[0] });
    }

    if (req.method === "PATCH") {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: "id 必填" });
      const fields = ["name","category","sender","subject","html","is_active"];
      const sets = [], vals = [];
      fields.forEach(f => { if (b[f] !== undefined) { vals.push(b[f]); sets.push(`${f}=$${vals.length}`); } });
      if (b.variables !== undefined) { vals.push(JSON.stringify(b.variables)); sets.push(`variables=$${vals.length}`); }
      vals.push(user); sets.push(`updated_by=$${vals.length}`);
      sets.push(`updated_at=now()`);
      vals.push(b.id);
      const r = await pool.query(
        `UPDATE email_templates SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`, vals);
      return res.json({ success: true, data: r.rows[0] });
    }

    if (req.method === "DELETE") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id 必填" });
      const chk = await pool.query(`SELECT is_system FROM email_templates WHERE id=$1`, [id]);
      if (chk.rows[0] && chk.rows[0].is_system)
        return res.status(403).json({ error: "内置模版不可删除，只能编辑" });
      await pool.query(`DELETE FROM email_templates WHERE id=$1`, [id]);
      return res.json({ success: true });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("[email-templates]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
