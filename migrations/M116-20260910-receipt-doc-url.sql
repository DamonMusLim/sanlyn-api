ALTER TABLE bank_slips
  ADD COLUMN IF NOT EXISTS receipt_doc_url TEXT;
