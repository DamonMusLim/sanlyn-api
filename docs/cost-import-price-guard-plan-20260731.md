# 海运成本带入与历史价守卫方案 2026-07-31

## 0. 目标与边界

本方案只处理编辑器「4成本」里的“成本/销售对比(整票)”面板和“按航线带入成本(运价表+港杂表)”链路。目标是让成本从现有知识库真读出来、匹配不到时形成缺口、带入时用历史价守卫提示异常，并把销售价改为拆件确认流。

本轮不写业务代码、不迁移、不连库执行数据修复。实现阶段仍需按 AGENTS.md 做每个文件写前 `wc -l`，且单文件不超过 500 行。

必须焊死的口径：

- 成本只读锁定；只来自 `local_charges`、`freight_rates`、货代账单/历史账单等既有真源。
- 不造数；匹配不到显示缺口并进入催补，不写 0、不用 `Number(null)===0`。
- 港杂代收代付，`sell=cost`，仅限港杂件。
- 海运销售价不自动按成本兜底，必须走固定价、DNA 建议或人工确认。
- 历史价守卫只提示和拦“静默通过”，不自动改价。
- 所有比较用每柜口径；整票合计只用于展示汇总。

## 1. 现状判断

已知数据源：

- `local_charges`：港杂标准费率，26 条，按 POL/POD/carrier/container_type 维护，`cost_total == sell_total`。
- `freight_rates`：海运运价，85 条，`gp20`/`hq40` 为成本，`customer_gp20`/`customer_hq40` 为旧销售价字段。
- `freight_port_rates`：港杂另一张表，80 条，先不作为首选真源；可作为诊断补充或后续归并来源。
- `freight_rates_history`：运价变更历史，165 条。
- `freight_supplier_bills`：货代账单，2885 行/230 票。
- `active_freight_supplier_bills`：有效货代账单视图，可按 `cost_category` 看历史 `unit_price` 区间。
- `ocean_sale_prices`、`ocean_sale_price_dna`：M043 新建销售价拆件表和 DNA 建议表。

当前问题不是“没数据”，而是编辑器带入链路没有把知识库按可用规则接进面板；严格匹配又被空 `container_type`/`carrier` 和 POD 粒度差异打断。

实现阶段需要特别处理一个现有冲突：`api/db/freight-cost-audit.js` 当前 POST `set_par` 会把 `freight_supplier_bills.sale_amount` 置为 `cost_amount`。这与“绝不拿成本当售价兜底”冲突，应废弃该动作、加保护或迁移到只读诊断，不允许新面板再调用。

## 2. A: 带入成本真读知识库

### 2.1 输入归一

带入成本端点输入来自当前 shipping plan/editor：

- `shipping_plan_id` 或 `bl_no`：用于取 shipment 上下文和已有账单。
- `pol`、`pod`：航线。
- `carrier`：优先计划字段；为空时可用 BL 前缀推断作为弱信号，但结果必须标“carrier_inferred”。
- `container_type`、`container_qty`：柜型和柜数；柜型为空时不猜，只能退到不含柜型的匹配层，结果标“container_type_missing”。
- `customer_company_code`：销售价查找使用。

归一规则：

- 字符串统一 `trim`、折叠连续空格、大小写不敏感。
- carrier 走现有 `carriers`/`carrier_aliases` 归一，保留 raw 和 canonical code。
- 柜型归一到 `20GP`、`40HQ` 两个主要价键；`40HC`/`HQ40`/`40 HQ` 归为 `40HQ`，`20`/`GP20` 归为 `20GP`。无法归一则视为缺柜型。
- POD 先做港口族归一：`Port Klang`、`Port Klang Westport`、`Westport`、`Northport`、`Port Klang North` 统一到 `PORT_KLANG_FAMILY`，同时保留原始 POD 用于精确优先。

### 2.2 港杂 local_charges 匹配降级

港杂成本首选 `local_charges`，按每柜金额返回；港杂销售列等于成本列，但必须标明“港杂代收代付”。

匹配链：

