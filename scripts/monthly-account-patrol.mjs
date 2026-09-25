// monthly-account-patrol.mjs — 月度账务缺口巡检。每月1号检查上个月，写 public.tasks。
// 参考 rebate_gaps.mjs: 从 /opt/sanlyn-api-test/.env 读环境变量；按字节截断；done/人工cancelled不复活；
// 自动收口: 缺口补齐后 -> cancelled + [自动核销] 标记；doing 只刷新内容不动状态。
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const env = readFileSync("/opt/sanlyn-api-test/.env", "utf-8");
for (const line of env.split("\n")) {
  const [k, ...vs] = line.split("=");
  if (k && !k.startsWith("#")) process.env[k.trim()] = vs.join("=").trim();
}
const { getPool } = await import("/opt/sanlyn-api-test/api/db.js");
const pool = getPool();

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const today = new Date();
const runDate = today.toISOString().slice(0, 10);
const ymDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
const YM = `${ymDate.getUTCFullYear()}${String(ymDate.getUTCMonth() + 1).padStart(2, "0")}`;
const MONTH_START = `${ymDate.getUTCFullYear()}-${String(ymDate.getUTCMonth() + 1).padStart(2, "0")}-01`;
const MONTH_END = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
const YY_ARCHIVE_DIR = "/opt/sanlyn-ac/yonyou-archive/data/zhongsha";
const YY_PULL = "/opt/sanlyn-ac/yy_pull_book.py";
const YY_TOKEN_FILE = "/opt/sanlyn-ac/.yy_token_lyg";
const AUTO_MARK = "[自动核销:账务缺口已补齐";
const ESC = " | agent:照此补,补不到→问Damon";

if (today.getUTCDate() !== 1 && !FORCE && !DRY_RUN) {
  console.log(`=== 月度账务缺口巡检 ${runDate} ===`);
  console.log("今天不是1号，跳过。需要手动执行请加 --force；预览请加 --dry-run。");
  await pool.end().catch(() => {});
  process.exit(0);
}

// SQL_ASCII库: 按字节截断且不切断多字节字符
const fitBytes = (s, max) => {
  s = String(s ?? "");
  let out = "", n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
};
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const isZero = (v) => v === null || v === undefined || v === "" || num(v) === 0;
const text = (v) => String(v ?? "").trim();
const first = (...vs) => vs.find((v) => v !== undefined && v !== null && v !== "");
const val = (obj, key) => obj && typeof obj === "object" ? obj[key] : undefined;
const asDate = (v) => {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
};
const inMonth = (r) => {
  const d = text(first(r.bizDate, r.submittedDate, r.createdStamp, r.lastUpdatedStamp));
  return !d || (d >= MONTH_START && d < MONTH_END);
};
const dedupe = (code) => `patrol-${YM}-${code}`;
const priorities = { A1: "p0", A3: "p0", B1: "p0", B2: "p0" };
const priority = (code) => priorities[code] || "p1";
const checkedCodes = new Set();
const resolvedCandidates = new Set();
const activeKeys = [];
const counts = { new: 0, upd: 0, revive: 0, skip: 0, err: 0, resolved: 0, dry: 0 };
const gaps = {};

function unpackJson(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const k of ["data", "rows", "list", "items", "records"]) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  return [];
}

function loadEntity(name) {
  if (!existsSync(YY_ARCHIVE_DIR)) return [];
  const files = readdirSync(YY_ARCHIVE_DIR).filter((f) => f.endsWith(".json"));
  const exact = files.find((f) => f === `${name}.json`);
  const loose = files.find((f) => f.toLowerCase() === `${name.toLowerCase()}.json`);
  // 2026-09-03 收紧：原来还有 includes() 模糊兜底，实测会把 Product.json.hidden-for-test
  // 这类残留/备份文件当成数据源读进来。只认精确名，宁可报缺失也不读错文件。
  const file = exact || loose;
  if (!file) return [];
  try {
    return unpackJson(JSON.parse(readFileSync(join(YY_ARCHIVE_DIR, file), "utf-8")));
  } catch (e) {
    console.log(`${name} json read failed: ${e.message}`);
    return [];
  }
}

