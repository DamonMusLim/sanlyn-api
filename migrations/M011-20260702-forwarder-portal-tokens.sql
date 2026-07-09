CREATE TABLE IF NOT EXISTS forwarder_portal_tokens (
  code text PRIMARY KEY,
  forwarder_co text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);
