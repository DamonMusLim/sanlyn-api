// /api/db/hr-contract.mjs — 劳动合同模版（可打印）
//
// 底本 = 人力资源社会保障部编制《劳动合同（通用）》示范文本，
// 来源:福建省人社厅下载中心 rst.fujian.gov.cn/fw/xzzx/qtzl/202007/t20200716_5324025.htm
// **条款原文一字不改**，只把空格按 hr_employees + hr_org_settings 自动填上。
//
// 关键选项(已按金枋店定死，改前先想清楚):
//  第一条  选 1「固定期限」——3 年期对应试用期上限 2 个月
//  第三条  选 2「综合计算工时工作制」周期=年 —— 必须写批文，否则不能对抗员工
//  第六条  选 3「基本工资和绩效工资相结合」—— 范本原生支持固定+浮动，绩效扣减才站得住
//
// 🔴 缺甲方信息(统一社会信用代码/法定代表人/注册地/批文号)时不给生成，
//    避免打出一份空着关键栏位的合同去签。
import { getPool, setCors } from "./db.js";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// 待填的空用下划线占位，打印出来手写；已知的直接填
const F = (v, w = 12) => (v ? `<u class="v">${esc(v)}</u>` : `<u class="b">${"　".repeat(w)}</u>`);
const money = (v) => (v == null ? "" : Number(v).toFixed(0));