function loadRequiredEntity(name) {
  if (!existsSync(YY_ARCHIVE_DIR)) throw new Error(`${YY_ARCHIVE_DIR} 不存在`);
  const files = readdirSync(YY_ARCHIVE_DIR).filter((f) => f.endsWith(".json"));
  const exact = files.find((f) => f === `${name}.json`);
  const loose = files.find((f) => f.toLowerCase() === `${name.toLowerCase()}.json`);
  // 2026-09-03 收紧：原来还有 includes() 模糊兜底，实测会把 Product.json.hidden-for-test
  // 这类残留/备份文件当成数据源读进来。只认精确名，宁可报缺失也不读错文件。
  const file = exact || loose;
  if (!file) throw new Error(`${name}.json 不存在`);
  return unpackJson(JSON.parse(readFileSync(join(YY_ARCHIVE_DIR, file), "utf-8")));
}

async function upsertTask(code, title, action, detail = {}) {
  checkedCodes.add(code);
  const key = dedupe(code);
  activeKeys.push(key);
  title = fitBytes(title, 200);
  action = fitBytes(`${action}${ESC}`, 2000);
  const payload = {
    id: key,
    dedupe_key: key,
    title,
    next_action: action,
    task_type: "MONTHLY_ACCOUNT_PATROL",
    priority: priority(code),
    status: "open",
    level: detail.level || "doc",
    domain: "账务",
    assigned_to: "agent",
    related_order_no: detail.related_order_no ? fitBytes(detail.related_order_no, 64) : null,
    source: "monthly-account-patrol",
  };
  if (DRY_RUN) {
    console.log(`[dry-run] upsert ${key} ${payload.priority} ${title}`);
    counts.dry++;
    return "dry";
  }
  try {
    const ex = await pool.query(
      `SELECT id,status,next_action FROM tasks WHERE dedupe_key=$1 OR id=$1 ORDER BY updated_at DESC LIMIT 1`,
      [key],
    );
    if (ex.rows.length) {
      const status = ex.rows[0].status;
      const autoClosed = status === "cancelled" && String(ex.rows[0].next_action || "").includes(AUTO_MARK);
      if (status === "done" || (status === "cancelled" && !autoClosed)) return "skip";
      await pool.query(
        `UPDATE tasks SET title=$2,next_action=$3,priority=$4,level=$5,domain='账务',
            task_type='MONTHLY_ACCOUNT_PATROL',assigned_to='agent',related_order_no=$6,source=$7,
            status=CASE WHEN status='cancelled' THEN 'open' ELSE status END,updated_at=NOW()
          WHERE id=$1`,
        [ex.rows[0].id, payload.title, payload.next_action, payload.priority, payload.level, payload.related_order_no, payload.source],
      );
      return autoClosed ? "revive" : "upd";
    }
    await pool.query(
      `INSERT INTO tasks(id,title,task_type,priority,status,level,related_order_no,next_action,domain,assigned_to,source,dedupe_key,created_at,updated_at)
        VALUES($1,$2,$3,$4,'open',$5,$6,$7,'账务','agent',$8,$9,NOW(),NOW())`,
      [payload.id, payload.title, payload.task_type, payload.priority, payload.level, payload.related_order_no, payload.next_action, payload.source, payload.dedupe_key],
    );
    return "new";
  } catch (e) {
    console.log(`${key} upsert failed: ${e.message}`);
    return "err";
  }
}

async function clearIfNoGap(code) {
  resolvedCandidates.add(code);
}

function tally(code, label, count, res) {
  if (count > 0) gaps[`${code} ${label}`] = count;
  counts[res] = (counts[res] || 0) + 1;
}

async function emitGap(code, label, count, title, action, detail, opts = {}) {
  const executed = opts.executed !== false;
  checkedCodes.add(code);
  if (!count) {
    if (executed) await clearIfNoGap(code);
    return;
  }
  const res = await upsertTask(code, title, action, detail);
  tally(code, label, count, res);
}

