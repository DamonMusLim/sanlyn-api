ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_license_no text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_license_url text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS biz_contact_name text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS biz_contact_phone text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS biz_contact_email text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fin_contact_name text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fin_contact_phone text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS profile_locked boolean DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS profile_locked_at timestamptz;
