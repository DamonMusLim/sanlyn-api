-- D20260628 数据修正留痕(审计用,已于2026-06-28在线上执行,勿重跑)
-- 不被 apply-migrations.js 扫描(runner只跑 migrations/M*.sql)。
-- 每条:目的/来源/操作人(Claude+Damon授权)/影响行数。

-- A. 公司合并去重(4对工厂,旧码→canonical,迁orders/products引用+写别名+merged_into_code)
--    影响: companies merged_into_code 4行; orders.factory_code 12行; products.factory_code 100行
UPDATE companies SET merged_into_code='VEN-LL'  WHERE code='LL';
UPDATE companies SET merged_into_code='VEN-ZC'  WHERE code='zc-oem';
UPDATE companies SET merged_into_code='VEN-TY'  WHERE code='TY';
UPDATE companies SET merged_into_code='YBT'     WHERE code='FAC-022';
-- (orders/products 引用迁移 + company_aliases 写入 当日已执行,详见 entity_resolution 治理记录)

-- B. 7票"成本整票vs售价每柜"假亏修正: freight_sale_usd 改成整票口径(×柜数)
--    影响: shipping_plans 7行(TACM50066000/PASUQ079488440/I240423741/ONEYXMNFF4015400/
--          ESLCHNQIN064737/COAU7264448600/COAU7264382130)
-- UPDATE shipping_plans SET freight_sale_usd = freight_sale_usd*container_qty
--   WHERE container_qty>1 AND freight_cost IS NOT NULL AND freight_sale_usd IS NOT NULL
--     AND freight_sale_usd < freight_cost AND freight_sale_usd*container_qty >= freight_cost;
-- (已执行;此处注释保留口径,勿重跑——重跑会再乘一次柜数)

-- C. CY00388(BL UASTAOPKG2604086)脏数据修正:
--    作废4条(2条江苏海邦当货代/旧海运qty错/旧港杂打包),重录海运$1800→CN-00048客户、
--    港杂拆14项明细→HBN工厂;后又把港杂qty/计费单位改对、海运unit_price=900/sale_amount=1840。
--    影响: freight_supplier_bills 该BL约20行(作废+新增明细)。已执行,勿重跑。

-- D. 海运空incoterm回填: 从shipping_plans.freight_term补freight_supplier_bills.incoterm
--    影响: 38行(海运费,FOB33/EXW3/CNF2)。已执行。

-- 注: 数据修正不进 schema_migrations 跟踪(它们是一次性业务事件,非环境结构)。
--     如需可审计,P2 建 data_change_audit 表正式登记。