async function autoResolve() {
  const keys = [...resolvedCandidates].map(dedupe);
  if (!keys.length) return 0;
  if (DRY_RUN) {
    console.log(`[dry-run] auto-resolve executed-zero keys if open and inactive: ${keys.filter((k) => !activeKeys.includes(k)).join(", ") || "(none)"}`);
    return 0;
  }
  try {
    const res = await pool.query(
      `UPDATE tasks SET status='cancelled',
          next_action=COALESCE(next_action,'') || $3,updated_at=NOW(),closed_at=NOW()
        WHERE dedupe_key=ANY($1::text[]) AND status='open' AND NOT (dedupe_key=ANY($2::text[]))`,
      [keys, activeKeys, `\n${AUTO_MARK} ${runDate}]`],
    );
    return res.rowCount || 0;
  } catch (e) {
    console.log(`auto resolve failed: ${e.message}`);
    return 0;
  }
}

async function hasColumns(table, cols) {
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  const set = new Set(res.rows.map((r) => r.column_name));
  return cols.every((c) => set.has(c));
}

async function sqlGap(code, label, sql, params, titleFn, action, detailFn = () => ({})) {
  checkedCodes.add(code);
  try {
    const rows = (await pool.query(sql, params)).rows;
    const n = Number(rows[0]?.n ?? rows.length ?? 0);
    if (!n) return clearIfNoGap(code);
    const realAction = typeof action === "function" ? action(rows[0], n) : action;
    const res = await upsertTask(code, titleFn(rows[0], n), realAction, detailFn(rows[0], n));
    tally(code, label, n, res);
  } catch (e) {
    const res = await upsertTask(code, `${code} ${label}: 巴匕巡检未执行`, `SQL执行失败: ${e.message}。先确认真实字段/索引，再重跑巡检；不得按0缺口收口。`, { level: "doc" });
    tally(code, `${label}巡检失败`, 1, res);
  }
}

async function loadVoucherBo(bo, { month = false } = {}) {
  const params = [bo];
  let where = `book_id=2 AND bo=$1`;
  if (month) {
    params.push(MONTH_START, MONTH_END);
    where += ` AND data->>'bizDate' >= $2 AND data->>'bizDate' < $3`;
  }
  const res = await pool.query(`SELECT data FROM ac.voucher WHERE ${where}`, params);
  return res.rows.map((r) => r.data || {});
}

