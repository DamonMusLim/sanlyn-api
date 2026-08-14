-- M069: 归属清查(Damon 0815铁律: 抬头≠归属) — payer=BABI 但 BL 无我方订单 → 摘默认+建待归属任务; absorbed/voided 跳过
WITH orphan AS (
  SELECT DISTINCT BTRIM(b.bl_no) AS bl
  FROM freight_supplier_bills b
  WHERE b.payer_company_code='BABI' AND NULLIF(BTRIM(b.bl_no),'') IS NOT NULL
    AND COALESCE(b.rebill_status,'') NOT IN ('absorbed','voided')
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.deleted_at IS NULL AND BTRIM(o.bl_no)=BTRIM(b.bl_no))
), upd AS (
  UPDATE freight_supplier_bills b SET payer_company_code=NULL
  WHERE b.payer_company_code='BABI' AND BTRIM(b.bl_no) IN (SELECT bl FROM orphan)
    AND COALESCE(b.rebill_status,'') NOT IN ('absorbed','voided')
  RETURNING 1
)
INSERT INTO public.tasks(id, title, reason, status, source, created_at)
SELECT 'payer-'||bl, '货代账单待归属 '||bl, '无我方订单却挂巴匕应付(历史默认); 抬头≠归属, 请人工判', 'open', 'payer-guard', now()
FROM orphan
ON CONFLICT (id) DO NOTHING;
