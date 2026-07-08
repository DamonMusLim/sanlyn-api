-- Port canonicalization P3: seed missing ports and aliases from dry-run gaps.
-- Idempotent and safe to rerun. Does not backfill or change read paths.

WITH port_seed(code, name_en, name_cn, country_code, port_type, unlocode, note) AS (
  VALUES
    ('CNDLC', 'Dalian', '大连', 'CN', 'sea', 'CNDLC', 'auto-seed'),
    ('CNJNZ', 'Jinzhou', '锦州', 'CN', 'sea', 'CNJNZ', 'auto-seed verify: brief mentioned CNJZO; customs areas may use CNJNZ'),
    ('CNLYG', 'Lianyungang', '连云港', 'CN', 'sea', 'CNLYG', 'auto-seed'),
    ('CNNSA', 'Nansha', '南沙', 'CN', 'sea', 'CNNSA', 'auto-seed'),
    ('CNRZH', 'Rizhao', '日照', 'CN', 'sea', 'CNRZH', 'auto-seed'),
    ('CNQZL', 'Quanzhou', '泉州', 'CN', 'sea', 'CNQZL', 'auto-seed verify: brief mentioned CNQZH, which appears to be Qinzhou'),
    ('CNTAC', 'Taicang', '太仓', 'CN', 'sea', 'CNTAC', 'auto-seed verify: river/sea port'),
    ('CNWHG', 'Wuhan', '武汉', 'CN', 'inland', 'CNWHG', 'auto-seed verify: brief mentioned CNWUH airport code'),
    ('CNYIU', 'Yiwu', '义乌', 'CN', 'inland', 'CNYIU', 'auto-seed verify: brief mentioned CNYWU'),
    ('CNUAN', 'Xuancheng', '宣城', 'CN', 'inland', 'CNUAN', 'auto-seed verify: brief mentioned CNXUC'),
    ('CNJGH', 'Jianghai', '江海', 'CN', 'inland', 'CNJGH', 'auto-seed verify'),
    ('MYPGU', 'Pasir Gudang', '巴西古当', 'MY', 'sea', 'MYPGU', 'auto-seed'),
    ('MYTWU', 'Tawau', '斗湖', 'MY', 'sea', 'MYTWU', 'auto-seed'),
    ('TWTXG', 'Taichung', '台中', 'TW', 'sea', 'TWTXG', 'auto-seed'),
    ('CLSAI', 'San Antonio', '圣安东尼奥', 'CL', 'sea', 'CLSAI', 'auto-seed')
)
INSERT INTO ports(code, name_en, name_cn, country_code, port_type, unlocode, note)
SELECT s.code, s.name_en, s.name_cn, s.country_code, s.port_type, s.unlocode, s.note
  FROM port_seed s
 WHERE NOT EXISTS (
   SELECT 1
     FROM ports p
    WHERE p.code = s.code
       OR lower(p.name_en) = lower(s.name_en)
 );

