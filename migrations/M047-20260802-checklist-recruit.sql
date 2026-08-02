-- M047 · 点检清单按实际店况修正 + 招聘定位改成「招未来店长」
--
-- 0802 Damon：
--   ①「我们没有冷柜区，正常就卫生，巡查货架是否有歪整理」
--   ②「我是想培训做店长…老板是个甩手掌柜，希望有个能管事、能力的、长久的想干活的，
--      以这个目标来招聘，也直接说。我可以长久不见。来赌未来的。」

-- ── ① 清单：删冷柜，加货架巡查和临期 ──
UPDATE hr_checklist_items SET is_active=false
 WHERE company_code='JINFANG' AND title LIKE '%冷柜%';   -- 店里根本没有冷柜,别让人对着不存在的东西打勾

INSERT INTO hr_checklist_items (company_code, phase, seq, title, hint, need_photo, is_active) VALUES
 ('JINFANG','open' ,6,'货架巡一遍：歪的扶正 · 空的记下来','价签对不上、缺货的顺手拍一张，回头好补', true , true),
 ('JINFANG','open' ,7,'临期食品看一遍：当天到期的下架','按红线走，下架的进「待销毁」箱贴红标',       false, true),
 ('JINFANG','close',7,'货架回位 · 价签对得上',            '白天翻乱的归位，别留给明天早上',             false, true)
ON CONFLICT DO NOTHING;

-- 闭店最后一条把空调也带上（活体区一夜温度出事就是大事，虽然没冷柜）
UPDATE hr_checklist_items
   SET title='门窗锁好 · 空调和该关的电关掉',
       hint ='活体区的温度按季节留着，别一刀切全关'
 WHERE company_code='JINFANG' AND phase='close' AND title LIKE '门窗锁好%';

-- 重排序号，让「上班先做」是：卫生复查 → 活体 → 货架 → 临期 → 收银 → 门面
UPDATE hr_checklist_items SET seq=3 WHERE company_code='JINFANG' AND phase='open'  AND title LIKE '货架巡一遍%';
UPDATE hr_checklist_items SET seq=4 WHERE company_code='JINFANG' AND phase='open'  AND title LIKE '临期食品%';
UPDATE hr_checklist_items SET seq=5 WHERE company_code='JINFANG' AND phase='open'  AND title LIKE '收银机开机%';
UPDATE hr_checklist_items SET seq=6 WHERE company_code='JINFANG' AND phase='open'  AND title LIKE '门口/橱窗%';
UPDATE hr_checklist_items SET seq=4 WHERE company_code='JINFANG' AND phase='close' AND title LIKE '货架回位%';
UPDATE hr_checklist_items SET seq=5 WHERE company_code='JINFANG' AND phase='close' AND title LIKE '收银对账%';
UPDATE hr_checklist_items SET seq=6 WHERE company_code='JINFANG' AND phase='close' AND title LIKE '门窗锁好%';

-- ── ② 招聘定位：招的是未来店长，把话摆明 ──
UPDATE hr_job_posts SET
  title = '宠物店店员（往店长带）',
  intro = '这个岗位不是招一个「看店的」。

老板常年不在店里，是个甩手掌柜——很多事得你自己拿主意、自己扛。
所以我们更看重的不是你会不会洗澡剪毛（这些能教），而是：
遇到事你自己会不会想办法、能不能管住场子、愿不愿意长期干下去。

我们的打算是把你往店长带：先熟悉，再管事，最后这家店交给你。
说白了，我们是拿未来跟你赌，也希望你拿未来跟我们赌。

如果你只想找份轻松班上，这里不合适，别浪费彼此时间。',
  requirements = '想长期做（至少一年起）· 能自己拿主意 · 不怕脏不怕动物 · 周末节假日基本要在'
WHERE company_code='JINFANG' AND id=1;

-- 题目加两道「能不能管事、愿不愿长干」的，并把「做多久」的选项按新定位重写
UPDATE hr_job_posts SET questions = '[
  {"q":"自己养过宠物吗？","type":"choice","options":["现在养着","以前养过","没养过"]},
  {"q":"大狗突然扑过来，你的第一反应？","type":"choice","options":["不怕，先把它控制住","有点怕，但能上手","会先躲开"]},
  {"q":"给猫剪指甲、洗澡，做过吗？","type":"choice","options":["做过，比较熟","帮别人打过下手","完全没做过"]},
  {"q":"狗在店里拉了，你会？","type":"choice","options":["马上自己清掉","叫同事一起弄","忙完手上的再说"]},
  {"q":"店里只有你一个人，老板联系不上，顾客要退货吵起来了，你会？","type":"choice","options":["自己按规矩当场处理，事后跟老板说一声","先稳住顾客，等联系上老板再定","不敢做主，让顾客改天再来"]},
  {"q":"我们想把这个岗位往店长带，你怎么想？","type":"choice","options":["就想往这个方向做，愿意学","先把本职做好，以后再说","只想上班拿工资，不想管事"]},
  {"q":"打算做多久？","type":"choice","options":["长期做，做出点名堂","先干一年看看","没想好/短期"]},
  {"q":"周末和节假日基本都要上班，行吗？","type":"choice","options":["可以","看情况","不行"]},
  {"q":"为什么想来宠物店？（可不填）","type":"text"}
]'::jsonb
WHERE company_code='JINFANG' AND id=1;
