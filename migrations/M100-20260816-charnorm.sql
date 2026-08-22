-- Character normalization gate for POS snapshot ingress.
-- No transaction wrapper: migration runner owns transaction policy.

CREATE OR REPLACE FUNCTION petstore_normalize_text(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT replace(
    replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(
                            replace(
                              replace(
                                replace(
                                  replace(
                                    replace(
                                      replace(
                                        replace(
                                          replace(
                                            replace(
                                              replace(
                                                replace(
                                                  replace(
                                                    replace(
                                                      replace(
                                                        replace(
                                                          replace(
                                                            replace(
                                                              replace(
                                                                replace(
                                                                  replace(
                                                                    replace(
                                                                      replace(
                                                                        replace(
                                                                          replace(
                                                                            replace(
                                                                              replace(
                                                                                replace(
                                                                                  replace(
                                                                                    replace(
                                                                                      replace(
                                                                                        replace(
                                                                                          replace(
                                                                                            replace(input, '⼝', '口'),
                                                                                            '⼀', '一'),
                                                                                          '⼆', '二'),
                                                                                        '⼈', '人'),
                                                                                      '⼒', '力'),
                                                                                    '⼤', '大'),
                                                                                  '⼥', '女'),
                                                                                '⼦', '子'),
                                                                              '⼩', '小'),
                                                                            '⼭', '山'),
                                                                          '⼯', '工'),
                                                                        '⼟', '土'),
                                                                      '⽜', '牛'),
                                                                    '⽝', '犬'),
                                                                  '⽟', '玉'),
                                                                '⽣', '生'),
                                                              '⽤', '用'),
                                                            '⽯', '石'),
                                                          '⽲', '禾'),
                                                        '⾁', '肉'),
                                                      '⾆', '舌'),
                                                    '⾍', '虫'),
                                                  '⾎', '血'),
                                                '⾷', '食'),
                                              '⿂', '鱼'),
                                            '⿃', '鸟'),
                                          '⽑', '毛'),
                                        '⽔', '水'),
                                      '⾔', '言'),
                                    '⾋', '艸'),
                                  '⾉', '刀'),
                                '⾞', '车'),
                              ' ', ' '),
                            ' ', ' '),
                          ' ', ' '),
                        ' ', ' '),
                      ' ', ' '),
                    ' ', ' '),
                  ' ', ' '),
                ' ', ' '),
              ' ', ' '),
            ' ', ' '),
          ' ', ' '),
        ' ', ' '),
      ' ', ' '),
    '　', ' ');
$$;

COMMENT ON FUNCTION petstore_normalize_text(text) IS
'Normalize mistyped Kangxi/CJK radical glyphs and abnormal Unicode spaces in POS text. Keeps normal fullwidth punctuation unchanged.';

CREATE OR REPLACE FUNCTION petstore_skus_charnorm_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.product_name := petstore_normalize_text(NEW.product_name);
  NEW.category := petstore_normalize_text(NEW.category);
  NEW.spec := petstore_normalize_text(NEW.spec);
  NEW.supplier := petstore_normalize_text(NEW.supplier);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_petstore_skus_charnorm ON petstore_skus;

CREATE TRIGGER trg_petstore_skus_charnorm
BEFORE INSERT OR UPDATE ON petstore_skus
FOR EACH ROW
EXECUTE FUNCTION petstore_skus_charnorm_before_write();
