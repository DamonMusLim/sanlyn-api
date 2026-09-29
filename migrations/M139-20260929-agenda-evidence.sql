-- M139: 今日待办「证据完成」(Damon 0929:碰实物/价/钱的活必须有证据才算完成,点一下圈不算)
-- evidence 为空 = 普通待办,点圈完成,前后端行为不变。有 need 的条目:
--   {"need":"photo","product_code":"…"}   → 要拍照才算 done(贴新价签/常丢重定位/改绑货位),照片进 hr_agenda_photos
--   {"need":"report","product_code":"…"}  → 只能由库存上报报「坏了/过期」自动关(下架过期),点圈打回
-- 完成方在 done 时往 evidence 里补写 {done_via, ref_id, at},证据指向哪张照片/哪次上报。

ALTER TABLE hr_day_agenda ADD COLUMN IF NOT EXISTS evidence jsonb;

-- 已存在的所有 open「下架过期」(0929 库里是 id 29/30,不写死 id)按 note 里的「商品编码」回填 need='report',
-- 库存上报的自动关单从此按 evidence.product_code 精确匹配,不再靠标题前缀+note 正则。
-- note 里提不到商品编码的行不回填(evidence 留空 = 普通待办,行为不变,不会把人卡死)。
UPDATE hr_day_agenda
   SET evidence = jsonb_build_object('need', 'report', 'product_code',
                                     (regexp_match(note, '商品编码\D{0,2}(\d{6,})'))[1])
 WHERE title LIKE '下架过期%'
   AND status = 'open'
   AND evidence IS NULL
   AND (regexp_match(note, '商品编码\D{0,2}(\d{6,})'))[1] IS NOT NULL;
