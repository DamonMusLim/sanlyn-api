-- M031: canonical freight cost read models.
-- our_freight_cost_lines is the canonical view for our real freight cost:
-- exclude voided rows and customer-direct-paid rows.
-- If payer_company_code is NULL or cannot be resolved, keep the row as our cost.
-- This is conservative: unknown payer should not silently lower cost estimates.
CREATE OR REPLACE VIEW our_freight_cost_lines AS
SELECT fsb.*
  FROM freight_supplier_bills fsb
  LEFT JOIN companies c ON c.code = fsb.payer_company_code
 WHERE COALESCE(fsb.rebill_status,'') <> 'voided'
   AND COALESCE(c.type,'') <> 'customer';

-- Customer-direct-paid lines are not our cost; keep them available for reference.
CREATE OR REPLACE VIEW customer_direct_paid_lines AS
SELECT fsb.*
  FROM freight_supplier_bills fsb
  JOIN companies c ON c.code = fsb.payer_company_code
 WHERE COALESCE(fsb.rebill_status,'') <> 'voided'
   AND c.type = 'customer';
