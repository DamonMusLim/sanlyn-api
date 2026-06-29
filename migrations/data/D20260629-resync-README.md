# D20260629 订单双源分叉根治 — resync 记录

代码: syncOrderFromOLI (commit 733ce76) 以 OLI 为唯一真值重算 orders 缓存列 + 重建 raw.products,接进 OLI 增删改路径。
数据:
- D20260629  : 40-XM-1(1220) OLI小计重算 + plan437聚合
- D20260629b : 12单干净stale小计对齐
- D20260629c : OLI退税率/增值税率回填(customs_hs_authority按8位HS + 2309系=9%; vat=0.13)
- resync     : 84单经syncOrderFromOLI重算(order_ids见git log),仅含divergent+OLI完整(行数=raw.products)+退税率已补+排除6单录入烂账+8单非食品HS待核。

已验证: 申报值/客户销售额/退税额(9%)/箱数/重量全部与OLI一致;40-XM-1从你按钮实测采购82420→71500、退税7417.8→6435。
注意:
- factory_amount/采购列对~61单不可靠 = 工厂成本系统性未录(OLI.factory_price=占位2.6或空,resync前后值相同,非本次引入)。独立问题。
- 待人工: 8单非食品HS退税率(3926/3924/732490/73239900/4201/6307); 6单录入烂账(37-ZC-20/37-ZC-16/40-PBXCD/48-CL-10/32-PBLSQ/40-CP-2)。
- resync未备份orders表(幂等重算,结果已逐项验证正确)。
