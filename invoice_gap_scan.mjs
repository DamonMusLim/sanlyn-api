// invoice_gap_scan.mjs — 工厂开票缺口清单检测器(每日cron)。amount_divergence_scan.mjs 的姊妹脚本。
// 仅内部提醒(对账台+任务中心),工厂页不显。对每个已锚定报关行(customs_invoice_status.manual_expected_amount 非空)扫三类缺口:
//   GAP1 报关明细待导入 (ig-i-)  : loadCustomsItems 返 items 为空 → 无 customs_declaration_items 且无 fer.raw.items
//   GAP2 采购价待确认   (ig-p-)  : 按厂scope采购额为空/0(无采购价) 或 |报关−采购|>max(采购×5%,¥5000)(加价单)
//   GAP3 水单待补       (ig-s-)  : 该行 scope 挂到 bank_source='manual_attestation' 的水单链
// public.tasks 约束: id varchar(32)按字节截; status∈{open,doing,done,cancelled}; level=对象类别(不写)紧急度写priority;
//   title 200字节截; related_order_no varchar(64); 库=SQL_ASCII 汉字≈3字节必按字节截(fitBytes)。
// 自动收口: 回到无缺口→cancelled+[自动核销]标记(带标记可复活); done/人工cancelled=永不复活; doing=只刷内容不动状态。
import { readFileSync } from "fs";

try {
  const env = readFileSync("/opt/sanlyn-api-test/.env", "utf-8");
  for (const line of env.split("\n")) {
    const [k, ...vs] = line.split("=");
    if (k && !k.startsWith("#")) process.env[k.trim()] = vs.join("=").trim();
  }
} catch (e) {
  console.log("env load failed:", e.message);
}

const { getPool } = await import("/opt/sanlyn-api-test/api/db.js");
// GAP1 复用真源判定(禁第二条路):与开票模板同一 anchored 逻辑
const { loadCustomsItems } = await import("/opt/sanlyn-api-test/api/db/customs-collab-docs.js");
const pool = getPool();

const AUTO_MARK = "[自动核销:缺口已补齐";

// ⚠ SQL_ASCII 库:varchar(n)=n字节,汉字≈3字节。截断按字节(照 rebate_gaps/amount_divergence)。
const fitBytes = (s, max) => { s = String(s ?? ""); let out = "", n = 0; for (const ch of s) { const b = Buffer.byteLength(ch); if (n + b > max) break; out += ch; n += b; } return out; };
const money = (n) => Number(n || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 });

// 锚定行:manual_expected_amount 非空
const anchoredSql = `
  SELECT customs_no, factory_code, contract_no, manual_expected_amount AS manual
    FROM customs_invoice_status
   WHERE manual_expected_amount IS NOT NULL
   ORDER BY customs_no, factory_code`;

// 统一 order scope(镜像 orderGroup:优先 fer.raw.order_nos,回退 bl_no/order_no/contract_no,按 factory_code 过滤)。
// 关键:必须经 orders 表解析成真实 order_no 集合,不能只取 fer.raw.order_nos——否则 fer 无 order_nos 的锚定行
// (如大之圣 40-DG-1)靠 contract_no 关联的订单会漏掉,GAP2/GAP3 都会漏报。$1=customs_no $2=factory $3=contract_no。
const scopeSql = `
  WITH scope AS (
    SELECT array_agg(DISTINCT x.order_no) FILTER (WHERE COALESCE(x.order_no,'')<>'') AS ons
      FROM finance_export_rebates fer
      LEFT JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(fer.raw->'order_nos')='array' THEN fer.raw->'order_nos' ELSE '[]'::jsonb END
      ) AS x(order_no) ON true
     WHERE fer.customs_no=$1
  )
  SELECT COALESCE(array_agg(DISTINCT o.order_no) FILTER (WHERE o.order_no IS NOT NULL), '{}') AS ons
    FROM orders o, scope s
   WHERE COALESCE(o.status,'')<>'cancelled'
     AND COALESCE(o.factory_code,(SELECT code FROM companies WHERE id=o.factory_company_id))=$2
     AND ( (s.ons IS NOT NULL AND o.order_no = ANY(s.ons))
           OR (s.ons IS NULL AND (o.bl_no=$1 OR o.order_no=$1 OR o.contract_no=$3)) )`;

