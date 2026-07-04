CREATE TABLE IF NOT EXISTS ocean_doc_overrides(
  ref_no      text NOT NULL,
  doc_kind    text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  seal_url    text,
  seal_name   text,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(ref_no, doc_kind)
);
