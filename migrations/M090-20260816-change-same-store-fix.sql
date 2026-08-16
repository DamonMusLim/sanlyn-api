-- 修：变动必须限定同一家店 + 同一规格，否则把店间价差当成涨跌。
-- 实测：不限店 26 条报价能配到「上次」，限同店只剩 11 条 —— 15 条是跨店误配，
-- 已导致 dry-run 产出假的 PRICE_UP=3 / PRICE_DOWN=6。
-- ⚠️ 本文件由脚本从线上 pg_get_viewdef 取出后只插入两个 WHERE 条件，
--    输出列名与顺序一个未动（codex 那版多加了输出列，CREATE OR REPLACE 直接拒绝）。
CREATE OR REPLACE VIEW petstore_market_quote_change_current AS
SELECT q.id AS quote_id,
    prev.quote_id AS prev_quote_id,
    prev.price AS market_price_prev,
        CASE
            WHEN prev.price IS NULL THEN NULL::numeric
            ELSE round(q.price - prev.price, 2)
        END AS market_price_delta,
        CASE
            WHEN prev.price IS NULL OR prev.price = 0::numeric THEN NULL::numeric
            ELSE round((q.price - prev.price) / prev.price * 100.0, 2)
        END AS market_price_delta_pct,
        CASE
            WHEN prev.price IS NULL THEN NULL::integer
            WHEN q.price = prev.price THEN q.captured_at::date - prev.captured_at::date
            ELSE 0
        END AS market_days_unchanged
   FROM petstore_market_quotes q
     LEFT JOIN LATERAL ( SELECT h.quote_id,
            h.price,
            h.captured_at
           FROM petstore_market_quote_history h
          WHERE h.product_code = q.product_code AND h.rule_version = q.rule_version AND h.captured_at::date < q.captured_at::date AND COALESCE(h.store_name, ''::text) = COALESCE(q.store_name, ''::text) AND COALESCE(h.spec_text, ''::text) = COALESCE(q.spec_text, ''::text)
          ORDER BY h.captured_at DESC, h.id DESC
         LIMIT 1) prev ON true;