async function runYonyouChecks() {
  const pull = spawnSync("python3", [YY_PULL, "jwfq3ajbef", "zhongsha"], {
    env: { ...process.env, YY_TOKEN_FILE },
    encoding: "utf-8",
    timeout: 10 * 60 * 1000,
  });
  if (pull.status !== 0) {
    const msg = fitBytes(text(pull.stderr || pull.stdout || `exit ${pull.status}`), 300);
    const res = await upsertTask("A0", "A0 用友 token 失效，中砂巡检未执行", `更新/确认 ${YY_TOKEN_FILE} 后重跑拉数命令；本次A组全部跳过，不能按无缺口处理。拉数返回: ${msg}`, { level: "doc" });
    tally("A0", "用友拉数失败", 1, res);
    return false;
  }
  if (!existsSync(YY_ARCHIVE_DIR)) {
    const res = await upsertTask("A0", "A0 用友归档缺失，中砂巡检未执行", `拉数命令返回成功但 ${YY_ARCHIVE_DIR} 不存在；先确认归档路径/权限，再重跑巡检。本次A组全部跳过，不能按无缺口处理。`, { level: "doc" });
    tally("A0", "用友归档缺失", 1, res);
    return false;
  }

  let cash, payment, issue, receipt, materialStock, finishedStock, beginCounts;
  try {
    let issueMonth;
    [cash, payment, issue, issueMonth, receipt, materialStock, finishedStock] = await Promise.all([
      loadVoucherBo("CashJournalEntry"),
      loadVoucherBo("PaymentAP"),
      loadVoucherBo("GoodsIssue"),
      loadVoucherBo("GoodsIssue", { month: true }),
      loadVoucherBo("GoodsReceipt", { month: true }),
      loadVoucherBo("MaterialStock", { month: true }),
      loadVoucherBo("FinishedGoodsStock", { month: true }),
    ]);
    globalThis.zhongshaGoodsIssueMonth = issueMonth;
    const beginnings = ["GoodsReceiptBeginning", "GoodsIssueBeginning", "PurchaseStockinBeginning", "SalesStockoutBeginning"];
    const beginningRows = await Promise.all(beginnings.map((name) => loadVoucherBo(name)));
    beginCounts = beginnings.map((name, i) => [name, beginningRows[i].length]);
  } catch (e) {
    const res = await upsertTask("A0", "A0 中砂库表查询失败，A组巡检未执行", `查询 ac.voucher(book_id=2) 失败: ${e.message}。本次A组全部跳过，不能按无缺口处理。`, { level: "doc" });
    tally("A0", "中砂库表查询失败", 1, res);
    return false;
  }

  let goodsReceiptDetail;
  try {
    goodsReceiptDetail = loadRequiredEntity("GoodsReceiptDetail");
  } catch (e) {
    const res = await upsertTask("A1", "A1 无法检测: 中砂进货明细读取失败", `读取 GoodsReceiptDetail.json 失败: ${e.message}。A1 不能按0缺口核销；确认 ${YY_PULL} 已产出进货明细后重跑。`, { level: "doc" });
    tally("A1", "进货明细零单价无法检测", 1, res);
  }
  if (goodsReceiptDetail) {
    const a1 = goodsReceiptDetail.filter((r) => (num(r.transQty) || 0) > 0 && isZero(r.netPriceWithoutTax));
    const a1Qty = Math.round(a1.reduce((s, r) => s + (num(r.transQty) || 0), 0));
    await emitGap("A1", "进货明细零单价", a1.length, `A1 中砂进货明细零单价: 累计${a1.length}条/${a1Qty}件`, `进用友把这些行补上真实不含税单价，补完重跑巡检。`);
  }

  const feeRe = /费|运费|律师|起诉|保全|电费|装卸|版费/;
  let product;
  try {
    product = loadRequiredEntity("Product");
  } catch (e) {
    const res = await upsertTask("A2", "A2 费用被当商品: 商品档案未读取", `读取 Product.json 失败: ${e.message}。A2 不能按0缺口核销；确认用友拉数产物后重跑。`, { level: "doc" });
    tally("A2", "费用被当商品巡检失败", 1, res);
    product = null;
  }
  const productName = (r) => text(first(r.name, r.productName, r["productId.name"], r.goodsName, r.fullName));
  if (product) {
    const a2Names = [...new Set(product.map(productName).filter((n) => feeRe.test(n)))];
    await emitGap("A2", "费用被当商品", a2Names.length, `A2 中砂费用被当商品: 累计${a2Names.length}项`, `检查这些商品档案: ${fitBytes(a2Names.join("、") || "见用友商品档案", 600)}。费用类不要作为库存商品入档案/明细，按真实业务调整用友单据后重跑。`);
  }

  const receipts = cash.filter((r) => (num(r.receiptAmount) || 0) > 0).map((r) => asDate(r.bizDate)).filter(Boolean).sort((a, b) => b - a);
  const lastReceipt = receipts[0] || null;
  const stoppedDays = lastReceipt ? Math.floor((today - lastReceipt) / 86400000) : 99999;
  await emitGap("A3", "收款停记", stoppedDays > 60 ? 1 : 0, `A3 中砂收款停记: 最近收款${lastReceipt ? `停在 ${lastReceipt.toISOString().slice(0, 10)}，已${stoppedDays}天` : "无记录"}`, `补登记用友现金日记账/收款记录；最近一条 receiptAmount>0 的 bizDate 必须回到60天内，补完重跑。`);

  const zeroPay = payment.filter((r) => isZero(r.totalRealAmount));
  const zeroIssue = issue.filter((r) => isZero(r.totalAmountWithTax));
  await emitGap("A4", "金额为0的单据", zeroPay.length + zeroIssue.length, `A4 中砂金额为0的单据: 累计${zeroPay.length + zeroIssue.length}张`, `核对付款单 totalRealAmount=0 和销货单 totalAmountWithTax=0 的单据编号；补真实金额或作废错误单据，补完重跑。`);

  const issueMonth = globalThis.zhongshaGoodsIssueMonth || [];
  await emitGap("A5", "生产链断裂", receipt.length > 0 && issueMonth.length > 0 && materialStock.length === 0 && finishedStock.length === 0 ? 1 : 0, `A5 中砂生产链断裂: 上月有进货/销货但库存链为0`, `用友上月已有进货${receipt.length}张、销货${issueMonth.length}张，但 MaterialStock/FinishedGoodsStock 都为0；补生产/库存链路或确认账套模块未启用。`);

  const allZero = beginCounts.every(([, n]) => n === 0);
  await emitGap("A6", "期初未录", allZero ? 1 : 0, `A6 中砂期初未录: 累计4类期初均为0`, `核对并录入用友期初: ${beginCounts.map(([k, n]) => `${k}=${n}`).join(", ")}；真实无期初则人工 cancelled，脚本不会自动判断。`);

  globalThis.zhongshaGoodsIssue = globalThis.zhongshaGoodsIssueMonth || [];
  return true;
}

