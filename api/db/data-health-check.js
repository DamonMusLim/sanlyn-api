/**
 * data-health-check.js — GET /api/db/data-health-check
 * v2: 自建 pg.Pool（mount() 不注入 pool），requireAuth 鉴权
 */
import pg from "pg";
import { requireAuth } from "../auth.js";

const ROLLING_DAYS = 90;
const pool = new pg.Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'sanlyn_db',
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

export default async function handleDataHealthCheck(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const t0 = Date.now();
  try {
    const [r1, r2, r3, r4, r5, r6, r7, r8] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS cnt, ARRAY(SELECT COALESCE(order_no,id::text) FROM orders WHERE (created_at>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR etd>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR status IN ('ready','confirmed','shipped','in_transit')) AND (status IS NULL OR status NOT IN ('cancelled','draft','delivered')) AND (company_code IS NULL OR btrim(company_code)='') ORDER BY id LIMIT 5) AS samples FROM orders WHERE (created_at>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR etd>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR status IN ('ready','confirmed','shipped','in_transit')) AND (status IS NULL OR status NOT IN ('cancelled','draft','delivered')) AND (company_code IS NULL OR btrim(company_code)='')`),
      pool.query(`SELECT COUNT(*)::int AS cnt, ARRAY(SELECT COALESCE(order_no,id::text) FROM orders WHERE (created_at>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR etd>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR status IN ('ready','confirmed','shipped','in_transit')) AND (status IS NULL OR status NOT IN ('cancelled','draft','delivered')) AND (trade_terms IS NULL OR btrim(trade_terms)='' OR upper(btrim(trade_terms)) IN ('UNKNOWN','N/A','NA','TBD')) ORDER BY id LIMIT 5) AS samples FROM orders WHERE (created_at>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR etd>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR status IN ('ready','confirmed','shipped','in_transit')) AND (status IS NULL OR status NOT IN ('cancelled','draft','delivered')) AND (trade_terms IS NULL OR btrim(trade_terms)='' OR upper(btrim(trade_terms)) IN ('UNKNOWN','N/A','NA','TBD'))`),
      pool.query(`WITH po AS (SELECT o.id,COALESCE(o.order_no,o.id::text) AS okey,COALESCE(SUM(CASE WHEN COALESCE(oli.declare_amount_per_box,0)>0 AND COALESCE(oli.qty_ctn,0)>0 THEN oli.declare_amount_per_box*oli.qty_ctn ELSE 0 END),0) AS a FROM orders o LEFT JOIN order_line_items oli ON oli.order_id=o.id WHERE o.status='shipped' AND (o.created_at>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR o.etd>=NOW()-INTERVAL '${ROLLING_DAYS} days') GROUP BY o.id,o.order_no) SELECT COUNT(*)::int AS cnt, ARRAY(SELECT okey FROM po WHERE a<=0 ORDER BY id LIMIT 5) AS samples FROM po WHERE a<=0`),
      pool.query(`SELECT COUNT(*)::int AS cnt, ARRAY(SELECT COALESCE(bl_no,'sp-'||id::text) FROM shipping_plans WHERE created_at>=NOW()-INTERVAL '3 days' AND (order_nos IS NULL OR cardinality(order_nos)=0) AND status NOT IN ('cancelled','archived') ORDER BY created_at DESC LIMIT 5) AS samples FROM shipping_plans WHERE created_at>=NOW()-INTERVAL '3 days' AND (order_nos IS NULL OR cardinality(order_nos)=0) AND status NOT IN ('cancelled','archived')`),
      pool.query(`SELECT COUNT(*)::int AS cnt, ARRAY(SELECT COALESCE(bl_no,'sp-'||id::text) FROM shipping_plans WHERE (etd>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR etd IS NULL) AND created_at<NOW()-INTERVAL '3 days' AND (order_nos IS NULL OR cardinality(order_nos)=0) AND status NOT IN ('cancelled','archived') ORDER BY id LIMIT 5) AS samples FROM shipping_plans WHERE (etd>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR etd IS NULL) AND created_at<NOW()-INTERVAL '3 days' AND (order_nos IS NULL OR cardinality(order_nos)=0) AND status NOT IN ('cancelled','archived')`),
      pool.query(`SELECT COUNT(*)::int AS cnt, ARRAY(SELECT COALESCE(bl_no,'sp-'||id::text) FROM shipping_plans WHERE (etd>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR status IN ('confirmed','ready','in_transit')) AND (gross_weight_kg IS NULL OR gross_weight_kg=0) AND status NOT IN ('cancelled','archived') ORDER BY id LIMIT 5) AS samples FROM shipping_plans WHERE (etd>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR status IN ('confirmed','ready','in_transit')) AND (gross_weight_kg IS NULL OR gross_weight_kg=0) AND status NOT IN ('cancelled','archived')`),
      pool.query(`SELECT COUNT(*)::int AS cnt, ARRAY(SELECT COALESCE(bl_no,'sp-'||id::text) FROM shipping_plans WHERE (etd>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR status IN ('confirmed','ready','in_transit')) AND (pol IS NULL OR pol='' OR pod IS NULL OR pod='') AND status NOT IN ('cancelled','archived') ORDER BY id LIMIT 5) AS samples FROM shipping_plans WHERE (etd>=NOW()-INTERVAL '${ROLLING_DAYS} days' OR status IN ('confirmed','ready','in_transit')) AND (pol IS NULL OR pol='' OR pod IS NULL OR pod='') AND status NOT IN ('cancelled','archived')`),
      pool.query(`SELECT COUNT(*)::int AS cnt, COUNT(*) FILTER (WHERE hs_code IS NOT NULL AND hs_code!='')::int AS has_hs FROM products WHERE (active IS NULL OR active!=false) AND (declaration_name IS NULL OR btrim(declaration_name)='')`),
    ]);

    const checks = {
      missing_company_code:              { count: r1.rows[0]?.cnt??0, samples: r1.rows[0]?.samples??[] },
      missing_trade_terms:               { count: r2.rows[0]?.cnt??0, samples: r2.rows[0]?.samples??[] },
      shipped_declare_amount_zero:       { count: r3.rows[0]?.cnt??0, samples: r3.rows[0]?.samples??[], tier:'P0' },
      bl_new_missing_order_link:         { count: r4.rows[0]?.cnt??0, samples: r4.rows[0]?.samples??[], tier:'P0' },
      bl_missing_order_link:             { count: r5.rows[0]?.cnt??0, samples: r5.rows[0]?.samples??[] },
      bl_missing_gross_weight:           { count: r6.rows[0]?.cnt??0, samples: r6.rows[0]?.samples??[] },
      bl_missing_pol_or_pod:             { count: r7.rows[0]?.cnt??0, samples: r7.rows[0]?.samples??[] },
      products_missing_declaration_name: { count: r8.rows[0]?.cnt??0, has_hs_code: r8.rows[0]?.has_hs??0, tier:'P1' },
    };
    const p0 = Object.values(checks).filter(c=>c.tier==='P0'&&c.count>0).length;
    const p1 = Object.values(checks).filter(c=>c.tier==='P1'&&c.count>0).length;
    const other = Object.values(checks).filter(c=>!c.tier&&c.count>0).length;
    return res.json({ ok:true, generated_at:new Date().toISOString(), elapsed_ms:Date.now()-t0, summary:{p0_alert:p0,p1_aggregate:p1,other,total_issues:p0+p1+other}, checks });
  } catch(err) {
    console.error('[data-health-check]', err.message);
    return res.status(500).json({ ok:false, error:err.message });
  }
}
