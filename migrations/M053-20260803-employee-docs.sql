-- M053 · 员工凭据柜：一个人名下所有文件都挂这里
--
-- 0803 Damon：「少了身份证文件、合同等等的数据信息，还有以后我们会有员工的数据？凭据。」
--
-- 之前是 hr_employees 上三个写死的列（id_card_file / id_card_back_file / contract_file）。
-- 每多一种文件就要 ALTER TABLE + 改代码 —— 培训协议、体检报告、奖惩单、承诺书、
-- 离职证明、社保缴纳凭证… 这么加下去必然失控。改成一张通用表，kind 不限。

CREATE TABLE IF NOT EXISTS hr_employee_docs (
  id            SERIAL PRIMARY KEY,
  company_code  TEXT NOT NULL,
  employee_id   INTEGER NOT NULL REFERENCES hr_employees(id),
  kind          TEXT NOT NULL,          -- 见下面 COMMENT
  title         TEXT,                   -- 人看的名字，空则用 kind 的中文
  file_path     TEXT NOT NULL,          -- 相对 /opt/sanlyn-private/hr/ 的路径，如 36/contract_1234.jpg
  mime          TEXT,
  bytes         INTEGER,
  valid_from    DATE,                   -- 合同/证件的有效期，到期能提前提醒
  valid_to      DATE,
  note          TEXT,
  source        TEXT NOT NULL DEFAULT 'admin',   -- admin(店长传) | staff_app(员工自己传)
  uploaded_by   TEXT,                   -- 登录账号；员工自己传的记 'self:<employee_id>'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ,            -- 作废用归档，**绝不物理删除**
  archived_by   TEXT,
  archive_note  TEXT
);

CREATE INDEX IF NOT EXISTS idx_hr_docs_emp  ON hr_employee_docs(employee_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_docs_live ON hr_employee_docs(company_code, kind) WHERE archived_at IS NULL;

COMMENT ON TABLE  hr_employee_docs IS
  '员工凭据柜。一个人名下所有文件都挂这里，kind 不设 CHECK —— 以后加新类型不用改表。
   🔒 文件一律落 /opt/sanlyn-private/hr/<employee_id>/，绝不进 /opt/sanlyn-uploads（那是公开可读的）。
   🔒 只增不删：作废走 archived_at，凭据的价值就在于能追溯。';
COMMENT ON COLUMN hr_employee_docs.kind IS
  'id_card_front 身份证人像面 | id_card_back 身份证国徽面 | contract 劳动合同 |
   training_agreement 培训服务期协议 | health_cert 健康证 | award 奖励 | penalty 处分 |
   resignation 离职证明 | social_insurance 社保凭证 | other 其他。不设 CHECK，随时可加。';
COMMENT ON COLUMN hr_employee_docs.archived_at IS '作废时间。归档不删文件 —— 仲裁时「当时交的是哪一版」比「现在是哪一版」更重要。';

-- 把 hr_employees 上那三个老列的内容搬进来（目前都是空的，但把路铺好）
INSERT INTO hr_employee_docs (company_code, employee_id, kind, file_path, source, uploaded_by, note)
SELECT company_code, id, 'id_card_front', id_card_file, 'admin', 'migrated', '从 hr_employees.id_card_file 迁入'
  FROM hr_employees WHERE id_card_file IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM hr_employee_docs d WHERE d.employee_id=hr_employees.id AND d.kind='id_card_front');
INSERT INTO hr_employee_docs (company_code, employee_id, kind, file_path, source, uploaded_by, note)
SELECT company_code, id, 'id_card_back', id_card_back_file, 'admin', 'migrated', '从 hr_employees.id_card_back_file 迁入'
  FROM hr_employees WHERE id_card_back_file IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM hr_employee_docs d WHERE d.employee_id=hr_employees.id AND d.kind='id_card_back');
INSERT INTO hr_employee_docs (company_code, employee_id, kind, file_path, valid_from, valid_to, source, uploaded_by, note)
SELECT company_code, id, 'contract', contract_file, contract_start, contract_end, 'admin', 'migrated', '从 hr_employees.contract_file 迁入'
  FROM hr_employees WHERE contract_file IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM hr_employee_docs d WHERE d.employee_id=hr_employees.id AND d.kind='contract');

-- 老列**保留不动**：一堆地方在读 has_id_card / has_contract，
-- 它们现在的含义是「当前有效的那一份的快捷指针」，完整历史看 hr_employee_docs。
COMMENT ON COLUMN hr_employees.id_card_file IS '当前有效那份的快捷指针；完整历史见 hr_employee_docs(kind=id_card_front)。';
COMMENT ON COLUMN hr_employees.contract_file IS '当前有效那份的快捷指针；完整历史见 hr_employee_docs(kind=contract)。';
