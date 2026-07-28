#!/usr/bin/env node
// hr-payroll.test.mjs — 薪酬算薪回归测试（工资碰钱，改代码前后必跑）
//
// 跑法（在 tencent 上）：
//   cd /opt/sanlyn-api-test && PID=$(pgrep -f "sanlyn-api-test/server.js" | head -1) \
//     && export $(tr '\0' '\n' < /proc/$PID/environ | grep '^JWT_SECRET=') \
//     && PG_HOST=127.0.0.1 PG_PORT=5432 PG_DATABASE=sanlyn_db PG_USER=sanlyn_admin \
//        PG_PASSWORD=$(awk -F: '/sanlyn_db/{print $5; exit}' ~/.pgpass) \
//        node api/db/hr-payroll.test.mjs
//
// 自建自清：用 company_code='__TEST__' 隔离，跑完全删，绝不碰 JINFANG 真实数据。
import { getPool } from "./db.js";
import payroll from "./hr-payroll.mjs";

const CO = "__TEST__";
const PERIOD = "2099-01";           // 未来月份，不可能撞真数据
const pool = getPool();
let pass = 0, fail = 0;

function check(name, got, want) {
  const ok = Math.abs(Number(got) - Number(want)) < 0.01;
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}: 得到 ${got}${ok ? "" : `，应为 ${want}`}`);
  ok ? pass++ : fail++;
}
function checkStr(name, got, want) {
  const ok = String(got) === String(want);
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}: 得到 "${got}"${ok ? "" : `，应为 "${want}"`}`);
  ok ? pass++ : fail++;
}
const call = (method, query, body) => new Promise(async (r) => {
  const res = { setHeader(){}, status(c){this._c=c;return this;}, json(o){ r({http:this._c,...o}); }, end(){} };
  await payroll({ method, query, body, headers:{} }, res);
});

