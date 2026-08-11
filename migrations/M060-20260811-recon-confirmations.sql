-- M060: 对账对平状态(只留痕不碰金额)
CREATE TABLE IF NOT EXISTS recon_confirmations(
  id bigserial PRIMARY KEY,
  ticket_key text NOT NULL,
  ledger text NOT NULL CHECK (ledger IN ('product','freight')),
  status text NOT NULL DEFAULT '未核' CHECK (status IN ('未核','待补资料','已对平','需人工确认')),
  note text,
  confirmed_by text,
  confirmed_at timestamptz DEFAULT now(),
  UNIQUE(ticket_key, ledger)
);
