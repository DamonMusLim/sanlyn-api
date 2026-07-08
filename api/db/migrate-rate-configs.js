// migrate-rate-configs.js — 税率/汇率配置库（可编辑+改动留痕）
// domain: tax_service(海运/港杂/拖车/报关) | tax_product(宠物食品/用品/包材/配件) | fx(汇率)
// 种子值取自现有真实代码 taxRates.js（SERVICE_TAX/PRODUCT_TAX），不新造类目。
// Idempotent. Trigger: curl -X POST https://api.sanlyn.cn/api/db/migrate-rate-configs
import { getPool, setCors } from "../db.js";

const SQL = `
CREATE TABLE IF NOT EXISTS rate_configs (
  id           SERIAL PRIMARY KEY,
  domain       TEXT NOT NULL CHECK (domain IN ('tax_service','tax_product','fx')),
  key          TEXT NOT NULL,
  label        TEXT,
  rate_value   NUMERIC NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  updated_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(domain, key)
);
CREATE INDEX IF NOT EXISTS idx_rate_configs_domain ON rate_configs(domain);

CREATE TABLE IF NOT EXISTS rate_config_history (
  id           SERIAL PRIMARY KEY,
  config_id    INTEGER REFERENCES rate_configs(id) ON DELETE CASCADE,
  domain       TEXT,
  key          TEXT,
  old_value    NUMERIC,
  new_value    NUMERIC,
  changed_by   TEXT,
  note         TEXT,
  changed_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rate_config_history_config ON rate_config_history(config_id);
`;

// 种子：taxRates.js 现有真实值（P1 前端收口的那份），非编造。
const SEED = [
  { domain: "tax_service", key: "ocean",        label: "海运", rate_value: 0,     note: "出口免税" },
  { domain: "tax_service", key: "port",          label: "港杂", rate_value: 0.06,  note: null },
  { domain: "tax_service", key: "trucking",      label: "拖车", rate_value: 0.09,  note: null },
  { domain: "tax_service", key: "customs",       label: "报关", rate_value: 0.06,  note: null },
  { domain: "tax_product", key: "food",          label: "宠物食品(干/湿/零食)", rate_value: 0,    note: "退税率9%另记" },
  { domain: "tax_product", key: "pet_supplies",  label: "宠物用品",            rate_value: 0.13, note: null },
  { domain: "tax_product", key: "bags",          label: "包材",                rate_value: 0.13, note: null },
  { domain: "tax_product", key: "acc",           label: "配件",                rate_value: 0.13, note: "退税率13%" },
  { domain: "fx",          key: "USD/CNY",       label: "美元兑人民币",         rate_value: 6.90, note: "初始种子值，请按当期汇率核实调整" },
];

export default async function handler(req, res) {
  setCors(req, res, "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!["POST", "GET"].includes(req.method)) return res.status(405).json({ error: "POST or GET only" });

  try {
    const pool = getPool();
    await pool.query(SQL);
    for (const s of SEED) {
      await pool.query(
        `INSERT INTO rate_configs (domain, key, label, rate_value, note, updated_by)
         VALUES ($1,$2,$3,$4,$5,'migration_seed')
         ON CONFLICT (domain, key) DO NOTHING`,
        [s.domain, s.key, s.label, s.rate_value, s.note]
      );
    }
    const counts = await pool.query(`
      SELECT domain, COUNT(*) AS n FROM rate_configs GROUP BY domain ORDER BY domain
    `);
    return res.status(200).json({ success: true, message: "rate_configs ready", counts: counts.rows });
  } catch (err) {
    console.error("[migrate-rate-configs]", err);
    return res.status(500).json({ error: err.message });
  }
}
