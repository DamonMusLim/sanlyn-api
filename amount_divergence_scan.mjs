// amount_divergence_scan.mjs — 差额审核门检测节点(每日cron)。
// 规则(Damon 2026-07-13): |OLI按contract汇总 − fer.fob_cny汇总| > max(报关额×5%, ¥5000) → 写 tasks 进审核队列。
// 已人工确认(customs_invoice_status.manual_expected_amount 全覆盖该合同fer行)的合同不再报。
// public.tasks 约束: status∈{open,doing,done,cancelled}; level是对象类别(order/factory/doc/..)非紧急度→紧急度写 priority(p0/p1)。
// 自动收口: 回到阈内→cancelled+[自动核销]标记(带标记可复活); done/人工cancelled=永不复活; doing=只刷内容不动状态。
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
const pool = getPool();

const scanSql = `
WITH fer_c AS (
  SELECT fer.contract_no,
         SUM(fer.fob_cny) AS fer_total,
         COUNT(*) AS fer_rows,
         COUNT(*) FILTER (WHERE COALESCE(fer.fob_cny,0)<=0) AS fer_missing,
         COUNT(*) FILTER (WHERE s.manual_expected_amount IS NOT NULL) AS manual_rows
    FROM finance_export_rebates fer
    LEFT JOIN customs_invoice_status s ON s.customs_no=fer.customs_no
   WHERE fer.contract_no IS NOT NULL AND fer.contract_no <> ''
     AND fer.export_date >= '2026-01-01'
   GROUP BY fer.contract_no
),
oli_c AS (
  SELECT o.contract_no,
         SUM((SELECT COALESCE(NULLIF(SUM(oli.factory_subtotal),0),
                              NULLIF(SUM(oli.qty_ctn*oli.bg_bx*p.factory_price),0),
                              NULLIF(SUM(oli.qty_ctn*p.factory_price),0))
                FROM order_line_items oli LEFT JOIN products p ON p.id=oli.product_id
               WHERE oli.order_id=o.id)) AS oli_total,
         STRING_AGG(DISTINCT o.order_no,',') AS order_nos
    FROM orders o
   WHERE o.contract_no IS NOT NULL AND COALESCE(o.status,'')<>'cancelled'
   GROUP BY o.contract_no
)
SELECT f.contract_no, o.order_nos, ROUND(o.oli_total,2) AS oli_total, ROUND(f.fer_total,2) AS fer_total,
       ROUND(o.oli_total-f.fer_total,2) AS diff
  FROM fer_c f JOIN oli_c o ON o.contract_no=f.contract_no
 WHERE f.fer_missing=0 AND o.oli_total IS NOT NULL
   AND f.manual_rows < f.fer_rows
   AND ABS(o.oli_total-f.fer_total) > GREATEST(f.fer_total*0.05, 5000)
 ORDER BY ABS(o.oli_total-f.fer_total) DESC
`;

function money(n) {
  return Number(n || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

function pct(diff, base) {
  const b = Number(base || 0);
  if (!b) return "0.0%";
  return `${((Number(diff || 0) / b) * 100).toFixed(1)}%`;
}

// ⚠ 库是 SQL_ASCII: varchar(n)=n字节,汉字≈3字节!截断必须按字节(fitBytes,照 rebate_gaps.mjs c52c6d7),JS slice按字符会超长报 value too long。
const fitBytes = (s, max) => { s = String(s ?? ""); let out = "", n = 0; for (const ch of s) { const b = Buffer.byteLength(ch); if (n + b > max) break; out += ch; n += b; } return out; };

// tasks.id varchar(32) — id 必须与 autoResolve 的 activeIds 同源同截断
function idFor(r) {
  return fitBytes(`amount-div-${r.contract_no}`, 32);
}

const AUTO_MARK = "[自动核销:差额已回到阈内";

// STRING_AGG 的 order_nos 不限长:标题只放前3个+计数
function shortNos(orderNos) {
  const list = String(orderNos || "").split(",").filter(Boolean);
  if (!list.length) return "-";
  return list.length <= 3 ? list.join(",") : `${list.slice(0, 3).join(",")}等${list.length}票`;
}

function taskText(r) {
  const diff = Number(r.diff || 0);
  const priority = Math.abs(diff) > 100000 ? "p0" : "p1";
  const title = fitBytes(`差额审核: 合同${r.contract_no}(${shortNos(r.order_nos)}) OLI¥${money(r.oli_total)} vs 报关¥${money(r.fer_total)} 差${diff < 0 ? "-" : ""}${money(Math.abs(diff))}(${pct(diff, r.fer_total)})`, 200);
  const action = `核真报关单/进项票。确认报关口径后写 customs_invoice_status.manual_expected_amount + expected_amount_source='real_customs_declaration'(经customs-collab审核入口或SQL);查不到真报关单→escalate Damon`;
  return { priority, title, action };
}

async function upsertTask(id, title, orderNo, priority, action) {
  try {
    const ex = await pool.query(`SELECT id, status, next_action FROM tasks WHERE id=$1 LIMIT 1`, [id]);
    if (ex.rows.length) {
      const status = ex.rows[0].status;
      const autoClosed = status === "cancelled" && String(ex.rows[0].next_action || "").includes(AUTO_MARK);
      if (status === "done" || (status === "cancelled" && !autoClosed)) return "skip"; // 人工终态永不复活
      // 带自动核销标记的 cancelled 可复活; open 刷内容; doing 只刷内容不动状态
      await pool.query(
        `UPDATE tasks
            SET title=$2, related_order_no=$3, next_action=$4, domain='对账',
                priority=$5, task_type='AMOUNT_DIVERGENCE', assigned_to='agent',
                status=CASE WHEN status='cancelled' THEN 'open' ELSE status END,
                updated_at=NOW()
          WHERE id=$1`,
        [id, title, orderNo, action, priority]
      );
      return autoClosed ? "revive" : "upd";
    }
    await pool.query(
      `INSERT INTO tasks(id,title,task_type,priority,status,related_order_no,next_action,domain,assigned_to,created_at,updated_at)
       VALUES($1,$2,'AMOUNT_DIVERGENCE',$3,'open',$4,$5,'对账','agent',NOW(),NOW())`,
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
        WHERE id LIKE 'amount-div-%'
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

let counts = { new: 0, upd: 0, revive: 0, resolved: 0, skip: 0, err: 0 };
let rows = [];

try {
  const res = await pool.query(scanSql);
  rows = res.rows || [];
  const activeIds = rows.map(idFor);

  for (const r of rows) {
    const { priority, title, action } = taskText(r);
    // related_order_no varchar(64): 学 rebate_gaps 只放第一个单号
    const orderNo = fitBytes(String(r.order_nos || r.contract_no || "").split(",")[0], 64);
    const result = await upsertTask(idFor(r), title, orderNo, priority, action);
    counts[result] = (counts[result] || 0) + 1;
  }

  counts.resolved = await autoResolve(activeIds);
} catch (e) {
  console.log("amount divergence scan failed:", e.message);
}

console.log(`=== 差额审核门扫描 ${new Date().toISOString().slice(0, 16)} ===`);
console.log(`金额差额: 新增${counts.new} 更新${counts.upd} 复活${counts.revive} 核销${counts.resolved} 跳过${counts.skip} 错误${counts.err}`);
for (const r of rows) {
  console.log(`${r.contract_no} ${r.order_nos || "-"} OLI=${r.oli_total} FER=${r.fer_total} DIFF=${r.diff}`);
}

await pool.end().catch(() => {});
process.exit(0);
