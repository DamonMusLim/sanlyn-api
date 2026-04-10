const {Client}=require('pg');
const fs=require('fs');
const data=JSON.parse(fs.readFileSync('/Users/apple/Desktop/sanlyn-api-dev/payments_import.json'));
const client=new Client({
  host:'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:'sanlyn_db',
  user:'sanlyn_admin',password:'SanlynRDS2026!',ssl:false
});
client.connect().then(async()=>{
  const cols=[
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS jdy_id VARCHAR(64) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS type VARCHAR(32) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS direction VARCHAR(8) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS contract_no VARCHAR(64) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS order_no VARCHAR(64) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS customer_en VARCHAR(256) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS customer_cn VARCHAR(256) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS issuing_co VARCHAR(128) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS total_customer NUMERIC(14,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS total_factory NUMERIC(14,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(14,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS pending_amount NUMERIC(14,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS this_amount NUMERIC(14,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS bank_ref VARCHAR(128) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS payment_date DATE",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS pay_type VARCHAR(64) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS pay_item VARCHAR(128) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS forwarder_cn VARCHAR(128) DEFAULT ''",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS freight_recv NUMERIC(12,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS freight_pay NUMERIC(12,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS port_recv NUMERIC(12,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS port_pay NUMERIC(12,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS truck_recv NUMERIC(12,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS truck_pay NUMERIC(12,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS customs_recv NUMERIC(12,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS customs_pay NUMERIC(12,2)",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS audit_issues TEXT[] DEFAULT '{}'",
    "ALTER TABLE finance_payments ADD COLUMN IF NOT EXISTS audit_status VARCHAR(8) DEFAULT 'ok'",
  ];
  for(const sql of cols) try{await client.query(sql);}catch(e){}
  console.log('✅ 字段就绪');

  // AI audit logic
  function audit(p){
    const issues=[];
    if(!p.currency)                             issues.push('缺币种');
    if(!p.payment_date)                         issues.push('缺付款日期');
    if(!p.contract_no&&!p.order_no&&p.type!=='海运收付款') issues.push('缺合同/订单号');
    if(!p.this_amount&&!p.amount)               issues.push('缺收付金额');
    if(!p.customer_en&&!p.customer_cn&&p.type!=='海运收付款') issues.push('缺客户名称');
    const status=issues.length===0?'ok':issues.some(i=>i.includes('金额')||i.includes('币种'))?'error':'warn';
    return{issues,status};
  }

  let ok=0,fail=0;
  for(const p of data){
    const {issues,status}=audit(p);
    try{
      await client.query(`
        INSERT INTO finance_payments(
          _id,jdy_id,type,direction,contract_no,order_no,customer_en,customer_cn,
          issuing_co,total_customer,total_factory,paid_amount,pending_amount,
          this_amount,currency,bank_ref,payment_date,pay_type,pay_item,
          forwarder_cn,freight_recv,freight_pay,port_recv,port_pay,
          truck_recv,truck_pay,customs_recv,customs_pay,
          audit_issues,audit_status,status,raw
        ) VALUES(
          $1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
          $16::date,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
          $28,$29,'imported','{}'
        )
        ON CONFLICT(_id) DO UPDATE SET
          audit_issues=EXCLUDED.audit_issues,
          audit_status=EXCLUDED.audit_status,
          updated_at=NOW()`,
        [p.jdy_id,p.type,p.direction,p.contract_no,p.order_no,
         p.customer_en,p.customer_cn,p.issuing_co,
         p.total_customer,p.total_factory,p.paid_amount,p.pending_amount,
         p.this_amount,p.currency,p.bank_ref,
         p.payment_date||null,p.pay_type,p.pay_item,
         p.forwarder_cn,p.freight_recv,p.freight_pay,
         p.port_recv,p.port_pay,p.truck_recv,p.truck_pay,
         p.customs_recv,p.customs_pay,
         issues,status]
      );
      ok++;
    }catch(e){fail++;console.log('❌',p.jdy_id?.slice(0,8),e.message);}
  }

  const r=await client.query("SELECT audit_status,COUNT(*) cnt FROM finance_payments GROUP BY audit_status");
  console.log(`\n✅ 导入完成: 成功${ok} 失败${fail}`);
  console.log('审核状态:');
  r.rows.forEach(row=>console.log(`  ${row.audit_status==='ok'?'🟢':row.audit_status==='error'?'🔴':'🟡'} ${row.audit_status}: ${row.cnt}条`));
  await client.end();
}).catch(e=>console.error(e.message));