1. 精确 4 键：`pol_norm + pod_norm + carrier_norm + container_type_norm`。
2. POD 家族 4 键：`pol_norm + pod_family + carrier_norm + container_type_norm`。
3. 退 carrier：`pol_norm + pod_norm + container_type_norm`。
4. 退 carrier + POD 家族：`pol_norm + pod_family + container_type_norm`。
5. 退柜型：`pol_norm + pod_norm`，仅当候选行的 `cost_total` 对不同柜型一致，或 UI 标“柜型缺失/不确定，需人工确认”。
6. 退柜型 + POD 家族：`pol_norm + pod_family`，同样要求金额一致或人工确认。

选择规则：

- 每一层只要出现唯一可信候选就停止。
- 同一层多候选且金额一致，可采用，source 标 `loose_same_amount`。
- 同一层多候选且金额不同，不采用，返回候选列表并红标“港杂费率多候选·待确认”。
- `is_active=false` 或作废行不参与。
- 结果必须返回 `match_level`、`source_table`、`source_id/charge_code`、`confidence`、`warnings`，便于 UI 展示为什么能带入。

缺失处理：

- 匹配不到显示红标“缺该航线港杂费率·待录”。
- 同步给 shipment-completeness 形成缺口维度，建议维度名 `local_charge_rate`，owner 为货代/物流部。
- 不写 shipping plan 成本字段，不写 0，只返回可采用建议。

### 2.3 海运 freight_rates 匹配降级

海运成本首选 `freight_rates.gp20/hq40`，按柜型取每柜成本；币种使用 `freight_rates.currency`，默认不得假定 CNY。

匹配链：

1. 精确：`pol_norm + pod_norm + carrier_norm + container_type_norm`，且 `status != withdrawn`，`valid_to` 未过期优先。
2. POD 家族：`pol_norm + pod_family + carrier_norm + container_type_norm`。
3. 退 carrier：`pol_norm + pod_norm + container_type_norm`，只在同路线同柜型仅一个有效供应价或多候选价格一致时采用。
4. 退 carrier + POD 家族：同上。

排序规则：

- 有效期内优先于过期；`valid_from` 最近优先；`updated_at` 最近优先。
- 多个货代/船司同层候选价格不同，不自动选择最低价；返回候选和红标“多运价候选·待选”。
- 如果只有 `gp20`/`hq40` 其一有值，按柜型取值；缺对应柜型不跨柜型折算。

带入结果：

- 成本行 `fee_item=ocean`，`unit_cost=gp20|hq40`，`quantity=container_qty`，`total_cost=unit_cost*quantity`。
- 如果 `container_qty` 为空，展示每柜成本但整票合计留空，红标“缺柜数·不能汇总”。
- 销售列不读 `customer_gp20/customer_hq40` 作为兜底；旧字段仅可在迁移/回填 DNA 时作为历史参考，不能直接填新单销售价。

## 3. B: 历史价守卫

### 3.1 比较对象

每条本次成本建议都生成一个 guard input：

- key：`pol_family/pol_norm + pod_family/pod_norm + carrier_norm + fee_item + container_type_norm`。
- amount：每柜成本。
- currency：原币种。
- quantity：柜数，仅用于整票展示，不用于历史比较。
- source：`local_charges`、`freight_rates`、`freight_supplier_bills` 或人工账单行。

历史样本来源优先级：

1. `active_freight_supplier_bills`：同航线/船司/费用件的真实账单 `unit_price`，排除作废账单。
2. `freight_supplier_bills`：补充 `unit_price` 为空但能由金额/柜数安全算出的历史，算不出则跳过。
3. `freight_rates_history`：海运费报价历史，用于 ocean 件；港杂不用它替代 `local_charges`。
4. `local_charges_history` 如实现阶段确认存在且结构稳定，可用于港杂历史；否则只用当前 `local_charges` + 账单历史。

### 3.2 归一口径

- 单位统一为每柜价格；账单整票金额必须除以明确柜数，柜数缺失则样本不进入统计。
- 币种不混比。优先同币种样本；跨币种只有在存在明确 `exchange_rates` 日期汇率时才折 CNY，并标 `fx_converted`。
- 费用件归一：`ocean`、`port_charge`、`thc`、`doc`、`seal`、`vgm`、`customs`、`trucking`、`other`。本面板第一期至少覆盖 `ocean` 和 `port_charge`。
- 港杂如果 `local_charges.fees` 内有拆项，历史守卫可按 `port_charge` 总件比；后续再拆到 THC/doc/seal 等子件。

