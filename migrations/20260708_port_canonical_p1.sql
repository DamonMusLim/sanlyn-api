-- Port canonicalization P1: metadata, nullable plan links, and alias seeds.
-- Idempotent and safe to rerun. Does not backfill or change existing read paths.

ALTER TABLE ports ADD COLUMN IF NOT EXISTS parent_port_id int REFERENCES ports(id);
ALTER TABLE ports ADD COLUMN IF NOT EXISTS requires_terminal boolean DEFAULT false;

UPDATE ports
   SET parent_port_id = (SELECT id FROM ports WHERE code = 'MYPKG')
 WHERE code IN ('MYPKGW', 'MYPKGN')
   AND parent_port_id IS NULL;

UPDATE ports SET requires_terminal = true WHERE code = 'MYPKG';

ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS pol_port_id int REFERENCES ports(id);
ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS pod_port_id int REFERENCES ports(id);
ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS pod_terminal_unconfirmed boolean DEFAULT false;
ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS port_resolution_status text;

CREATE TABLE IF NOT EXISTS port_aliases (
  id bigserial PRIMARY KEY,
  port_id int NOT NULL REFERENCES ports(id),
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  locale text,
  source text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(normalized_alias, port_id)
);

WITH seed(code, alias, normalized_alias, source) AS (
  VALUES
    ('MYPKGW', 'Port Klang Westport', 'PORTKLANGWESTPORT', 'seed'),
    ('MYPKGW', 'Port Klang West', 'PORTKLANGWEST', 'seed'),
    ('MYPKGW', 'Westport', 'WESTPORT', 'seed'),
    ('MYPKGW', 'Port Kelang West', 'PORTKLANGWEST', 'seed'),
    ('MYPKGW', 'Port Kelang Westport', 'PORTKLANGWESTPORT', 'seed'),
    ('MYPKGN', 'Port Klang Northport', 'PORTKLANGNORTHPORT', 'seed'),
    ('MYPKGN', 'Port Klang North', 'PORTKLANGNORTH', 'seed'),
    ('MYPKGN', 'Northport', 'NORTHPORT', 'seed'),
    ('MYPKG', 'Port Klang', 'PORTKLANG', 'seed'),
    ('MYPKG', 'Klang', 'KLANG', 'seed'),
    ('MYPKG', 'Port Kelang', 'PORTKLANG', 'seed'),
    ('MYPKG', 'Kelang', 'KLANG', 'seed'),
    ('MYBKI', 'Kota Kinabalu', 'KOTAKINABALU', 'seed'),
    ('QINGDAO', 'QINGDAO', 'QINGDAO', 'official-port-charges'),
    ('QINGDAO', '青岛', '青岛', 'official-port-charges'),
    ('XIAMEN', 'XIAMEN', 'XIAMEN', 'official-port-charges'),
    ('XIAMEN', '厦门', '厦门', 'official-port-charges'),
    ('TIANJIN', 'TIANJIN', 'TIANJIN', 'official-port-charges'),
    ('TIANJIN', '天津', '天津', 'official-port-charges'),
    ('SHANGHAI', 'SHANGHAI', 'SHANGHAI', 'official-port-charges'),
    ('SHANGHAI', '上海', '上海', 'official-port-charges'),
    ('NINGBO', 'NINGBO', 'NINGBO', 'official-port-charges'),
    ('NINGBO', '宁波', '宁波', 'official-port-charges'),
    ('SHENZHEN', 'SHENZHEN', 'SHENZHEN', 'official-port-charges'),
    ('SHENZHEN', '深圳', '深圳', 'official-port-charges'),
    ('DALIAN', 'DALIAN', 'DALIAN', 'official-port-charges'),
    ('DALIAN', '大连', '大连', 'official-port-charges'),
    ('LIANYUNGANG', 'LIANYUNGANG', 'LIANYUNGANG', 'official-port-charges'),
    ('LIANYUNGANG', '连云港', '连云港', 'official-port-charges')
)
INSERT INTO port_aliases(port_id, alias, normalized_alias, source)
SELECT p.id, seed.alias, seed.normalized_alias, seed.source
  FROM seed
  JOIN ports p ON p.code = seed.code
ON CONFLICT (normalized_alias, port_id) DO NOTHING;

-- PORT_ALIASES migrated from api/db/_official-port-charges.js:
-- QINGDAO, XIAMEN, TIANJIN, SHANGHAI, NINGBO, SHENZHEN, DALIAN, LIANYUNGANG.
-- This migration joins by ports.code and skips aliases whose code is absent.
-- After manual execution, review skipped origin aliases with:
-- WITH seed(code) AS (VALUES ('QINGDAO'),('XIAMEN'),('TIANJIN'),('SHANGHAI'),('NINGBO'),('SHENZHEN'),('DALIAN'),('LIANYUNGANG'))
-- SELECT seed.code FROM seed LEFT JOIN ports p ON p.code = seed.code WHERE p.id IS NULL;
