-- M046 · 闭店清单 + 招聘筛选题改成选择题
--
-- 0802 Damon 看完 UI：
--   ①「首页把上班干的活漏掉了，还有下班需要干什么？」→ 补 phase='close' 的闭店清单
--   ②「这里需要填写对宠物喜欢、熟悉，要设置一些问题，不然谁都能来…都做选择题给他」

-- ── 闭店清单 ──
-- 走之前该做的。跟开店点检同一张表，只是 phase='close'。
-- ⚠️ 下班不打卡（0802 定），所以闭店清单**没有打卡这道闸**，靠自觉 + 拍照留痕 + 第二天开店第 1 条复查。
INSERT INTO hr_checklist_items (company_code, phase, seq, title, hint, need_photo, is_active) VALUES
 ('JINFANG','close',1,'地面拖一遍 · 笼具清一遍','洗护间地漏也看一眼，别留毛',                       true , true),
 ('JINFANG','close',2,'垃圾打包清出去',        '当天的垃圾当天清，别留到第二天',                   true , true),
 ('JINFANG','close',3,'活体区：水加满 · 食盆洗干净','明早第一件事就是看它们，今晚别欠',           false, true),
 ('JINFANG','close',4,'冷柜关好 · 温度正常',    '疫苗和冷藏食品一夜就能坏',                         false, true),
 ('JINFANG','close',5,'收银对账 · 备用金收好',  '对不上当场说，别过夜',                             false, true),
 ('JINFANG','close',6,'门窗锁好 · 该关的电关掉','插排、灯箱、空调',                                 false, true)
ON CONFLICT DO NOTHING;

-- ── 招聘筛选题：全改选择题，围绕「养没养过、怕不怕、会不会做」──
-- 存在 hr_job_posts.questions，改题目**不用改代码**，直接改这一行 jsonb 就行。
UPDATE hr_job_posts SET questions = '[
  {"q":"自己养过宠物吗？","type":"choice","options":["现在养着","以前养过","没养过"]},
  {"q":"大狗突然扑过来，你的第一反应？","type":"choice","options":["不怕，先把它控制住","有点怕，但能上手","会先躲开"]},
  {"q":"给猫剪指甲、洗澡，做过吗？","type":"choice","options":["做过，比较熟","帮别人打过下手","完全没做过"]},
  {"q":"狗在店里拉了，你会？","type":"choice","options":["马上自己清掉","叫同事一起弄","忙完手上的再说"]},
  {"q":"周末和节假日基本都要上班，行吗？","type":"choice","options":["可以","看情况","不行"]},
  {"q":"打算做多久？","type":"choice","options":["想长期做","先做半年看看","短期/寒暑假"]},
  {"q":"为什么想来宠物店？（可不填）","type":"text"}
]'::jsonb
WHERE company_code='JINFANG' AND id=1;
