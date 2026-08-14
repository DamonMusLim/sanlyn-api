-- M066: 价卡归位(双审定) — THC 从海运价表并入港杂价卡; 拖车规则并卡; 只补空不覆盖; 幂等  2026-08-14
-- a) freight_rates.thc → local_charges.fees.THC (存在对应卡且无THC键才补)
UPDATE local_charges lc
SET fees = COALESCE(lc.fees,'{}'::jsonb) || jsonb_build_object('THC', to_jsonb(fr.thc)),
    updated_at = now()
FROM (
  SELECT DISTINCT ON (carrier, pol, forwarder) carrier, pol, forwarder, thc
  FROM freight_rates WHERE COALESCE(thc,0) > 0
  ORDER BY carrier, pol, forwarder, updated_at DESC
) fr
WHERE lc.carrier = fr.carrier AND lc.pol = fr.pol
  AND (lc.company_name = fr.forwarder OR fr.forwarder IS NULL)
  AND COALESCE(lc.is_active, true)
  AND NOT (COALESCE(lc.fees,'{}'::jsonb) ? 'THC');

-- b) 拖车并卡【撤销】: trucking_rates=工厂提货段价(工厂xPOLx车队维度), 与港杂价卡(船司x航线)不同维, 保留独立表 (0814实查改判)