WITH port_seed(code, name_en) AS (
  VALUES
    ('CNDLC', 'Dalian'),
    ('CNJNZ', 'Jinzhou'),
    ('CNLYG', 'Lianyungang'),
    ('CNNSA', 'Nansha'),
    ('CNRZH', 'Rizhao'),
    ('CNQZL', 'Quanzhou'),
    ('CNTAC', 'Taicang'),
    ('CNWHG', 'Wuhan'),
    ('CNYIU', 'Yiwu'),
    ('CNUAN', 'Xuancheng'),
    ('CNJGH', 'Jianghai'),
    ('MYPGU', 'Pasir Gudang'),
    ('MYTWU', 'Tawau'),
    ('TWTXG', 'Taichung'),
    ('CLSAI', 'San Antonio')
),
target_ports AS (
  SELECT DISTINCT ON (s.code) s.code AS target_code, p.id AS port_id
    FROM port_seed s
    JOIN ports p ON p.code = s.code OR lower(p.name_en) = lower(s.name_en)
   ORDER BY s.code, (p.code = s.code) DESC, p.id
),
alias_seed(target_code, alias, normalized_alias, locale, source) AS (
  VALUES
    ('MYPKGW', 'Klang West', 'KLANGWEST', 'en', 'port-canonical-p3'),
    ('MYPKGW', '巴生西 Port Klang West', '巴生西PORTKLANGWEST', 'mixed', 'port-canonical-p3'),
    ('CNJNZ', '锦州', '锦州', 'zh', 'port-canonical-p3'),
    ('CNDLC', 'Dalian', 'DALIAN', 'en', 'port-canonical-p3'),
    ('CNDLC', 'Dalian Port', 'DALIANPORT', 'en', 'port-canonical-p3'),
    ('CNDLC', '大连', '大连', 'zh', 'port-canonical-p3'),
    ('CNJNZ', 'Jinzhou', 'JINZHOU', 'en', 'port-canonical-p3'),
    ('CNJNZ', 'Jinzhou Port', 'JINZHOUPORT', 'en', 'port-canonical-p3'),
    ('CNLYG', 'Lianyungang', 'LIANYUNGANG', 'en', 'port-canonical-p3'),
    ('CNLYG', 'Lianyungang Port', 'LIANYUNGANGPORT', 'en', 'port-canonical-p3'),
    ('CNLYG', '连云港', '连云港', 'zh', 'port-canonical-p3'),
    ('CNNSA', 'Nansha', 'NANSHA', 'en', 'port-canonical-p3'),
    ('CNNSA', 'Nansha Port', 'NANSHAPORT', 'en', 'port-canonical-p3'),
    ('CNNSA', '南沙', '南沙', 'zh', 'port-canonical-p3'),
    ('CNRZH', 'Rizhao', 'RIZHAO', 'en', 'port-canonical-p3'),
    ('CNRZH', 'Rizhao Port', 'RIZHAOPORT', 'en', 'port-canonical-p3'),
    ('CNRZH', '日照', '日照', 'zh', 'port-canonical-p3'),
    ('CNQZL', 'Quanzhou', 'QUANZHOU', 'en', 'port-canonical-p3'),
    ('CNQZL', 'Quanzhou Port', 'QUANZHOUPORT', 'en', 'port-canonical-p3'),
    ('CNQZL', '泉州', '泉州', 'zh', 'port-canonical-p3'),
    ('CNTAC', 'Taicang', 'TAICANG', 'en', 'port-canonical-p3'),
    ('CNTAC', 'Taicang Port', 'TAICANGPORT', 'en', 'port-canonical-p3'),
    ('CNTAC', 'Taicang Pt', 'TAICANGPT', 'en', 'port-canonical-p3'),
    ('CNTAC', '太仓', '太仓', 'zh', 'port-canonical-p3'),
    ('CNWHG', 'Wuhan', 'WUHAN', 'en', 'port-canonical-p3'),
    ('CNWHG', 'Wuhan Port', 'WUHANPORT', 'en', 'port-canonical-p3'),
    ('CNWHG', 'Wuhan Pt', 'WUHANPT', 'en', 'port-canonical-p3'),
    ('CNWHG', '武汉', '武汉', 'zh', 'port-canonical-p3'),
    ('CNYIU', 'Yiwu', 'YIWU', 'en', 'port-canonical-p3'),
    ('CNYIU', '义乌', '义乌', 'zh', 'port-canonical-p3'),
    ('CNUAN', 'Xuancheng', 'XUANCHENG', 'en', 'port-canonical-p3'),
    ('CNUAN', '宣城', '宣城', 'zh', 'port-canonical-p3'),
    ('CNJGH', 'Jianghai', 'JIANGHAI', 'en', 'port-canonical-p3'),
    ('CNJGH', '江海', '江海', 'zh', 'port-canonical-p3'),
    ('MYPGU', 'Pasir Gudang', 'PASIRGUDANG', 'en', 'port-canonical-p3'),
    ('MYPGU', 'Pasir Gudang Port', 'PASIRGUDANGPORT', 'en', 'port-canonical-p3'),
    ('MYPGU', '巴西古当', '巴西古当', 'zh', 'port-canonical-p3'),
    ('MYTWU', 'Tawau', 'TAWAU', 'en', 'port-canonical-p3'),
    ('MYTWU', 'Tawau Port', 'TAWAUPORT', 'en', 'port-canonical-p3'),
    ('MYTWU', '斗湖', '斗湖', 'zh', 'port-canonical-p3'),
    ('TWTXG', 'Taichung', 'TAICHUNG', 'en', 'port-canonical-p3'),
    ('TWTXG', 'Taichung Port', 'TAICHUNGPORT', 'en', 'port-canonical-p3'),
    ('TWTXG', '台中', '台中', 'zh', 'port-canonical-p3'),
    ('CLSAI', 'San Antonio', 'SANANTONIO', 'en', 'port-canonical-p3'),
    ('CLSAI', 'San Antonio Port', 'SANANTONIOPORT', 'en', 'port-canonical-p3'),
    ('CLSAI', '圣安东尼奥', '圣安东尼奥', 'zh', 'port-canonical-p3')
)
INSERT INTO port_aliases(port_id, alias, normalized_alias, locale, source)
SELECT p.id, a.alias, a.normalized_alias, a.locale, a.source
  FROM alias_seed a
  JOIN ports p ON p.code = a.target_code
UNION ALL
SELECT tp.port_id, a.alias, a.normalized_alias, a.locale, a.source
  FROM alias_seed a
  JOIN target_ports tp ON tp.target_code = a.target_code
 WHERE NOT EXISTS (SELECT 1 FROM ports p WHERE p.code = a.target_code)
ON CONFLICT (normalized_alias, port_id) DO NOTHING;

-- Manual LOCODE review items:
-- CNJNZ Jinzhou: brief mentioned CNJZO; customs-area references may differ.
-- CNQZL Quanzhou: brief mentioned CNQZH, which appears to be Qinzhou in UN/LOCODE.
-- CNTAC Taicang: seeded as sea with note "river/sea port".
-- CNWHG Wuhan: brief mentioned CNWUH, which appears to be Wuhan airport.
-- CNYIU Yiwu: brief mentioned CNYWU.
-- CNUAN Xuancheng: brief mentioned CNXUC.
-- CNJGH Jianghai: seeded from UN/LOCODE Jianghai, Guangdong; business meaning still needs verification.
