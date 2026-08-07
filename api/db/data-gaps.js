// data-gaps.js — 补资料任务清单引擎
// GET /api/db/data-gaps  → 扫4域缺口，返回逐条可补任务（带skill触发词）
import { getPool, setCors } from "../db.js";


// 2026-08-06 时区根治：PG 的 date/timestamptz 取出来是 JS Date 对象。
//   String(d).substring(0,10) → "Thu Aug 13"（乱码）
//   JSON 下发再 slice        → 差 8 小时，date 型直接差一天
// 唯一正确写法：显式转 Asia/Shanghai。sv-SE locale 输出就是 YYYY-MM-DD HH:mm。
function bjDate(v){ if(v==null||v==="")return null; try{ return new Date(v).toLocaleDateString("sv-SE",{timeZone:"Asia/Shanghai"}); }catch(e){ return null; } }
function bjTime(v){ if(v==null||v==="")return null; try{ return new Date(v).toLocaleString("sv-SE",{timeZone:"Asia/Shanghai"}).slice(0,16); }catch(e){ return null; } }

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const pool = getPool();
  const tasks = [];
  try {
    // 1. 海运成本缺口
    const c1 = await pool.query(`
      SELECT sp.bl_no, sp.customer, sp.carrier_code, sp.etd, sp.forwarder_cn
      FROM shipping_plans sp
      WHERE sp.bl_no IS NOT NULL AND sp.bl_no!='' AND sp.bl_no NOT LIKE 'BL-%'
        AND sp.etd>='2026-01-01'
        AND NOT EXISTS(SELECT 1 FROM freight_supplier_bills f WHERE f.bl_no=sp.bl_no)
      ORDER BY sp.etd DESC`);
    for (const r of c1.rows) tasks.push({
      domain: "海运成本", icon: "🚢", severity: 1,
      title: `${r.bl_no} 缺货代成本`,
      detail: `${r.customer||"?"} · ${r.carrier_code||"?"} · ${r.forwarder_cn||"货代未知"} · ETD ${bjDate(r.etd)||"—"}`,
      ref: r.bl_no, skill: "shipping-intake",
      trigger: `这票货的船费录一下 ${r.bl_no}`,
    });

    // 2. 订单缺工厂
    const c2 = await pool.query(`
      SELECT order_no, bl_no, customer FROM orders
      WHERE bl_no IS NOT NULL AND bl_no!=''
        AND NULLIF(factory_code,'') IS NULL AND NULLIF(raw->>'factory','') IS NULL
        AND NULLIF(raw->>'factoryName','') IS NULL
      ORDER BY order_no`);
    for (const r of c2.rows) tasks.push({
      domain: "订单字段", icon: "📝", severity: 1,
      title: `${r.order_no} 缺工厂`,
      detail: `${r.customer||"?"} · BL ${r.bl_no}`,
      ref: r.order_no, skill: "order-intake",
      trigger: `订单 ${r.order_no} 补工厂资料`,
    });

    // 3. 订单缺出单公司
    const c3 = await pool.query(`
      SELECT order_no, bl_no, customer FROM orders
      WHERE bl_no IS NOT NULL AND bl_no!='' AND NULLIF(issuing_company,'') IS NULL
      ORDER BY order_no`);
    for (const r of c3.rows) tasks.push({
      domain: "订单字段", icon: "📝", severity: 1,
      title: `${r.order_no} 缺出单公司`,
      detail: `${r.customer||"?"} · BL ${r.bl_no}`,
      ref: r.order_no, skill: "order-intake",
      trigger: `订单 ${r.order_no} 补出单公司`,
    });

    // 4. 产品缺HS/申报名
    const c4 = await pool.query(`
      SELECT sku, product_name, factory_name,
        (NULLIF(hs_code,'') IS NULL) as no_hs,
        (NULLIF(declaration_name,'') IS NULL) as no_decl
      FROM products
      WHERE NULLIF(hs_code,'') IS NULL OR NULLIF(declaration_name,'') IS NULL
      LIMIT 200`);
    for (const r of c4.rows) {
      const miss = [r.no_hs?"HS编码":null, r.no_decl?"申报名":null].filter(Boolean).join("+");
      tasks.push({
        domain: "产品主数据", icon: "📦", severity: 0,
        title: `${r.sku} 缺${miss}`,
        detail: `${r.product_name||""} · ${r.factory_name||""}`,
        ref: r.sku, skill: "customs-declaration",
        trigger: `产品 ${r.sku} 报关要素填一下`,
      });
    }

    // 5. 财务对不上：已发货无付款
    const c5 = await pool.query(`
      SELECT o.order_no, o.bl_no, o.customer, o.total_amount, o.currency
      FROM orders o
      WHERE o.bl_no IS NOT NULL AND o.bl_no!='' AND o.status ILIKE '%ship%'
        AND NOT EXISTS(SELECT 1 FROM finance_payments p WHERE p.order_no=o.order_no)
        AND NOT EXISTS(SELECT 1 FROM bank_slips b JOIN bank_slip_links l ON l.slip_id=b.id WHERE l.order_no=o.order_no)
      LIMIT 100`).catch(()=>({rows:[]}));
    for (const r of c5.rows) tasks.push({
      domain: "财务对账", icon: "💰", severity: 1,
      title: `${r.order_no} 已发货无付款`,
      detail: `${r.customer||"?"} · 应收 ${r.currency||""} ${r.total_amount||"?"}`,
      ref: r.order_no, skill: "finance-slip",
      trigger: `${r.order_no} 这笔钱到账了核一下`,
    });

    // 6. 海运字段：柜型空
    const c6 = await pool.query(`
      SELECT bl_no, customer, etd FROM shipping_plans
      WHERE bl_no IS NOT NULL AND bl_no!='' AND NULLIF(container_type,'') IS NULL AND etd>='2026-01-01'
      ORDER BY etd DESC`);
    for (const r of c6.rows) tasks.push({
      domain: "海运字段", icon: "🚢", severity: 0,
      title: `${r.bl_no} 缺柜型`,
      detail: `${r.customer||"?"} · ETD ${bjDate(r.etd)||"—"}`,
      ref: r.bl_no, skill: "shipping-intake",
      trigger: `补 ${r.bl_no} 的柜型(20GP/40HQ)`,
    });
    // 7. 海运字段：无ETD
    const c7 = await pool.query(`
      SELECT bl_no, customer, contract_no FROM shipping_plans
      WHERE bl_no IS NOT NULL AND bl_no!='' AND etd IS NULL`);
    for (const r of c7.rows) tasks.push({
      domain: "海运字段", icon: "🚢", severity: 0,
      title: `${r.bl_no} 缺船期ETD`,
      detail: `${r.customer||"?"} · ${r.contract_no||""}`,
      ref: r.bl_no, skill: "shipping-intake",
      trigger: `补 ${r.bl_no} 的船期ETD`,
    });

    // 8. 缺合同号（海运+订单）
    const c8 = await pool.query(`
      SELECT bl_no, customer, etd FROM shipping_plans
      WHERE bl_no IS NOT NULL AND bl_no!='' AND NULLIF(contract_no,'') IS NULL AND etd>='2026-01-01'
      ORDER BY etd DESC`);
    for (const r of c8.rows) tasks.push({
      domain:"海运字段", icon:"🚢", severity:0,
      title:`${r.bl_no} 缺合同号`,
      detail:`${r.customer||"?"} · ETD ${bjDate(r.etd)||"—"}`,
      ref:r.bl_no, skill:"shipping-intake",
      trigger:`补 ${r.bl_no} 的合同号`,
    });
    const c9 = await pool.query(`
      SELECT order_no, bl_no, customer FROM orders
      WHERE bl_no IS NOT NULL AND bl_no!='' AND NULLIF(contract_no,'') IS NULL`);
    for (const r of c9.rows) tasks.push({
      domain:"订单字段", icon:"📝", severity:0,
      title:`${r.order_no} 缺合同号`,
      detail:`${r.customer||"?"} · BL ${r.bl_no}`,
      ref:r.order_no, skill:"order-intake",
      trigger:`订单 ${r.order_no} 补合同号`,
    });

    // 9. 海运行缺订单关联（仅2026近期，历史不计）
    const c10 = await pool.query(`
      SELECT bl_no, customer, etd FROM shipping_plans sp
      WHERE bl_no IS NOT NULL AND bl_no!='' AND source_system IS NULL AND etd>='2026-01-01'
        AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.bl_no=sp.bl_no OR o.contract_no=sp.contract_no)
      ORDER BY etd DESC`);
    for (const r of c10.rows) tasks.push({
      domain:"订单字段", icon:"📝", severity:1,
      title:`${r.bl_no} 海运行无对应订单`,
      detail:`${r.customer||"?"} · ETD ${bjDate(r.etd)||"—"} · 需按单据建订单`,
      ref:r.bl_no, skill:"order-intake",
      trigger:`${r.bl_no} 这票货建订单录进系统`,
    });

    const summary = {};
    for (const t of tasks) summary[t.domain] = (summary[t.domain]||0)+1;
    res.json({ success: true, total: tasks.length, summary, tasks });
  } catch (err) {
    console.error("[data-gaps]", err.message);
    res.status(500).json({ error: err.message });
  }
}