### 3.3 统计与阈值

每个 guard input 拉最近 24 个月历史样本，最多 100 条，计算：`count`、`median`、`avg`、`min`、`max`、`p75`、最近一次价格。

阈值建议：

- 默认红标：本次每柜价 `> max(history)`。
- 默认红标：本次每柜价 `> median * 1.2`，即高于历史中位数 20%。
- 黄标：本次每柜价 `> median * 1.1` 且 `<= median * 1.2`。
- 低价提示：本次每柜价 `< median * 0.8`，标“低于历史均价，确认是否捡漏/口径不同”。
- 港杂可用更严阈值：因 Damon 已定“每家公司港杂价一样”，同航线港杂 `> median * 1.05` 即黄标，`> median * 1.1` 或 `> max` 红标。

样本不足：

- `count >= 5`：可给红/黄结论。
- `count 3-4`：可提示异常，但文案加“样本较少”。
- `count < 3`：不判乱加价，只标“历史不足·仅供参考”，仍展示历史来源明细。

UI 文案：

- 红标：“高于历史中位数 23%，历史中位 ¥1,428/柜，本次 ¥1,760/柜，疑似乱加价”。
- 高于 max：“高于历史最高价，历史最高 ¥1,600/柜，本次 ¥1,760/柜”。
- 样本不足：“历史不足 2 条，仅供参考；请人工确认”。
- 低价：“低于历史中位数 22%，确认是否费用件缺项或供应商漏收”。

守卫动作：

- 带入成本可以展示，但红标项不得静默写入确认态。
- 报价确认时若仍有红标，要求人工勾选“已核历史异常”并写入 audit log。
- 不自动改成本、不自动压价、不自动生成对外通知。

## 4. C: 销售价填充与确认

销售列取价优先级：

1. `ocean_sale_prices` 固定价：同 `customer_company_code + pol/pod family + container_type + fee_item`，且当前 BL/plan 已有确认记录时优先展示，标“固定价·客户名/客户码”。
2. `ocean_sale_price_dna` 建议：同客户、航线、柜型、费用件，`sample_count >= 3` 时显示建议金额，标“DNA建议·N次历史”；`sample_count < 3` 仅展示参考，不自动填。
3. 留空：显示“待你定”。

禁止项：

- 不用 `freight_rates.customer_gp20/customer_hq40` 直接填新销售列，除非先经过迁移成 `ocean_sale_price_dna` 或人工确认成 `ocean_sale_prices`。
- 不用成本兜底销售价。现有 `freight-cost-audit` 的 `set_par` 应在新链路禁用。
- 港杂 `sell=cost` 只适用于 `fee_item=port_charge`，并标“代收代付”；不能扩展到海运费、拖车、报关或其他件。

确认写入：

- Damon/授权财务确认后，按 `bl_no + fee_item` upsert `ocean_sale_prices`。
- 写入字段包括 `cost_amount/cost_currency` 只读快照、`sale_amount/sale_currency`、`source=manual|dna_adopted`、`effective_date`、`created_by`。
- 确认成功后 UI 第三排显示“已确认”，并展示成本、售价、毛利。
- DNA 更新应异步或后台聚合，不能在用户确认时用复杂统计拖慢主流程。

## 5. 建议端点与涉及文件

后端建议：

- 新增或扩展 `api/db/freight-cost-audit.js`：GET 增加 `action=quote_context|import_cost_preview`，返回成本建议、历史守卫、销售价建议。实现前先拆小函数，避免文件超过 500 行。
- 新增 helper，如 `api/db/lib/freight-cost-import.js`：承载归一、匹配降级、历史统计，供端点调用。
- 如需要销售价确认，新增 `api/db/ocean-sale-prices.js` 或在 freight-cost-audit 内只保留薄端点，实际 SQL 放 helper。
- 复用 `api/db/freight-board.js` 里的 carrier 归一思路，但不要复制大段 SQL 到大文件；抽公共归一 helper 更稳。
- 复用 `api/db/shipment-completeness.js` 缺口维度，新增缺费率信号，不重造任务表。

