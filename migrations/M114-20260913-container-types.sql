-- M114-20260913-container-types.sql
-- 箱型字典:海管家 字典-箱型.txt 去重后 61 个码。冷冻/冷藏同箱不同温区,温度在运价行上,不在这张表。
CREATE TABLE IF NOT EXISTS container_types (
  code          text PRIMARY KEY,
  name_cn       text NOT NULL,
  size_ft       integer,
  kind_code     text,
  family_cn     text,
  is_reefer     boolean NOT NULL DEFAULT false,
  is_common     boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  source        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE container_types IS '箱型字典,唯一真源。种子来自海管家 字典-箱型(61码)。is_common=我们常跑的箱型,界面默认只显示这些。';
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('10FR','10尺框架箱',10,'FR','框架箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('10GP','10尺标准箱',10,'GP','标准箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('10HC','10尺高箱',10,'HC','高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('10NOR','10尺冷冻代干箱',10,'NOR','冷冻代干箱',true,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('10OT','10尺开顶箱',10,'OT','开顶箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('10PF','10尺平板箱',10,'PF','平板箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('10RF','10尺普通冷冻箱',10,'RF','冷冻箱',true,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('10RH','10尺冷冻高箱',10,'RH','冷冻高箱',true,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('10TK','10尺坦克箱',10,'TK','坦克箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('10VE','10尺通风箱',10,'VE','通风箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20FL','20尺折叠框架箱',20,'FL','折叠框架箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20FR','20尺框架箱',20,'FR','框架箱',false,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20GP','20尺标准箱',20,'GP','标准箱',false,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20HC','20尺高箱',20,'HC','高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20HG','20尺挂衣高箱',20,'HG','挂衣高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20HQ','20尺高箱',20,'HQ','高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20HT','20尺挂衣箱',20,'HT','挂衣箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20NOR','20尺冷冻代干箱',20,'NOR','冷冻代干箱',true,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20OT','20尺开顶箱',20,'OT','开顶箱',false,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20PF','20尺平板箱',20,'PF','平板箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20RF','20尺普通冷冻箱',20,'RF','冷冻箱',true,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20RH','20尺冷冻高箱',20,'RH','冷冻高箱',true,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20OQ','20尺开顶高箱',20,'OQ','开顶高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20TK','20尺坦克箱',20,'TK','坦克箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20VE','20尺通风箱',20,'VE','通风箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('20OH','20尺超高箱',20,'OH','超高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40FL','40尺折叠框架箱',40,'FL','折叠框架箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40FQ','40尺框架高箱',40,'FQ','框架高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40FR','40尺框架箱',40,'FR','框架箱',false,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40GP','40尺标准箱',40,'GP','标准箱',false,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40HC','40尺高箱',40,'HC','高箱',false,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40OT','40尺开顶箱',40,'OT','开顶箱',false,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40HG','40尺挂衣高箱',40,'HG','挂衣高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40HQ','40尺高箱',40,'HQ','高箱',false,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40HT','40尺挂衣箱',40,'HT','挂衣箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40NOR','40尺冷冻代干箱',40,'NOR','冷冻代干箱',true,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40NORH','40尺冷冻代干高箱',40,'NORH','冷冻代干高箱',true,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40OQ','40尺开顶高箱',40,'OQ','开顶高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40PF','40尺平板箱',40,'PF','平板箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40RF','40尺普通冷冻箱',40,'RF','冷冻箱',true,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40RH','40尺冷冻高箱',40,'RH','冷冻高箱',true,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40SR','40尺特种框架箱',40,'SR','特种框架箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40TK','40尺坦克箱',40,'TK','坦克箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40VE','40尺通风箱',40,'VE','通风箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('40OH','40尺超高箱',40,'OH','超高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('45FR','45尺框架箱',45,'FR','框架箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('45GP','45尺标准箱',45,'GP','标准箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('45HC','45尺高箱',45,'HC','高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('45HQ','45尺高箱',45,'HQ','高箱',false,true,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('45HT','45尺挂衣箱',45,'HT','挂衣箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('45NOR','45尺冷冻代干箱',45,'NOR','冷冻代干箱',true,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('45OT','45尺开顶箱',45,'OT','开顶箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('45RF','45尺普通冷冻箱',45,'RF','冷冻箱',true,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('45RH','45尺冷冻高箱',45,'RH','冷冻高箱',true,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('45TK','45尺油罐箱',45,'TK','坦克箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('48GP','48尺标准箱',48,'GP','标准箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('48HC','48尺高箱',48,'HC','高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('53GP','53尺标准箱',53,'GP','标准箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('53HC','53尺高箱',53,'HC','高箱',false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('非集装箱','非集装箱',NULL,NULL,NULL,false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
INSERT INTO container_types (code,name_cn,size_ft,kind_code,family_cn,is_reefer,is_common,source) VALUES ('其他尺寸标准箱','其他尺寸标准箱',NULL,NULL,NULL,false,false,'hgj-dict-20260913') ON CONFLICT (code) DO NOTHING;
