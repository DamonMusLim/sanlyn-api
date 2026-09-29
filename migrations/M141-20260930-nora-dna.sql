-- M141-20260930 nora_dna_cases / nora_rules:Nora 的「DNA 先例」
-- (Damon 0930:「有 dna 处理么?以后一些问题,类似的就不用问我了」)
--   nora_dna_cases:boss_decide_batch 每拍一条写一行(Nora 建议 + Damon 决定 + 当时商品事实快照),
--     facts 里带 batch_id,boss_undo 撤销时按 facts->>'batch_id' 填 revoked_at;
--     boss_note 补的话写进最近一条同 task 未撤销 case 的 damon_note,没有则新建 damon_decision=null 的 case。
--   nora_rules:老板定过的规矩,按 product/brand/category 三档 scope;~/wt-nora-review/nora-review.mjs
--     命中后拼进 Nora 的 prompt(段名「=== 老板定过的规矩 ===」)。category 暂无数据源,通道先留。
--   消费方:hr-bossdesk.mjs 写入、~/wt-nora-review/nora-review.mjs 读取(同码最新 1 条,
--     或同 brand+kind ≥2 条且 damon_decision 全部一致 → 不升 Damon,交 claude,source='nora-dna')。
-- ⛔ 本文件只建表+索引,不改任何现有表结构;只落文件,跑库由部署流程管(本单不执行)。

CREATE TABLE IF NOT EXISTS nora_dna_cases (
  id             bigserial primary key,
  task_id        text,
  kind           text,
  product_code   text,
  brand          text,
  category       text,
  nora_decision  text,
  nora_reason    text,
  damon_decision text,
  damon_note     text,
  facts          jsonb,
  decided_at     timestamptz default now(),
  revoked_at     timestamptz
);

CREATE TABLE IF NOT EXISTS nora_rules (
  id         bigserial primary key,
  scope_type text check (scope_type in ('product','brand','category')),
  scope_key  text,
  text       text not null,
  source     text default 'damon',
  created_at timestamptz default now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_nora_dna_cases_product_code ON nora_dna_cases (product_code);
CREATE INDEX IF NOT EXISTS idx_nora_dna_cases_brand_kind   ON nora_dna_cases (brand, kind);
CREATE INDEX IF NOT EXISTS idx_nora_rules_scope            ON nora_rules (scope_type, scope_key);
