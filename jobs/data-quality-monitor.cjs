#!/usr/bin/env node
// ======================================================
// Sanlyn DQ Monitor — pm2 cron 每天 23:00
// 超阈值微信告警，阈值 0 = 任何新脏数据都报
// ======================================================
'use strict';
const { Pool } = require('pg');
const { exec }  = require('child_process');

const pool = new Pool({
  host:     '127.0.0.1',
  database: 'sanlyn_db',
  user:     'sanlyn_admin',
  password: process.env.PGPASS || 'Sanlyn2026!',
  port:     5432,
});

const CHECKS = [
  // [name, sql, threshold]
  ['orders 缺 company_code',
   "SELECT COUNT(*) FROM orders WHERE company_code IS NULL OR company_code=''",
   0],
  ['orders 卡 draft >90d',
   "SELECT COUNT(*) FROM orders WHERE status='draft' AND created_at < NOW() - INTERVAL '90 days'",
   0],
  ['orders BL已发但仍draft >30d',
   "SELECT COUNT(*) FROM orders o WHERE status='draft' AND EXISTS(SELECT 1 FROM shipping_plans sp WHERE (sp.contract_no=o.contract_no OR sp.order_contract_nos ILIKE '%'||o.contract_no||'%') AND sp.bl_no IS NOT NULL AND sp.etd < NOW()-INTERVAL '30 days')",
   0],
  ['sp BL有但status=draft >30d',
   "SELECT COUNT(*) FROM shipping_plans WHERE bl_no IS NOT NULL AND (shipping_status='draft' OR shipping_status IS NULL) AND etd < NOW()-INTERVAL '30 days'",
   0],
  ['finance 缺 companyCode',
   "SELECT COUNT(*) FROM finance_payments WHERE raw->>'companyCode' IS NULL OR raw->>'companyCode'=''",
   90],  // 90 = 工厂纯付款行，无客户 CC，已知容忍
  ['finance 缺 factory_code (容忍 420)',
   "SELECT COUNT(*) FROM finance_payments WHERE raw->>'factory_code' IS NULL OR raw->>'factory_code'=''",
   420],  // 419 = 历史工厂付款行，无客户 contract 关联，无法自动回填
  ['accounts factory role 缺 company_code',
   "SELECT COUNT(*) FROM accounts WHERE role='factory' AND (company_code IS NULL OR company_code='')",
   0],
];

(async () => {
  const today  = new Date().toISOString().slice(0, 10);
  const alerts = [];

  for (const [name, sql, threshold] of CHECKS) {
    try {
      const { rows } = await pool.query(sql);
      const n = Number(rows[0].count);
      if (n > threshold) {
        alerts.push(`⚠️ ${name}: ${n} (阈值 ${threshold})`);
      }
    } catch (err) {
      alerts.push(`❓ ${name}: 查询失败 — ${err.message}`);
    }
  }

  if (alerts.length) {
    const msg = `🚨 Sanlyn DQ Monitor ${today}\n` + alerts.join('\n');
    console.log(msg);
    exec(`/Users/mac/bin/wechat-push "${msg.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  } else {
    console.log(`✅ DQ Monitor ${today}: all clear`);
  }

  await pool.end();
})();
