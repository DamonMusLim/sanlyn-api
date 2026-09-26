-- companies.cc_emails + mail_outbox 自动抄送(2026-09-25 Damon:「加抄送栏,自动邮件也抄送」)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cc_emails text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN companies.cc_emails IS '发给该公司的邮件一律抄送这些地址(Damon 2026-09-25)。mail_outbox 触发器按收件人邮箱匹配公司后自动补进 cc_emails;人名等内部备注写 notes,不在此列';

CREATE OR REPLACE FUNCTION mail_outbox_add_company_cc() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_add jsonb;
BEGIN
  IF NEW.to_emails IS NULL OR jsonb_typeof(NEW.to_emails) <> 'array' OR jsonb_array_length(NEW.to_emails) = 0 THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.to_emails IS NOT DISTINCT FROM OLD.to_emails THEN
    RETURN NEW;
  END IF;
  -- 只给草稿补,已发出的不动
  IF coalesce(NEW.status,'draft') <> 'draft' THEN
    RETURN NEW;
  END IF;

  WITH to_list AS (
    SELECT lower(trim(v)) e FROM jsonb_array_elements_text(NEW.to_emails) v
  ), have AS (
    SELECT e FROM to_list
    UNION SELECT lower(trim(v)) FROM jsonb_array_elements_text(coalesce(NEW.cc_emails,'[]'::jsonb)) v
  ), hit AS (
    SELECT DISTINCT c.id, c.cc_emails FROM companies c
    WHERE cardinality(c.cc_emails) > 0 AND coalesce(c.active, true)
      AND EXISTS (
        SELECT 1 FROM regexp_split_to_table(concat_ws(',', c.contact_email, c.biz_contact_email, c.fin_contact_email, c.einvoice_email), '[,;[:space:]]+') ce
        WHERE lower(trim(ce)) IN (SELECT e FROM to_list) AND trim(ce) <> '')
  ), cand AS (
    SELECT DISTINCT lower(trim(x)) e FROM hit, unnest(hit.cc_emails) x WHERE trim(x) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  )
  SELECT jsonb_agg(e ORDER BY e) INTO v_add FROM cand WHERE e NOT IN (SELECT e FROM have);

  IF v_add IS NOT NULL THEN
    NEW.cc_emails := coalesce(NEW.cc_emails, '[]'::jsonb) || v_add;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_mail_outbox_company_cc ON mail_outbox;
CREATE TRIGGER trg_mail_outbox_company_cc BEFORE INSERT OR UPDATE OF to_emails ON mail_outbox
  FOR EACH ROW EXECUTE FUNCTION mail_outbox_add_company_cc();

UPDATE companies SET cc_emails = ARRAY['568622322@qq.com'] WHERE id = 42 AND code = 'VEN-LL';