// GAP2 采购额 = OLI factory_subtotal(真值线小计)。$1=scopedOrderNos。
// ⚠刻意不用 qty×factory_price 回退:实测该回退产生离谱数(如 195416 真采购¥164,736 被回退成¥2.23M),
//   会把正常订单误判成"加价单"并显示错误采购价,违反数据真实铁律。无 factory_subtotal → NULL → 判"无采购价"
//   (诚实:确实缺真采购价,需补录),不拿估算数冒充采购价。
const purchaseSql = `
  SELECT ROUND(SUM((SELECT SUM(oli.factory_subtotal)
                      FROM order_line_items oli WHERE oli.order_id=o.id)),2) AS purchase
    FROM orders o
   WHERE COALESCE(o.status,'')<>'cancelled' AND o.order_no = ANY($1::text[])`;

// GAP2 已确认采购价则跳过(前瞻;factory_confirmations 目前空)。$1=scopedOrderNos $2=factory。
// ⚠厂码别名:此处 company_code 须与 cis.factory_code 同命名空间(zc-oem vs VEN-ZC),表非空后按厂 join 前须核对。
const confirmedSql = `
  SELECT COUNT(*) AS c FROM factory_confirmations
   WHERE company_code=$2 AND confirmed_factory_amount IS NOT NULL AND order_no = ANY($1::text[])`;

// GAP3 手工确认水单。有 order scope 就只按 order_no(精确);scope 空才回退 bl_no/contract_no,
// 否则同合同跨柜跨厂的水单会串进本行(误报+alloc虚高)。$1=scopedOrderNos $2=customs_no $3=contract_no。
const slipSql = `
  SELECT COALESCE(SUM(bsl.amount_alloc),0) AS alloc, COUNT(*) AS cnt
    FROM bank_slip_links bsl JOIN bank_slips bs ON bs.id=bsl.slip_id
   WHERE bs.bank_source='manual_attestation'
     AND ( (array_length($1::text[],1) IS NOT NULL AND bsl.order_no = ANY($1::text[]))
           OR (array_length($1::text[],1) IS NULL AND (bsl.bl_no=$2 OR bsl.contract_no=$3)) )`;

// id varchar(32): 复合主键(customs_no,factory_code)同关单可多厂,id 必须含 factory 防碰撞。
// customs_no(高基数键)放前、factory 放尾:万一超32字节,fitBytes 从尾截只损低基数 factory,不丢关单区分度。
// 实测当前最长 30 字节(customs≤18+factory≤6),不触发截断。autoResolve 用 LIKE 'ig-%'。
function idFor(prefix, factory, customsNo) {
  return fitBytes(`${prefix}${customsNo}-${factory}`, 32);
}

async function upsertTask(id, title, orderNo, priority, action) {
  try {
    const ex = await pool.query(`SELECT id, status, next_action FROM tasks WHERE id=$1 LIMIT 1`, [id]);
    if (ex.rows.length) {
      const status = ex.rows[0].status;
      const autoClosed = status === "cancelled" && String(ex.rows[0].next_action || "").includes(AUTO_MARK);
      if (status === "done" || (status === "cancelled" && !autoClosed)) return "skip"; // 人工终态永不复活
      await pool.query(
        `UPDATE tasks
            SET title=$2, related_order_no=$3, next_action=$4, domain='对账',
                priority=$5, task_type='INVOICE_GAP', assigned_to='agent',
                status=CASE WHEN status='cancelled' THEN 'open' ELSE status END,
                updated_at=NOW()
          WHERE id=$1`,
        [id, title, orderNo, action, priority]
      );
      return autoClosed ? "revive" : "upd";
    }
    await pool.query(
      `INSERT INTO tasks(id,title,task_type,priority,status,related_order_no,next_action,domain,assigned_to,created_at,updated_at)
       VALUES($1,$2,'INVOICE_GAP',$3,'open',$4,$5,'对账','agent',NOW(),NOW())`,
      [id, title, priority, orderNo, action]
    ).catch(async () => {
      await pool.query(
        `INSERT INTO tasks(id,title,status,related_order_no,domain,created_at,updated_at)
         VALUES($1,$2,'open',$3,'对账',NOW(),NOW())`,
        [id, title, orderNo]
      ).catch(() => {});
    });
    return "new";
  } catch (e) {
    console.log(`${id} upsert failed:`, e.message);
    return "err";
  }
}

async function autoResolve(activeIds) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await pool.query(
      `UPDATE tasks
          SET status='cancelled',
              next_action=COALESCE(next_action,'') || $2,
              updated_at=NOW()
        WHERE id LIKE 'ig-%'
          AND status='open'
          AND NOT (id = ANY($1::text[]))`,
      [activeIds, `\n${AUTO_MARK} ${today}]`]
    );
    return res.rowCount || 0;
  } catch (e) {
    console.log("auto resolve failed:", e.message);
    return 0;
  }
}