async function runBabiChecks() {
  if (await hasColumns("orders", ["created_at", "factory_amount"])) {
    await sqlGap("B1", "订单缺工厂成本",
      `SELECT COUNT(*)::int n, STRING_AGG(order_no,',' ORDER BY created_at DESC) sample
         FROM orders WHERE created_at >= $1 AND created_at < $2 AND COALESCE(factory_amount,0)=0`,
      [MONTH_START, MONTH_END],
      (r, n) => `B1 巴匕订单缺工厂成本: ${n}张`,
      (r) => `补上月订单 factory_amount 真值；量和金额以真实订单/工厂合同为准，不能用估算值。样例: ${fitBytes(text(r.sample).split(",").slice(0, 10).join(","), 300)}`,
      (r) => ({ level: "order", related_order_no: text(r.sample).split(",")[0] || null }));
  } else {
    const res = await upsertTask("B1", "B1 巴匕订单缺工厂成本: 巡检未执行", "orders 缺 created_at 或 factory_amount 字段；确认真实字段后更新脚本，不能按0缺口收口。", { level: "order" });
    tally("B1", "订单缺工厂成本巡检失败", 1, res);
  }

  await sqlGap("B2", "进项票缺税额",
    `SELECT COUNT(*)::int n FROM finance_invoices_in WHERE total_tax IS NULL OR tax_rate IS NULL`,
    [],
    (r, n) => `B2 巴匕进项票缺税额: 累计${n}张`,
    "补 finance_invoices_in.total_tax 和 tax_rate 的真实票面值；不能倒推猜税额，票面缺失则回源票/OCR。");

  await sqlGap("B3", "进项票三数不符",
    `SELECT COUNT(*)::int n FROM finance_invoices_in
       WHERE amount_ex_tax IS NOT NULL AND total_tax IS NOT NULL AND amount_incl_tax IS NOT NULL
         AND ABS(amount_ex_tax + total_tax - amount_incl_tax) > 0.01`,
    [],
    (r, n) => `B3 巴匕进项票三数不符: 累计${n}张`,
    "按进项票票面核对不含税金额、税额、价税合计；修正录入或OCR解析结果，补完重跑。");

  await sqlGap("B4", "进项票无归属",
    `SELECT COUNT(*)::int n FROM finance_invoices_in
       WHERE bl_nos IS NULL AND contract_nos IS NULL`,
    [],
    (r, n) => `B4 巴匕进项票无归属: 累计${n}张`,
    "给进项票绑定真实 BL 或合同号；找不到归属则保留任务并问Damon，不要随便挂错合同。");

  await sqlGap("B5", "工厂金额异常倍数",
    `WITH x AS (
       SELECT contract_no, SUM(factory_amount)::numeric factory_amount, MAX(total_amount)::numeric total_amount
       FROM orders
       WHERE contract_no IS NOT NULL AND total_amount IS NOT NULL AND factory_amount IS NOT NULL
       GROUP BY contract_no
       HAVING SUM(factory_amount) > MAX(total_amount) * 3
     )
     SELECT COUNT(*)::int n, STRING_AGG(contract_no,',' ORDER BY contract_no) sample FROM x`,
    [],
    (r, n) => `B5 巴匕工厂金额异常倍数: 累计${n}个合同`,
    "核对同一 contract_no 的 factory_amount 是否误填成多单合计/多倍金额；按真实工厂成本修正，FS20260527326 类似问题重点看。",
    (r) => ({ level: "order", related_order_no: text(r.sample).split(",")[0] || null }));
}