function ymd(d) {
  if (!d) return { y: "", m: "", d: "" };
  const [y, m, dd] = String(d).slice(0, 10).split("-");
  return { y, m, d: dd };
}
function addYears(d, n) {
  if (!d) return "";
  const t = new Date(String(d).slice(0, 10) + "T00:00:00Z");
  t.setUTCFullYear(t.getUTCFullYear() + n);
  t.setUTCDate(t.getUTCDate() - 1);          // 3年期止于前一日
  return t.toISOString().slice(0, 10);
}
function addMonths(d, n) {
  if (!d) return "";
  const t = new Date(String(d).slice(0, 10) + "T00:00:00Z");
  t.setUTCMonth(t.getUTCMonth() + n);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
const D3 = (d) => { const x = ymd(d); return `${F(x.y, 4)} 年 ${F(x.m, 2)} 月 ${F(x.d, 2)} 日`; };

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "仅支持 GET" });

  const pool = getPool();
  const id = parseInt(req.query?.id, 10);
  if (!id) return res.status(400).json({ success: false, error: "缺员工 id" });

  try {
    const e = (await pool.query(
      `SELECT id, name, employee_code, id_card_no, phone, position, company_code,
              pay_type, pay_rate,
              to_char(hire_date,'YYYY-MM-DD')      AS hire_date,
              to_char(contract_start,'YYYY-MM-DD') AS contract_start,
              to_char(contract_end,'YYYY-MM-DD')   AS contract_end,
              to_char(probation_end,'YYYY-MM-DD')  AS probation_end
         FROM hr_employees WHERE id=$1`, [id])).rows[0];
    if (!e) return res.status(404).json({ success: false, error: "员工不存在" });

    const o = (await pool.query(
      "SELECT * FROM hr_org_settings WHERE company_code=$1", [e.company_code])).rows[0] || {};

    // 缺关键甲方信息就别生成——空着关键栏的合同签了等于没签
    const miss = [];
    if (!o.legal_name) miss.push("甲方全称");
    if (!o.credit_code) miss.push("统一社会信用代码");
    if (!o.legal_rep) miss.push("法定代表人");
    if (!o.worktime_doc_no) miss.push("综合工时制批文号");
    if (miss.length && req.query?.force !== "1") {
      return res.status(400).json({ success: false,
        error: `先补齐甲方信息再生成：${miss.join("、")}（在 hr_org_settings 里填）`,
        missing: miss, hint: "确要先打空白版本可加 &force=1" });
    }

    const start = e.contract_start || e.hire_date || "";
    const end = e.contract_end || addYears(start, 3);
    const prob = e.probation_end || addMonths(start, 2);
    const fixed = 3450, perf = 1050;       // 固定(基本2450+岗位1000) / 绩效浮动

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>劳动合同 · ${esc(e.name)}</title>
<style>
@page{size:A4;margin:18mm 16mm}
body{font:15px/2.05 "Songti SC","SimSun",serif;color:#000;max-width:820px;margin:0 auto;padding:20px}
h1{text-align:center;font-size:26px;letter-spacing:8px;margin:10px 0 2px}
.sub{text-align:center;font-size:17px;letter-spacing:4px;margin-bottom:26px}
h2{font-size:16px;margin:20px 0 6px}
p{margin:7px 0;text-indent:2em}
p.noind{text-indent:0}
u.v{text-decoration:none;border-bottom:1px solid #000;padding:0 6px;font-weight:700}
u.b{text-decoration:none;border-bottom:1px solid #000;padding:0 2px}
.hd p{text-indent:0;margin:5px 0}
.sign{display:flex;justify-content:space-between;margin-top:46px}
.sign div{width:46%}
.note{background:#f6f4f1;border-left:3px solid #999;padding:10px 14px;font-size:12.5px;line-height:1.85;margin:16px 0}
.warn{background:#fff4e6;border-left:3px solid #e07a3f}
@media print{.note.screen{display:none}}
</style></head><body>

<h1>劳 动 合 同</h1><div class="sub">（通 用）</div>

${miss.length ? `<div class="note warn screen">⚠️ 甲方信息未填全（${esc(miss.join("、"))}），下面对应栏位是空的，打印后须手写补齐。</div>` : ""}
<div class="note screen">底本＝人力资源社会保障部《劳动合同（通用）》示范文本，条款原文未作改动，仅按员工档案填空。
用蓝/黑钢笔或签字笔签署；<b>劳动者须本人签字，不得代签</b>；一式两份，交劳动者的一份不得由单位代管。</div>

<div class="hd">
<p>甲方（用人单位）：${F(o.legal_name, 20)}</p>
<p>统一社会信用代码：${F(o.credit_code, 18)}</p>
<p>法定代表人（主要负责人）或委托代理人：${F(o.legal_rep, 10)}</p>
<p>注 册 地：${F(o.reg_addr, 24)}</p>
<p>经 营 地：${F(o.biz_addr, 24)}</p>
<p>联系电话：${F(o.org_phone, 12)}</p>
<p>乙方（劳动者）：${F(e.name, 10)}</p>
<p>居民身份证号码：${F(e.id_card_no, 18)}</p>
<p>户籍地址：${F(null, 26)}</p>
<p>经常居住地（通讯地址）：${F(null, 22)}</p>
<p>联系电话：${F(e.phone, 12)}</p>
</div>

<p>根据《中华人民共和国劳动法》《中华人民共和国劳动合同法》等法律法规政策规定，甲乙双方遵循合法、公平、平等自愿、协商一致、诚实信用的原则订立本合同。</p>

<h2>一、劳动合同期限</h2>
<p>第一条　甲乙双方自用工之日起建立劳动关系，双方约定按下列第 <u class="v">1</u> 种方式确定劳动合同期限：</p>
<p>1. 固定期限：自 ${D3(start)} 起至 ${D3(end)} 止，其中，试用期从用工之日起至 ${D3(prob)} 止。</p>
<p>2. 无固定期限：（不适用）</p>
<p>3. 以完成一定工作任务为期限：（不适用）</p>

<h2>二、工作内容和工作地点</h2>
<p>第二条　乙方工作岗位是 ${F(e.position || "店员", 8)}，岗位职责为 <u class="v">见甲方《店员岗位职责》《外卖拣货作业标准》《货架位置管理规范》</u>。乙方的工作地点为 ${F(o.biz_addr, 20)}。</p>
<p>乙方应爱岗敬业、诚实守信，保守甲方商业秘密，遵守甲方依法制定的劳动规章制度，认真履行岗位职责，按时保质完成工作任务。乙方违反劳动纪律，甲方可依据依法制定的劳动规章制度给予相应处理。</p>

<h2>三、工作时间和休息休假</h2>
<p>第三条　根据乙方工作岗位的特点，甲方安排乙方执行以下第 <u class="v">2</u> 种工时制度：</p>
<p>1. 标准工时工作制。（不适用）</p>
<p>2. 依法实行以 <u class="v">${esc(o.worktime_cycle || "年")}</u> 为周期的综合计算工时工作制（批准文号：${F(o.worktime_doc_no, 14)}）。综合计算周期内的总实际工作时间不应超过总法定标准工作时间。甲方应采取适当方式保障乙方的休息休假权利。</p>
<p>3. 依法实行不定时工作制。（不适用）</p>
<p>第四条　甲方安排乙方加班的，应依法安排补休或支付加班工资。</p>
<p>第五条　乙方依法享有法定节假日、带薪年休假、婚丧假、产假等假期。</p>

<h2>四、劳动报酬</h2>
<p>第六条　甲方采用以下第 <u class="v">3</u> 种方式向乙方以货币形式支付工资，于每月 <u class="v">10</u> 日前足额支付：</p>
<p>1. 月工资　（不适用）</p>
<p>2. 计件工资。（不适用）</p>
<p>3. 基本工资和绩效工资相结合的工资分配办法，乙方月基本工资 <u class="v">${fixed}</u> 元，绩效工资计发办法为
<u class="v">月绩效工资 ${perf} 元，为浮动工资，按甲方《绩效考核办法》当月考核得分计发，满分全额发放；基本工资不因考核增减</u>。</p>
<p>4. 双方约定的其他方式（不适用）</p>
<p>第七条　乙方在试用期期间的工资计发标准为 <u class="v">3600</u> 元。</p>
<p>第八条　甲方应合理调整乙方的工资待遇。乙方从甲方获得的工资依法承担的个人所得税由甲方从其工资中代扣代缴。</p>

<h2>五、社会保险和福利待遇</h2>
<p>第九条　甲乙双方依法参加社会保险，甲方为乙方办理有关社会保险手续，并承担相应社会保险义务，乙方应当缴纳的社会保险费由甲方从乙方的工资中代扣代缴。</p>
<p>第十条　甲方依法执行国家有关福利待遇的规定。</p>
<p>第十一条　乙方因工负伤或患职业病的待遇按国家有关规定执行。乙方患病或非因工负伤的，有关待遇按国家有关规定和甲方依法制定的有关规章制度执行。</p>

<h2>六、职业培训和劳动保护</h2>
<p>第十二条　甲方应对乙方进行工作岗位所必需的培训。乙方应主动学习，积极参加甲方组织的培训，提高职业技能。</p>
<p>第十三条　甲方应当严格执行劳动安全卫生相关法律法规规定，落实国家关于女职工、未成年工的特殊保护规定，建立健全劳动安全卫生制度，对乙方进行劳动安全卫生教育和操作规程培训，为乙方提供必要的安全防护设施和劳动保护用品。</p>
<p>第十四条　乙方应当严格遵守安全操作规程，不违章作业。乙方对甲方管理人员违章指挥、强令冒险作业，有权拒绝执行。</p>

<h2>七、劳动合同的变更、解除、终止</h2>
<p>第十五条　甲乙双方应当依法变更劳动合同，并采取书面形式。</p>
<p>第十六条　甲乙双方解除或终止本合同，应当按照法律法规规定执行。</p>
<p>第十七条　甲乙双方解除终止本合同的，乙方应当配合甲方办理工作交接手续。甲方依法应向乙方支付经济补偿的，在办结工作交接时支付。</p>
<p>第十八条　甲方应当在解除或终止本合同时，为乙方出具解除或者终止劳动合同的证明，并在十五日内为乙方办理档案和社会保险关系转移手续。</p>

<h2>八、双方约定事项</h2>
<p>第十九条　乙方工作涉及甲方商业秘密和与知识产权相关的保密事项的，甲方可以与乙方依法协商约定保守商业秘密或竞业限制的事项，并签订相应协议。</p>
<p>第二十条　甲方出资对乙方进行专业技术培训，要求与乙方约定服务期的，应当征得乙方同意，并签订协议，明确双方权利义务。</p>
<p>第二十一条　双方约定的其它事项：
<u class="v">1）月工资 4500 元构成：基本工资 2450 元 + 岗位工资 1000 元（以上合计 3450 元为第六条所称基本工资，固定不变）+ 绩效工资 1050 元（浮动）。
2）指定商品提成按甲方公布的提成标准另行计发。
3）加班工资按国家规定另行计发，不含在上述工资内。
4）乙方已知悉并同意遵守甲方《工资怎么算》《上下班与排班》《加班怎么算》《绩效考核办法》《作业标准》《门店红线》，上述制度已向乙方公示告知</u>。</p>

<h2>九、劳动争议处理</h2>
<p>第二十二条　甲乙双方因本合同发生劳动争议时，可以按照法律法规的规定，进行协商、申请调解或仲裁。对仲裁裁决不服的，可以依法向有管辖权的人民法院提起诉讼。</p>

<h2>十、其他</h2>
<p>第二十三条　本合同中记载的乙方联系电话、通讯地址为劳动合同期内通知相关事项和送达书面文书的联系方式、送达地址。如发生变化，乙方应当及时告知甲方。</p>
<p>第二十四条　双方确认：均已详细阅读并理解本合同内容，清楚各自的权利、义务。本合同未尽事宜，按照有关法律法规和政策规定执行。</p>
<p>第二十五条　本合同双方各执一份，自双方签字（盖章）之日起生效，双方应严格遵照执行。</p>

<div class="sign">
  <div><p class="noind">甲方（盖章）</p><p class="noind">法定代表人（主要负责人）</p>
    <p class="noind">或委托代理人（签字或盖章）</p><p class="noind" style="margin-top:34px">　年　　月　　日</p></div>
  <div><p class="noind">乙方（签字）</p><p class="noind" style="margin-top:74px">　年　　月　　日</p></div>
</div>

<div class="note screen">签订时限：<b>用工之日起 1 个月内</b>必须订立书面合同。超过 1 个月不满 1 年未订立的，
从第二个月起每月支付二倍工资，最长 11 个月（《劳动合同法》第八十二条）。</div>
</body></html>`);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
