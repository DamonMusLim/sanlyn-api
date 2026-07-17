ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS revoked boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_magic_links_fwd_portal_company
  ON magic_links (((meta->>'company_id')::int), created_at DESC)
  WHERE recipient_role = 'fwd_portal';