const counts = { new: 0, upd: 0, revive: 0, resolved: 0, skip: 0, err: 0 };
const hits = [];
const activeIds = [];

async function emit(prefix, r, priority, title, action, orderNo, gapType, amt) {
  const id = idFor(prefix, r.factory_code, r.customs_no);
  activeIds.push(id);
  const result = await upsertTask(id, fitBytes(title, 200), fitBytes(String(orderNo || r.customs_no), 64), priority, action);
  counts[result] = (counts[result] || 0) + 1;
  hits.push(`${gapType} ${r.customs_no} ${r.factory_code} ${amt}`);
}

const client = await pool.connect();
try {
  const rows = (await client.query(anchoredSql)).rows;
  for (const r of rows) {
    const scoped = (await client.query(scopeSql, [r.customs_no, r.factory_code, r.contract_no || null])).rows[0]?.ons || [];
    const orderNo0 = scoped.length ? scoped[0] : r.customs_no;

    // GAP1 — loadCustomsItems 抛错时置 loadOk=false,绝不把"查询失败"误判成"无明细"
    let items1 = [], loadOk = true;
    try { items1 = (await loadCustomsItems(client, r.customs_no))?.items || []; } catch (e) { loadOk = false; console.log(`${r.customs_no} loadCustomsItems:`, e.message); }
    if (loadOk && !items1.length) {
      await emit("ig-i-", r, "p1",
        `报关明细待导入: ${r.customs_no} ${r.factory_code} 合同${r.contract_no || "-"} 已锚¥${money(r.manual)} 无报关明细项`,
        `按厂scope ETL 导入 customs_declaration_items(task_6d07b783);导入后开票模板才能锚定明细,本条自动核销`,
        orderNo0, "GAP1明细", `锚¥${money(r.manual)}`);
    }

    // GAP2
    const confirmed = scoped.length ? Number((await client.query(confirmedSql, [scoped, r.factory_code])).rows[0]?.c || 0) : 0;
    if (!confirmed) {
      const purchase = (await client.query(purchaseSql, [scoped])).rows[0]?.purchase;
      const pv = purchase == null ? null : Number(purchase);
      if (pv == null || pv === 0) {
        await emit("ig-p-", r, "p1",
          `采购价待确认: ${r.customs_no} ${r.factory_code} 报关¥${money(r.manual)} 采购价缺失(OLI无factory_subtotal)`,
          `补该厂订单采购价(OLI factory_subtotal/products.factory_price),确认按采购价开票给工厂;报关口径¥${money(r.manual)}`,
          orderNo0, "GAP2无采购价", `报关¥${money(r.manual)}`);
      } else {
        const diff = Number(r.manual) - pv;
        if (Math.abs(diff) > Math.max(pv * 0.05, 5000)) {
          await emit("ig-p-", r, "p1",
            `采购价待确认: ${r.customs_no} ${r.factory_code} 报关¥${money(r.manual)} vs 采购¥${money(pv)} 差${diff < 0 ? "-" : ""}¥${money(Math.abs(diff))}`,
            `加价单:核采购价与报关口径,确认按哪个开票给工厂(开票绝不超报关);报关¥${money(r.manual)}/采购¥${money(pv)}`,
            orderNo0, "GAP2加价", `差¥${money(Math.abs(diff))}`);
        }
      }
    }

    // GAP3
    const slip = (await client.query(slipSql, [scoped, r.customs_no, r.contract_no || null])).rows[0];
    if (slip && Number(slip.cnt) > 0) {
      await emit("ig-s-", r, "p2",
        `水单待补: ${r.customs_no} ${r.factory_code} 已按手工确认付¥${money(slip.alloc)} 待真实水单替换`,
        `导入2026付工厂流水后,用真实水单替换 manual_attestation 挂账(见 project-bank-slip-integration-gap);已付¥${money(slip.alloc)}`,
        orderNo0, "GAP3水单", `已付¥${money(slip.alloc)}`);
    }
  }

  counts.resolved = await autoResolve(activeIds);
} catch (e) {
  console.log("invoice gap scan failed:", e.message);
} finally {
  client.release();
}

console.log(`=== 工厂开票缺口扫描 ${new Date().toISOString().slice(0, 16)} ===`);
console.log(`INVOICE_GAP: 新增${counts.new} 更新${counts.upd} 复活${counts.revive} 核销${counts.resolved} 跳过${counts.skip} 错误${counts.err} 命中${hits.length}`);
for (const h of hits) console.log(h);

await pool.end().catch(() => {});
process.exit(0);