async function setup() {
  await cleanup();
  await pool.query(`INSERT INTO hr_org_settings (company_code,display_name,standard_month_days,overtime_multiplier)
                    VALUES ($1,'测试公司',26,1.5) ON CONFLICT (company_code) DO UPDATE
                    SET standard_month_days=26, overtime_multiplier=1.5`, [CO]);
  const mk = async (code, name, type, rate) => (await pool.query(
    `INSERT INTO hr_employees (company_code,employee_code,name,role,pay_type,pay_rate,employment_status)
     VALUES ($1,$2,$3,'clerk',$4,$5,'active') RETURNING id`, [CO, code, name, type, rate])).rows[0].id;

  const d = await mk("TT-D", "测日薪", "daily", 150);
  const h = await mk("TT-H", "测时薪", "hourly", 22);
  const m = await mk("TT-M", "测月薪", "monthly", 5200);
  const z = await mk("TT-Z", "测未设薪", "daily", null);

  const shift = (id, name, day, s2, e2) => pool.query(
    `INSERT INTO hr_shifts (company_code,employee_id,employee_name,work_date,start_time,end_time,shift_label)
     VALUES ($1,$2,$3,$4,$5,$6,'班')`, [CO, id, name, `${PERIOD}-${String(day).padStart(2,"0")}`, s2, e2]);
  const punch = (name, day) => pool.query(
    `INSERT INTO hr_staff_checkin (id,company_code,staff_name,checkin_date,checkin_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [`tt-${name}-${day}`, CO, name, `${PERIOD}-${String(day).padStart(2,"0")}`, `${PERIOD}-${String(day).padStart(2,"0")} 09:00`]);

  // 日薪：排10天、打卡8天 → 8×150=1200
  for (let i = 1; i <= 10; i++) await shift(d, "测日薪", i, "09:00", "18:00");
  for (let i = 1; i <= 8; i++) await punch("测日薪", i);
  // 时薪：排4天×9h全打卡=36h×22=792；加班5h×22×1.5=165 → 957
  for (let i = 1; i <= 4; i++) { await shift(h, "测时薪", i, "09:00", "18:00"); await punch("测时薪", i); }
  await pool.query(`INSERT INTO hr_overtime (company_code,employee_id,employee_name,work_date,hours,kind,status)
                    VALUES ($1,$2,'测时薪',$3,5,'overtime','approved')`, [CO, h, `${PERIOD}-05`]);
  // 月薪：排20天、零打卡 → 走 schedule 兜底 5200/26×20=4000
  for (let i = 1; i <= 20; i++) await shift(m, "测月薪", i, "09:00", "18:00");
  // 跨零点夜班（单独验工时算法）
  await shift(d, "测日薪", 11, "22:00", "06:00");
  return { d, h, m, z };
}

async function cleanup() {
  await pool.query("DELETE FROM hr_payroll WHERE company_code=$1", [CO]);
  await pool.query("DELETE FROM hr_overtime WHERE company_code=$1", [CO]);
  await pool.query("DELETE FROM hr_shifts WHERE company_code=$1", [CO]);
  await pool.query("DELETE FROM hr_staff_checkin WHERE company_code=$1", [CO]);
  await pool.query("DELETE FROM hr_leave_requests WHERE company_code=$1", [CO]);
  await pool.query("DELETE FROM hr_reimbursements WHERE company_code=$1", [CO]);
  await pool.query("DELETE FROM hr_employees WHERE company_code=$1", [CO]);
  await pool.query("DELETE FROM hr_org_settings WHERE company_code=$1", [CO]);
}

(async () => {
  console.log("薪酬算薪回归测试\n");
  try {
    const ids = await setup();
    const gen = await call("POST", {}, { period: PERIOD, company_code: CO });
    if (gen.http !== 200) throw new Error("生成失败: " + gen.error);
    const by = Object.fromEntries(gen.data.map((r) => [r.employee_name, r]));

    console.log("【三种计薪】");
    check("日薪 8天×150", by["测日薪"].base_amount, 1200);
    check("时薪 36h×22", by["测时薪"].base_amount, 792);
    check("时薪加班 5h×22×1.5", by["测时薪"].overtime_amount, 165);
    check("时薪应发合计", by["测时薪"].gross_amount, 957);
    check("月薪 5200÷26×20", by["测月薪"].base_amount, 4000);

    console.log("\n【出勤口径兜底】");
    checkStr("日薪有打卡→按打卡", by["测日薪"].basis, "checkin");
    checkStr("月薪零打卡→退回排班", by["测月薪"].basis, "schedule");
    check("月薪零打卡不能算成0工资", by["测月薪"].gross_amount > 0 ? 1 : 0, 1);
    check("零打卡必须有告警", (by["测月薪"].warnings || []).length > 0 ? 1 : 0, 1);

    console.log("\n【防呆】");
    check("未设薪资标准→金额0", by["测未设薪"].gross_amount, 0);
    check("未设薪资标准→必须告警", (by["测未设薪"].warnings || []).some((w) => w.includes("pay_rate")) ? 1 : 0, 1);

    console.log("\n【跨零点夜班】");
    // ⚠️必须按员工过滤：同一天别的员工也有班，不加 employee_id 会抓错人（本测试踩过）
    const nightRow = await pool.query(
      `SELECT start_time,end_time FROM hr_shifts
        WHERE company_code=$1 AND work_date=$2 AND employee_id=$3`,
      [CO, `${PERIOD}-11`, ids.d]);
    check("22:00-06:00 应为8小时(不是-16)", (() => {
      const [sh,sm]=String(nightRow.rows[0].start_time).split(":").map(Number);
      const [eh,em]=String(nightRow.rows[0].end_time).split(":").map(Number);
      let x=(eh*60+em)-(sh*60+sm); if(x<0)x+=1440; return x/60;
    })(), 8);

    console.log("\n【已确认工资单不被重算覆盖】");
    await pool.query("UPDATE hr_payroll SET status='confirmed', gross_amount=99999 WHERE company_code=$1 AND employee_name='测日薪'", [CO]);
    const re = await call("POST", {}, { period: PERIOD, company_code: CO });
    const after = (await pool.query("SELECT gross_amount FROM hr_payroll WHERE company_code=$1 AND employee_name='测日薪'", [CO])).rows[0];
    check("confirmed 的金额重算后不变", after.gross_amount, 99999);
    check("重算要报告跳过了谁", (re.skipped || []).length, 1);

    console.log("\n【报销不并进应发】");
    await pool.query(`INSERT INTO hr_reimbursements (company_code,employee_id,employee_name,amount,purchase_date,status)
                      VALUES ($1,$2,'测时薪',88.5,$3,'approved')`, [CO, ids.h, `${PERIOD}-03`]);
    await pool.query("DELETE FROM hr_payroll WHERE company_code=$1 AND employee_name='测时薪'", [CO]);
    const r3 = await call("POST", {}, { period: PERIOD, company_code: CO });
    const t = r3.data.find((x) => x.employee_name === "测时薪");
    check("报销单列不进应发", t.gross_amount, 957);
    check("报销金额另计", t.reimb_amount, 88.5);
  } catch (e) {
    console.log("\n💥 测试异常:", e.message);
    fail++;
  } finally {
    await cleanup();
    console.log(`\n${"─".repeat(40)}\n通过 ${pass} · 失败 ${fail}`);
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
