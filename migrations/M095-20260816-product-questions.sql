CREATE TABLE IF NOT EXISTS petstore_product_questions (
  id             bigserial PRIMARY KEY,
  product_code   text NOT NULL,
  field          text NOT NULL,
  question_type  text NOT NULL,
  current_value  text,
  proposed_value text,
  proposed_by    text,
  confidence     text,
  evidence       text,
  status         text NOT NULL DEFAULT 'pending_ocr',
  resolved_value text,
  resolved_by    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  CONSTRAINT petstore_product_questions_question_type_check CHECK (
    question_type IN (
      'SPEC_MISSING',
      'SPEC_ONLY_COUNT',
      'PETWEIGHT_AS_SPEC',
      'UNIT_TYPO',
      'BAD_CHAR',
      'SPEC_CONFLICT',
      'BRAND_MISSING',
      'PACK_UNCLEAR',
      'NAME_SUSPECT'
    )
  ),
  CONSTRAINT petstore_product_questions_status_check CHECK (
    status IN (
      'pending_ocr',
      'pending_damon',
      'resolved',
      'rejected',
      'no_source'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS petstore_product_questions_uniq
  ON petstore_product_questions (product_code, field, question_type);

CREATE INDEX IF NOT EXISTS petstore_product_questions_status_idx
  ON petstore_product_questions (status);

CREATE INDEX IF NOT EXISTS petstore_product_questions_product_code_idx
  ON petstore_product_questions (product_code);

COMMENT ON TABLE petstore_product_questions IS
'疑问产品队列：数据不全或疑似错误的商品先进队列，不直接改商品主数据。pending_ocr=有图片来源，等待图片OCR补建议；pending_damon=已有高置信建议，等待Damon确认后才能写回；resolved=Damon已确认并处理；rejected=Damon确认不采纳；no_source=无图或OCR读不到，无法自动补，需人工提供来源。流转：规则发现 -> pending_ocr/no_source/pending_damon；OCR成功 -> pending_damon；OCR UNKNOWN -> no_source；Damon确认 -> resolved/rejected。';

COMMENT ON COLUMN petstore_product_questions.product_code IS '商品编码。';
COMMENT ON COLUMN petstore_product_questions.field IS '疑问字段：spec_text / brand / product_name / barcode。';
COMMENT ON COLUMN petstore_product_questions.question_type IS '疑问类型枚举。';
COMMENT ON COLUMN petstore_product_questions.current_value IS '当前库里现值。';
COMMENT ON COLUMN petstore_product_questions.proposed_value IS '建议值；拿不到时保持 NULL，不用 UNKNOWN 冒充建议。';
COMMENT ON COLUMN petstore_product_questions.proposed_by IS '建议来源：rule / ocr / model_scan。';
COMMENT ON COLUMN petstore_product_questions.confidence IS '建议置信度：高 / 中 / 低。';
COMMENT ON COLUMN petstore_product_questions.evidence IS '依据：图片URL、模型原文、规则名等。';
COMMENT ON COLUMN petstore_product_questions.status IS 'pending_ocr=等待OCR；pending_damon=等待Damon确认；resolved=已确认处理；rejected=已拒绝；no_source=无可用来源，需人工确认。';
