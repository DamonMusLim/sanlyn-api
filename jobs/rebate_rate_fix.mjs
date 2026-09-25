import 'dotenv/config'; import pg from 'pg';
/* finance-rebate 铁律修复：退税率只能 9%/13%，一票多品按商品行分算，绝不整票加权
   体检 SQL：SELECT * FROM finance_export_rebates WHERE rebate_rate NOT IN (0.09,0.13) 应恒为空 */
const p=new pg.Pool({connectionString:process.env.DATABASE_URL});
const WRITE=process.argv.includes('--write');
const c=await p.connect();
try{ await c.query('BEGIN');
 const bad=(await c.query(`
  WITH li AS (SELECT cd.declaration_no cn, ci.hs_code,
       CASE WHEN ci.hs_code LIKE '2309%' THEN 0.09 ELSE 0.13 END rate, ci.declaration_amount amt
      FROM customs_declaration_items ci JOIN customs_declarations cd ON cd.id=ci.declaration_id
     WHERE ci.deleted_at IS NULL AND cd.declaration_no ~ '^[0-9]{18}$'
       AND COALESCE(ci.declaration_currency,'CNY') IN ('CNY','人民币','142')),
   agg AS (SELECT cn, round(sum(amt*rate),2) est, round(sum(amt),2) amt,
            count(DISTINCT rate)::int n_rate, string_agg(DISTINCT rate::text,'/') rates FROM li GROUP BY cn)
  SELECT r.customs_no, r.rebate_rate old_rate, r.rebate_expected old_est,
         a.est new_est, a.amt decl_amt, a.n_rate, a.rates
    FROM finance_export_rebates r JOIN agg a ON a.cn=r.customs_no
   WHERE r.customs_no ~ '^[0-9]{18}$'
     AND (r.rebate_rate IS NULL OR r.rebate_rate NOT IN (0.09,0.13))`)).rows;
 console.table(bad.map(r=>({报关单:r.customs_no,原率:r.old_rate,原预估:r.old_est,
   报关额:r.decl_amt,按HS重算:r.new_est,几档率:r.n_rate,率:r.rates})));
 for(const r of bad){
   // 单一税率档 → 直接写率；多档 → 率留 NULL（不许写加权），只写按行分算的金额
   const single = r.n_rate===1 ? Number(r.rates) : null;
   await c.query(`UPDATE finance_export_rebates SET
      rebate_rate=$2, rebate_expected=$3,
      raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object('rate_fix',
        jsonb_build_object('by','finance-rebate skill','at',now()::text,
          'was_rate',$4::text,'was_expected',$5::numeric,
          'rule','rate must be 0.09 or 0.13; multi-HS declarations are computed per line, never weighted-average',
          'n_rate_buckets',$6::int,'rates',$7::text)),
      updated_at=now() WHERE customs_no=$1`,
     [r.customs_no, single, r.new_est, String(r.old_rate), r.old_est, r.n_rate, r.rates]);
 }
 console.log('\n修了',bad.length,'票');
 console.log('体检（应恒为空，多档票率为NULL不算违规）:');
 console.table((await c.query(`SELECT customs_no,rebate_rate,rebate_expected,
    (SELECT count(DISTINCT CASE WHEN ci.hs_code LIKE '2309%' THEN 0.09 ELSE 0.13 END)
      FROM customs_declaration_items ci JOIN customs_declarations cd ON cd.id=ci.declaration_id
     WHERE cd.declaration_no=r.customs_no AND ci.deleted_at IS NULL)::int 几档
   FROM finance_export_rebates r WHERE r.customs_no ~ '^[0-9]{18}$'
     AND (r.rebate_rate IS NULL OR r.rebate_rate NOT IN (0.09,0.13))`)).rows);
 if(WRITE){await c.query('COMMIT');console.log('✅ 已提交')}else{await c.query('ROLLBACK');console.log('⛔ DRY-RUN')}
}catch(e){await c.query('ROLLBACK');console.log('❌',e.message.slice(0,300))}
finally{c.release();await p.end()}