async function runCrossChecks(aReady) {
  checkedCodes.add("C1");
  if (!aReady) return;
  try {
    const goodsIssue = globalThis.zhongshaGoodsIssue || [];
    const BABI_CUST_ID = 2941332219498226; // 厦门巴匕进出口有限公司
    const sameCustId = (v) => num(val(v, "id") ?? v) === BABI_CUST_ID;
    const zhongshaAmount = goodsIssue
      .filter((r) => sameCustId(r.soldToCustId) || sameCustId(r.billToCustId))
      .reduce((s, r) => {
        const amount = num(r.totalAmountWithTax) || 0;
        const redBlue = text(val(val(r, "data") || r, "redBlueFlagEnum")?.value);
        return s + (redBlue === "RED" ? -amount : amount);
      }, 0);
    const colRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='finance_invoices_in'`,
    );
    const cols = new Set(colRes.rows.map((r) => r.column_name));
    const sellerExprs = [];
    for (const c of ["seller_name", "vendor_name", "seller", "vendor"]) {
      if (cols.has(c)) sellerExprs.push(`COALESCE(${c},'') LIKE '%中砂%'`);
    }
    if (cols.has("raw")) sellerExprs.push(`COALESCE(raw->>'seller_name','') LIKE '%中砂%'`);
    const dateCol = ["invoice_date", "biz_date", "issue_date", "created_at"].find((c) => cols.has(c));
    if (!cols.has("amount_incl_tax") || !sellerExprs.length || !dateCol) throw new Error("finance_invoices_in 缺 amount_incl_tax、销方字段或日期字段");
    const local = await pool.query(
      `SELECT COALESCE(SUM(amount_incl_tax),0)::numeric AS amount
         FROM finance_invoices_in
        WHERE (${sellerExprs.join(" OR ")}) AND ${dateCol} >= $1 AND ${dateCol} < $2`,
      [MONTH_START, MONTH_END],
    );
    const babiAmount = Number(local.rows[0]?.amount || 0);
    const diff = Math.abs(zhongshaAmount - babiAmount);
    if (diff > 1000) {
      const res = await upsertTask("C1", `C1 中砂开票 vs 巴匕登记差额: ¥${Math.round(diff)}`, `对比上月中砂已发货与巴匕已登记进项票；中砂合计¥${Math.round(zhongshaAmount)}，巴匕合计¥${Math.round(babiAmount)}。差额不等于缺票，发货和开票存在时间差；核对上月发货单是否都已收到票，未收到的向中砂催票。`, { level: "doc" });
      tally("C1", "两边开票差额", 1, res);
    } else {
      await clearIfNoGap("C1");
    }
  } catch (e) {
    const res = await upsertTask("C1", "C1 中砂开票 vs 巴匕登记: 巡检未执行", `对账SQL/字段失败: ${e.message}。确认 finance_invoices_in 销方字段后重跑；不能按0差额收口。`, { level: "doc" });
    tally("C1", "两边对账巡检失败", 1, res);
  }
}

let scanOk = true;
let aReady = false;
try {
  aReady = await runYonyouChecks();
  await runBabiChecks();
  await runCrossChecks(aReady);
} catch (e) {
  scanOk = false;
  console.log(`scan failed: ${e.message}`);
}
if (scanOk) counts.resolved = await autoResolve();

console.log(`=== 月度账务缺口巡检(${YM}, ${MONTH_START}..${MONTH_END}) ${new Date().toISOString().slice(0, 16)}${DRY_RUN ? " DRY-RUN" : ""} ===`);
console.log(`写tasks给agent: 新增${counts.new} 更新${counts.upd} 复活${counts.revive} 核销${counts.resolved} 跳过${counts.skip} 错误${counts.err} dry-run${counts.dry}`);
console.log("各类缺口:", JSON.stringify(gaps), "| 总:", Object.values(gaps).reduce((a, b) => a + b, 0));
await pool.end().catch(() => {});
process.exit(counts.err ? 1 : 0);
