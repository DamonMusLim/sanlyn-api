// api/db/ciq-merged.js — 合并报检要素 (2026-08-08)
// 一票(BL/plan)多柜多订单 → 合并成【一份】出境检验检疫申请的全部要素,
// 直接对应单一窗口 tecwebserver 的 preDecHead / preDecList / 包装 / 随附单据 字段名,
// 拿到就能按 project_zhongsha_ciq_api_template 的 10 步 API 序列申报。
// 🔒 只出要素,不申报 —— 申报是不可逆官方动作,由人点。
// 🔒 绝不造数: 查不到的字段给 null 并进 gaps[], 不兜底不猜。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const S = v => (v == null ? "" : String(v).trim());
const N = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = v => (N(v) == null ? null : Math.round(N(v) * 100) / 100);
// PG 的 date/timestamptz 取出来是 JS Date 对象, String(v).slice(0,10) 会得到 "Thu Aug 13"(乱码日期)。
// 统一按北京时区格式化成 YYYY-MM-DD。
const bjDate = v => {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  const b = new Date(d.getTime() + 8 * 3600 * 1000);
  return b.toISOString().slice(0, 10);
};

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!["admin", "finance", "logistics"].includes(req.user?.role)) {
    return res.status(403).json({ error: "无权限" });
  }
  const pool = getPool();
  const bl = S(req.query.bl), planId = S(req.query.plan_id);
  if (!bl && !planId) return res.status(400).json({ error: "需要 bl 或 plan_id" });

  const gaps = [];
  const need = (cond, msg) => { if (!cond) gaps.push(msg); };

  // ── 票 ──
  const p = (await pool.query(
    planId ? `SELECT * FROM shipping_plans WHERE id=$1`
           : `SELECT * FROM shipping_plans WHERE bl_no=$1 ORDER BY id DESC LIMIT 1`,
    [planId || bl])).rows[0];
  if (!p) return res.status(404).json({ error: "查无此票", bl, planId });

  // ── 订单(外键为真源, 数组仅兜底) ──
  let orders = (await pool.query(
    `SELECT * FROM orders WHERE shipping_plan_id=$1 ORDER BY order_no`, [p.id])).rows;
  if (!orders.length && Array.isArray(p.order_nos) && p.order_nos.length) {
    orders = (await pool.query(`SELECT * FROM orders WHERE order_no = ANY($1::text[])`, [p.order_nos])).rows;
  }
  if (!orders.length) return res.status(404).json({ error: "本票查不到订单", plan_id: p.id });
  const orderIds = orders.map(o => Number(o.id)).filter(Boolean);

  // ── 公司: 申报主体 / 生产单位 / 收货人 ──
  const co = async (code, name) => code || name
    ? (await pool.query(
        `SELECT code,name_cn,name_en,tax_id,customs_reg_code,ciq_reg_no,address,contact_name,contact_phone
           FROM companies WHERE ($1<>'' AND code=$1) OR ($2<>'' AND (name_cn=$2 OR name_en=$2)) LIMIT 1`,
        [S(code), S(name)])).rows[0] || null
    : null;
  const first = k => { for (const o of orders) if (S(o[k])) return S(o[k]); return ""; };
  const applicant   = await co("", first("issuing_company"));            // 申报主体(巴匕)
  const manufacturer= await co(first("factory_code"), first("factory")); // 生产单位(中砂)
  const consignee   = await co(first("company_code"), first("customer"));// 境外收货人
  need(applicant?.ciq_reg_no || applicant?.customs_reg_code, "申报主体缺 ciq_reg_no/customs_reg_code(companies)");
  need(manufacturer?.ciq_reg_no || manufacturer?.tax_id, "生产单位缺 ciq_reg_no/tax_id(companies)");
  need(consignee?.name_en, "收货人缺英文名(companies)");

  // ── 合作/授权关系(签约才可代理报检) ──
  let delegation = null;
  if (applicant && manufacturer) {
    delegation = (await pool.query(
      `SELECT r.started_at::date AS signed_at, r.ended_at::date AS ended_at, r.status, r.raw
         FROM relationships r
         JOIN companies a ON a.id=r.from_company_id JOIN companies b ON b.id=r.to_company_id
        WHERE a.code=$1 AND b.code=$2 ORDER BY r.started_at DESC NULLS LAST LIMIT 1`,
      [applicant.code, manufacturer.code])).rows[0] || null;
  }
  if (delegation) {  // 同一个日期坑: PG date → JS Date, 统一按北京时区输出
    delegation.signed_at = bjDate(delegation.signed_at);
    delegation.ended_at  = bjDate(delegation.ended_at);
  }
  need(delegation && delegation.status === "active", "未查到有效的『申报主体↔生产单位』签约关系(relationships)");

  // ── 货物: 同HS合并一行; 申报要素逐字段"同值用之/不同值全写"(DNA) ──
  const g = (await pool.query(
    `WITH k AS (
       SELECT l.hs_code, l.declaration_name, l.sku, l.qty_ctn, l.subtotal,
              l.nw_ctn, l.gw_ctn, l.size, p.declaration_elements
         FROM order_line_items l
         LEFT JOIN (SELECT DISTINCT ON (sku) sku, declaration_elements FROM products
                     WHERE sku IS NOT NULL
                     ORDER BY sku, active DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC) p
                ON p.sku = l.sku
        WHERE l.order_id = ANY($1::int[])),
     ep AS (SELECT k.hs_code,
              (regexp_match(t.part,'^\\s*([0-9]+)\\s*:\\s*([^:]+?)\\s*:\\s*(.*)$'))[1] n,
              (regexp_match(t.part,'^\\s*([0-9]+)\\s*:\\s*([^:]+?)\\s*:\\s*(.*)$'))[2] f,
              btrim((regexp_match(t.part,'^\\s*([0-9]+)\\s*:\\s*([^:]+?)\\s*:\\s*(.*)$'))[3]) v
            FROM k, LATERAL unnest(string_to_array(k.declaration_elements,'|')) t(part)
           WHERE k.declaration_elements IS NOT NULL),
     em AS (SELECT hs_code,n,f, string_agg(DISTINCT NULLIF(v,''),'/' ORDER BY NULLIF(v,'')) v
              FROM ep WHERE n IS NOT NULL GROUP BY hs_code,n,f),
     el AS (SELECT hs_code, string_agg(n||':'||f||':'||COALESCE(v,''),'|' ORDER BY n::int) ele
              FROM em GROUP BY hs_code)
     SELECT k.hs_code,
            max(k.declaration_name) AS decl_name,
            string_agg(DISTINCT NULLIF(btrim(k.size),''),'/' ORDER BY NULLIF(btrim(k.size),'')) AS spec,
            sum(k.qty_ctn) AS qty_ctn,
            round(sum(k.nw_ctn*k.qty_ctn)::numeric,2) AS net_kg,
            round(sum(k.gw_ctn*k.qty_ctn)::numeric,2) AS gross_kg,
            sum(k.subtotal) AS amount,
            round(sum(k.subtotal)::numeric/NULLIF(sum(k.qty_ctn),0),5) AS unit_price,
            max(el.ele) AS elements
       FROM k LEFT JOIN el ON el.hs_code=k.hs_code
      GROUP BY k.hs_code ORDER BY k.hs_code`, [orderIds])).rows;
  need(g.length > 0, "本票无货物明细(order_line_items)");

  // ── 柜(真源 container_bookings) ──
  const ctn = (await pool.query(
    `SELECT container_no, container_type FROM container_bookings
      WHERE shipping_plan_id=$1 AND NULLIF(btrim(container_no),'') IS NOT NULL
      ORDER BY container_no`, [p.id])).rows;

  const totalQty = g.reduce((s, x) => s + (N(x.qty_ctn) || 0), 0);
  const totalNet = r2(g.reduce((s, x) => s + (N(x.net_kg) || 0), 0));
  const totalGw  = r2(g.reduce((s, x) => s + (N(x.gross_kg) || 0), 0));
  const ciqNo = first("ciq_application_no");

  return res.json({
    merged: true,
    source: { plan_id: p.id, shipment_no: p.shipment_no, bl_no: p.bl_no,
              orders: orders.map(o => o.order_no), contracts: orders.map(o => o.contract_no) },
    already_filed: ciqNo ? { ciq_no: ciqNo, edoc_no: ciqNo + "001" } : null,
    // 单一窗口 preDecHead 对应字段(机关/口岸等代码由报检模板补, 见 project_zhongsha_ciq_api_template)
    head: {
      declCode: "24", declCodeName: "出境检验检疫",
      agentScc: applicant?.tax_id || null, declRegNo: applicant?.ciq_reg_no || applicant?.customs_reg_code || null,
      cnsnTradeScc: applicant?.tax_id || null,
      consignorCname: applicant?.name_cn || null, consignorEname: applicant?.name_en || null,
      consigneeCname: "***", consigneeEname: consignee?.name_en || null, consigneeAddr: consignee?.address || null,
      contractNo: S(orders[0]?.contract_no) || null,
      despDate: bjDate(p.etd),
      markNo: "N/M",
    },
    goods: g.map((x, i) => ({
      gNo: String(i + 1), codeTs: x.hs_code, gName: x.decl_name, goodsSpec: x.spec,
      ciqQty: N(x.qty_ctn), ciqQtyMeasUnitName: "箱",
      ciqWeight: N(x.net_kg), qty1: N(x.net_kg), unit1Name: "千克",
      pricePerUnit: N(x.unit_price), goodsTotalVal: N(x.amount), ciqCurrName: "人民币",
      declaration_elements: x.elements || null,
      mnufctrRegNo: manufacturer?.ciq_reg_no || manufacturer?.tax_id || null,
      mnufctrRegName: manufacturer?.name_cn || null,
      packQty: N(x.qty_ctn),
    })),
    totals: { qty_ctn: totalQty, net_kg: totalNet, gross_kg: totalGw,
              amount: r2(g.reduce((s, x) => s + (N(x.amount) || 0), 0)) },
    containers: ctn.map(c => ({ container_no: c.container_no, container_type: c.container_type })),
    delegation, gaps,
    ready: gaps.length === 0,
    note: "只出要素不申报。申报走 project_zhongsha_ciq_api_template 的 10 步序列, 由人点扳机。",
  });
}