前端建议：

- admin-v1 `LogisticsOrderEditor` 的「4成本」面板：按钮调用 preview 端点，展示分 fee_item 行。
- 面板每行显示：费用件、成本来源、匹配层级、每柜成本、柜数、整票成本、销售价来源、销售价、毛利、历史守卫 badge。
- 红标项置顶或在合计旁显示风险数；销售价为空时合计销售和毛利保持 `--`，不要显示 0.00 造成误读。

数据/迁移：

- M043 已建 `ocean_sale_prices` 与 `ocean_sale_price_dna`，第一期不新增表。
- 如果实现阶段发现缺 audit 字段或唯一键不够，再单独出幂等迁移，不能在业务补丁里裸改表。

## 6. 风险与边界

- POD 粒度风险：Port Klang 家族可提升命中，但 Westport/Northport 可能存在真实差价；退 family 后必须标匹配层级，不应伪装成精确。
- carrier 缺失风险：BL 前缀推断不是财务真值，只能弱采用；多候选不同价必须人工确认。
- 柜型缺失风险：不能用 40HQ 价格折 20GP，不能跨柜型猜；只能展示候选或缺口。
- 币种风险：历史比较不能把 USD/CNY 账面数直接混在一起；无汇率就不跨币种判价。
- 柜数风险：整票账单没有可靠柜数时不能进入每柜历史样本。
- 费用件命名风险：`cost_category` 文本可能脏，需要 alias 表或代码映射；未映射的只能归 `other` 并不参与严格守卫。
- 旧销售价风险：`customer_gp20/customer_hq40` 可能混有成本兜底历史，不能无审计直接当固定售价。
- 文件体积风险：`freight-cost-audit.js` 当前虽小，但若把 SQL/算法全塞进去容易超过 500 行；实现必须拆 helper。
- 权限风险：成本和毛利只能 internal/admin/finance 可见；对外协同 payload 不得带成本列。

## 7. 分期建议

### Phase 1: 成本带入治空面板

- 做 preview 端点，只读 `local_charges` + `freight_rates`。
- 实现 POL/POD/carrier/container_type 归一和匹配降级。
- UI 展示成本来源、匹配层级、缺口红标。
- 不写 `ocean_sale_prices`，不改现有账单。

验收：有航线的票不再整面板全 `--`；匹配不到明确显示“缺该航线费率·待录”。

### Phase 2: 历史价守卫

- 接入 `active_freight_supplier_bills`、`freight_supplier_bills`、`freight_rates_history`。
- 每柜口径统计 median/max/样本数。
- UI 展示红黄标、样本不足、低价提示。
- 红标项确认时要求人工确认原因并写 audit log。

验收：同航线同船司费用件明显高于历史时给出“疑乱加价”文案和历史数值。

### Phase 3: 销售价拆件填充

- 接 `ocean_sale_prices` 固定价和 `ocean_sale_price_dna` 建议。
- 销售列按固定价、DNA、待你定三级展示。
- 人工确认后 upsert `ocean_sale_prices`，回填面板“已确认”。
- 禁用或隔离 `set_par` 成本等于售价旧动作。

验收：销售价为空时不显示 0.00；没有固定价/DNA 时明确“待你定”；确认后形成拆件销售价记录。

## 8. 实现前检查清单

- 确认 admin-v1 `LogisticsOrderEditor` 目标文件行数，若接近 500 行先拆组件。
- 确认 `api/db/freight-cost-audit.js` 行数，若算法会膨胀则新增 `api/db/lib/freight-cost-import.js`。
- 确认 `local_charges` 当前字段名：`is_active`、`charge_code`、`fees`、`cost_total`、`sell_total` 是否在 live 表都存在。
- 确认 `freight_supplier_bills`/`active_freight_supplier_bills` 可取得路线、船司、费用件、unit_price、currency、柜数；缺字段则只能降级到部分守卫。
- 确认 M043 已在目标环境执行，否则销售价阶段只能返回建议，不能写确认。
