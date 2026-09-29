// hr-bossdesk.mjs — 老板「待我处理」页后台(0929,前端另一单)
//
// GET  挂在 managerExtras().approvals.bossdesk:buildBossdesk → { groups, done }
// POST 4 个 action 走 tryManagerAction 开头的 tryBossdeskAction 接线:
//      boss_decide_batch / boss_note / boss_assign / boss_undo,只许老板(403)。
// ⛔ 只记录与转派,不执行改价/报损/果冻橙写接口 —— 执行是 claude/店员拿到工单后的事。
// 数据口径:任务集合同 buildApprovalsSummary 的 writeoff+boss(next_holder=damon);
// 商品事实照 ~/bin/nora-review.mjs productFacts(petstore_skus + petstore_ops_row view
// + 最新效期快照 + 同品名同款),留痕进 boss_decisions(M140,undo 靠 prev 快照回滚)。

const DEFAULT_BOSS_EMPLOYEE_IDS = "35"; // 复制自 hr-manager-mobile.mjs(那边未 export,brief 允许复制)

function isBossEmployee(me, empId) {
  const ids = String(process.env.BOSS_EMPLOYEE_IDS || DEFAULT_BOSS_EMPLOYEE_IDS)
    .split(",").map((x) => x.trim()).filter(Boolean);
  return ids.includes(String(me?.id || me?.employee_id || empId || ""));
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const uniq = (a) => [...new Set(a)];
const cut = (s, n) => Array.from(String(s ?? "")).slice(0, n).join("");

function shanghaiWhen() { // 与现有 boss_decide 同款:+08 的 YYYY-MM-DD HH:mm
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
const shanghaiToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const newBatchId = () => "bd" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const fmtPrice = (v) => (v == null || v === "" ? "—" : "¥" + String(v));

function expLabel(dateStr) { // 效期快照是 date;展示按距今天数(设计稿 "430天")
  if (!dateStr) return "—";
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  return days < 0 ? `已过期${-days}天` : `${days}天`;
}

async function safe(errors, label, fallback, fn) {
  try { return await fn(); } catch (e) { errors.push(`${label}: ${e?.message || e}`); return fallback; }
}

// ── Nora 升级文案解析(格式见 ~/bin/nora-review.mjs escText)───────────────
// ⛔ 输出里不许出现 DeepSeek/MiniMax 字样:复核不同意的 note 只裹进「要注意:」
// 老板「补一句」后 next_action 前面会多出「Damon补充:… | 」,不再以 Nora建议: 开头,
// 所以从「Nora建议:」第一次出现的位置起解析,why/caution 都在那段里找,不吃进补充段。
function parseNora(desc) {
  const s = String(desc ?? "");
  const at = s.indexOf("Nora建议:");
  if (at < 0) return null;
  const rest = s.slice(at);
  const seg = rest.split(" | ")[0];
  const m = seg.match(/^Nora建议:\s*(批|不批|没判出来)/);
  const ok = !m ? null : m[1] === "批" ? true : m[1] === "不批" ? false : null;
  const why = cut(seg.replace(/^Nora建议:\s*(批|不批|没判出来)\s*[—\-––]*\s*/, "").trim(), 90) || "";
  const ds = (rest.match(/DeepSeek:[^|]*/) || [""])[0].trim();
  let caution = "";
  if (/^DeepSeek:不同意/.test(ds)) {
    caution = ds.replace(/^DeepSeek:不同意\s*[（(]?\s*/, "").replace(/\s*[)）]\s*$/, "").trim();
  }
  return { ok, why, caution };
}

// 老板「补一句」留在 next_action 里的段(boss_note 前插「Damon补充:xxx · 时间 | 」),
// 收集为数组下发,前端显示「已补的话」;补几次收几条,最多 3 条。
function collectNotes(desc) {
  return [...String(desc ?? "").matchAll(/Damon补充:[^|]*/g)]
    .map((m) => m[0].trim()).filter(Boolean).slice(0, 3);
}

function kindLabel(t) { // 分组卡上的类别(writeoff 来源优先,其余按文字判)
  if (t.src === "writeoff") return "报损";
  const s = `${t.title || ""} ${t.next_action || ""}`;
  if (/(改价|调价|恢复|压到成本|价格)/.test(s) && !/(?<!非)临期/.test(s)) return "改价";   // 0930:「非临期」不算临期
  if (/(?<!非)临期/.test(s)) return "临期降价";
  if (/(改价|调价|价格)/.test(s)) return "改价";
  if (/(补货|进货|加货)/.test(s)) return "补货";
  return "其它";
}

// 码源含 task id:Nora A 类工单 id=nora-esc-nearexp-<code>,title/正文里不一定有码
const extractCodes = (t) =>
  uniq(`${t.id || ""} ${t.title || ""} ${t.next_action || ""}`.match(/\b\d{10}\b/g) || []).slice(0, 6);

// 建议价:先找「码所在位置之后最近的 a→b」;抽不到但全文只有一对 → 用那对;再抽不到 → null(显示「—」)
function suggestOf(text, code) {
  const s = String(text || "");
  const pairs = [
    ...[...s.matchAll(/(\d+(?:\.\d{1,2})?)\s*→\s*(\d+(?:\.\d{1,2})?)/g)].map((m) => ({ to: m[2], at: m.index })),
    ...[...s.matchAll(/建议价?\s*[:：]?\s*¥?\s*(\d+(?:\.\d{1,2})?)/g)].map((m) => ({ to: m[1], at: m.index })),   // 0930:「建议2.2」
  ].sort((a, b) => a.at - b.at);
  if (!pairs.length) return null;
  const ci = s.indexOf(code);
  const after = ci >= 0 ? pairs.filter((p) => p.at > ci) : [];
  if (after.length) return after[0].to;
  return pairs.length === 1 ? pairs[0].to : null;
}

// ── GET:待我处理分组 ──────────────────────────────────────────────────────
async function buildGroups(pool) {
  // 任务集合 = buildApprovalsSummary 的 writeoff ∪ boss(boss 去掉与 writeoff 重复的 id)
  const rows = (await pool.query(`
    SELECT id, title, next_action, created_at, 'writeoff' AS src FROM tasks
     WHERE status IN ('open','pending_review') AND source='dataops'
       AND (COALESCE(title,'') ~ '报损' OR COALESCE(dedupe_key,'') ~ 'writeoff|loss|risk')
       AND lower(COALESCE(next_holder,''))='damon'
    UNION ALL
    SELECT id, title, next_action, created_at, 'boss' FROM tasks
     WHERE status='open' AND task_prefix='CAW' AND needs_human=true
       AND lower(COALESCE(next_holder,''))='damon'
       AND NOT (source='dataops' AND status IN ('open','pending_review')
                AND (COALESCE(title,'') ~ '报损' OR COALESCE(dedupe_key,'') ~ 'writeoff|loss|risk'))
     ORDER BY created_at DESC NULLS LAST, id DESC`)).rows;

  const tasks = rows.map((t) => ({
    id: String(t.id), title: String(t.title || ""), next_action: String(t.next_action || ""),
    kind: kindLabel(t), codes: extractCodes(t), nora: parseNora(t.next_action),
  }));

  // 商品事实:全部码一次查(参数化版 productFacts;petstore_ops_row 是 view,spec/pic 从它出)
  const allCodes = uniq(tasks.flatMap((t) => t.codes));
  const facts = new Map();
  if (allCodes.length) {
    const r = await pool.query(`
      SELECT k.product_code, k.product_name,
             k.cost_price::text AS cost_price, k.out_price::text AS out_price,
             k.stock_num::text AS stock_num, k.month_sale::text AS month_sale,
             r.store_price::text AS store_price,
             translate(COALESCE(r.shelf_code,''), chr(9)||chr(10)||chr(13), ' ') AS shelf_code,
             r.spec_text, r.pic_url, e.expiration_date::text AS expiration_date,
             (SELECT json_agg(json_build_object(
                      'product_code', s.product_code, 'cost_price', s.cost_price, 'out_price', s.out_price,
                      'stock_num', s.stock_num, 'month_sale', s.month_sale, 'store_price', o.store_price,
                      'shelf_code', o.shelf_code, 'spec_text', o.spec_text,
                      'expiration_date', (SELECT x.expiration_date FROM petstore_offline_expiry_snapshot x
                                           WHERE x.product_code = s.product_code
                                           ORDER BY x.captured_at DESC LIMIT 1))
                    ORDER BY s.out_price ASC NULLS LAST)
                FROM petstore_skus s
                LEFT JOIN petstore_ops_row o ON o.product_code = s.product_code
               WHERE s.product_name = k.product_name AND s.product_code <> k.product_code) AS same_name
        FROM petstore_skus k
        LEFT JOIN petstore_ops_row r ON r.product_code = k.product_code
        LEFT JOIN LATERAL (SELECT x.expiration_date FROM petstore_offline_expiry_snapshot x
                            WHERE x.product_code = k.product_code
                            ORDER BY x.captured_at DESC LIMIT 1) e ON true
       WHERE k.product_code = ANY($1::text[])`, [allCodes]);
    for (const f of r.rows) facts.set(String(f.product_code), f);
  }

  // Nora A 类(临期)建议价以提案表为准:id=nora-esc-nearexp-<code> 的工单,
  // 取 petstore_nearexp_proposals 里该码 status='proposed' 最新一条的 suggest_price,
  // 取不到再落回文案解析,都没有才显示「—」(不编数)。
  const noraACodes = uniq(tasks.filter((t) => t.id.startsWith("nora-esc-nearexp-")).flatMap((t) => t.codes));
  const proposalPrice = new Map();
  if (noraACodes.length) {
    const r = await pool.query(`
      SELECT DISTINCT ON (product_code) product_code, suggest_price::text AS suggest_price
        FROM petstore_nearexp_proposals
       WHERE status='proposed' AND date_verified=true AND product_code = ANY($1::text[])
       ORDER BY product_code, expiry_date, id DESC`, [noraACodes]);
    for (const p of r.rows) if (p.suggest_price != null && p.suggest_price !== "") proposalPrice.set(String(p.product_code), String(p.suggest_price));
  }

  const byKey = new Map();
  for (const t of tasks) {
    const main = t.codes.map((c) => facts.get(c)).find(Boolean) || null;
    const key = main?.product_name || `task:${t.id}`;
    let g = byKey.get(key);
    if (!g) { g = { key, name: main?.product_name || t.title || t.id, fact: main, tasks: [] }; byKey.set(key, g); }
    if (!g.fact && main) g.fact = main;
    g.tasks.push(t);
  }

  const groups = [];
  for (const g of byKey.values()) {
    const t0 = g.tasks[0];
    const rowMap = new Map();
    const put = (row) => {
      const old = rowMap.get(row.code);
      if (!old || (row.act && !old.act)) rowMap.set(row.code, row);
    };
    for (const t of g.tasks) {
      const isNoraA = t.id.startsWith("nora-esc-nearexp-"); // A 类:码在 id 里,建议价优先走提案表
      for (const code of t.codes) {
        const f = facts.get(code) || null; // 查无此码也给一行,字段缺省「—」,不编数
        const sug = (isNoraA && proposalPrice.get(code))
          || suggestOf(isNoraA ? `${t.id} ${t.title} ${t.next_action}` : `${t.title} ${t.next_action}`, code);
        put({
          task_id: t.id, kind: t.kind, code,
          spec: f?.spec_text ? cut(String(f.spec_text), 40) : "",
          now: f ? fmtPrice(f.store_price ?? f.out_price) : "—",
          sug: sug ? "¥" + sug : "—",
          stock: f && f.stock_num != null && f.stock_num !== "" ? String(f.stock_num) : "—",
          exp: expLabel(f?.expiration_date),
          act: true,
        });
      }
    }
    // 同款(同 product_name 其它码)未被工单点名的 → 「不动」行,act=false
    const same = Array.isArray(g.fact?.same_name) ? g.fact.same_name : [];
    for (const sn of same) {
      const code = String(sn?.product_code || "");
      if (!code || rowMap.has(code)) continue;
      put({
        task_id: t0.id, kind: t0.kind, code,
        spec: sn.spec_text ? cut(String(sn.spec_text), 40) : "",
        now: fmtPrice(sn.store_price ?? sn.out_price), sug: "不动",
        stock: sn.stock_num != null && sn.stock_num !== "" ? String(sn.stock_num) : "—",
        exp: expLabel(sn.expiration_date), act: false,
      });
    }

    // foot 数据源 = 点名码 + 同款,按码去重(同款可能同时被点名,别重复加月销)
    const seen = new Set(); const pool2 = [];
    for (const f of [...g.tasks.flatMap((t) => t.codes.map((c) => facts.get(c))).filter(Boolean), ...same]) {
      const c = String(f?.product_code || "");
      if (!c || seen.has(c)) continue;
      seen.add(c); pool2.push(f);
    }
    const costs = uniq(pool2.map((f) => f.cost_price).filter((v) => v != null && v !== "").map(String));
    const shelves = uniq(pool2.map((f) => f.shelf_code).filter(Boolean).map(String));
    const sales = pool2.filter((f) => f.month_sale != null && f.month_sale !== "");
    const n = t0.nora;
    groups.push({
      key: g.key, name: cut(g.name, 60), img: g.fact?.pic_url || null, kind: t0.kind,
      ok: n ? n.ok : null,                       // 非 Nora 旧工单 ok=null
      why: n ? n.why : cut(t0.next_action, 80).replace(/DeepSeek|MiniMax/g, "复核"), // ⛔ 页面不出模型名
      caution: n ? n.caution : "",
      notes: [...new Set(g.tasks.flatMap((t) => collectNotes(t.next_action)))].slice(0, 3),   // 组内所有工单老板补过的话(最多3条)
      foot: `成本 ${costs.length ? costs.map((c) => "¥" + c).join("/") : "—"} · 货位 ${shelves.length ? shelves.join("/") : "—"} · 月销 ${sales.length ? Math.round(sales.reduce((a, f) => a + (parseFloat(f.month_sale) || 0), 0)) : "—"}`,
      rows: [...rowMap.values()],
    });
  }
  return groups;
}

// ── GET:近 24h 已办(按 batch 聚合,status 映射关联 tasks 现状)────────────
const ASSIGN_LABEL = { clerk: "店员", nora: "Nora", ada: "Ada", claude: "Claude" };
const ASSIGN_TARGET = { nora: "petshop-manager", ada: "pt-03", claude: "claude" }; // clerk 走 agenda,单独建

function actionLabel(x) {
  if (x.action === "boss_decide_batch") return x.decision === "不同意" ? "不同意" : "同意";
  if (x.action === "boss_note") return "补一句";
  if (x.action === "boss_assign") return "转给" + (ASSIGN_LABEL[x.decision] || String(x.decision || "?"));
  return String(x.action || "?");
}

function titlesLabel(titles) {
  return cut(uniq((titles || []).filter(Boolean).map((t) => cut(t, 16))).join(";"), 60);
}

function statusLabel(holders, tstatus) { // 有一条没走完就显示那条;全走完才「已完成」
  let all = "已完成";
  for (let i = 0; i < (holders || []).length; i++) {
    const h = String(holders[i] || "");
    const st = String(tstatus?.[i] || "");
    if (h.startsWith("clerk-agenda:")) return "店员在做";
    if (h === "petshop-manager") return "Nora 在看";
    if (h === "claude") return "排队改价";
    if (!h || ["done", "closed", "cancelled"].includes(st)) continue; // 已走完
    all = "处理中"; // brief 枚举外的兜底(如转给 pt-03 后)
  }
  return all;
}

async function buildDone(pool) {
  const r = await pool.query(`
    SELECT d.batch_id,
           to_char(min(d.created_at) AT TIME ZONE 'Asia/Shanghai', 'HH24:MI') AS at,
           min(d.created_at) AS first_at, max(d.undone_at) AS undone_at,
           (array_agg(d.action ORDER BY d.id))[1] AS action,
           (array_agg(d.decision ORDER BY d.id))[1] AS decision,
           (array_agg(d.note ORDER BY d.id))[1] AS note,
           array_agg(t.title ORDER BY d.id) AS titles,
           array_agg(t.next_holder ORDER BY d.id) AS holders,
           array_agg(t.status ORDER BY d.id) AS tstatus
      FROM boss_decisions d
      LEFT JOIN tasks t ON t.id = d.task_id
     WHERE d.created_at > now() - interval '24 hours'
     GROUP BY d.batch_id
     ORDER BY min(d.created_at) DESC LIMIT 30`);
  return r.rows.map((x) => ({
    batch_id: x.batch_id, at: x.at || "", action: actionLabel(x), note: x.note || "",
    titles: titlesLabel(x.titles), status: statusLabel(x.holders, x.tstatus),
    can_undo: !x.undone_at && !!x.first_at && Date.now() - new Date(x.first_at).getTime() <= 5 * 60 * 1000,
  }));
}

export async function buildBossdesk(pool, me, empId) {
  if (!isBossEmployee(me, empId)) return null; // 非老板:字段干脆不给,前端不显示
  const errors = [];
  const groups = await safe(errors, "待我处理分组", [], () => buildGroups(pool));
  const done = await safe(errors, "已办留痕", [], () => buildDone(pool));
  const out = { groups, done };
  if (errors.length) out.errors = errors; // 表没建(M140 未跑)时这里带出来,不炸整个 manager 页
  return out;
}

// ── POST:4 个 action(返回 false = 不是本模块的,交给老通道)──────────────
const BOSSDESK_ACTIONS = new Set(["boss_decide_batch", "boss_note", "boss_assign", "boss_undo"]);

function taskIdList(v) {
  return uniq((Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim()).filter(Boolean)).slice(0, 50);
}

// prev 快照:undo 按它整行恢复,所以必须在 UPDATE 前取(且只对还在 damon 名下的取)
function snapTask(pre) {
  return JSON.stringify({ next_holder: pre.next_holder, next_action: pre.next_action, damon_feedback: pre.damon_feedback });
}

async function decideBatch(b, res, pool) {
  const items = (Array.isArray(b.items) ? b.items : []).filter((x) => x && x.task_id != null).slice(0, 50);
  if (!items.length) return res.status(400).json({ success: false, error: "items 不能为空" });
  const decision = b.decision === "no" ? "不同意" : "同意";
  const note = String(b.note || "").trim().slice(0, 200);
  const verdict = `Damon 拍板:${decision}${note ? `(${note})` : ""} · ${shanghaiWhen()}`;
  const batchId = newBatchId();
  const c = await pool.connect(); // 事务:一批要么全落要么全回滚,不留半个批次
  try {
    await c.query("BEGIN");
    let count = 0;
    for (const it of items) { // items 里的 kind 只是标记,writeoff/boss 两分支动作相同(同现有 boss_decide)
      const tid = String(it.task_id);
      const pre = (await c.query(
        `SELECT next_holder, next_action, damon_feedback FROM tasks
          WHERE id=$1 AND lower(COALESCE(next_holder,''))='damon'`, [tid])).rows[0];
      if (!pre) continue;
      const r = await c.query(
        `UPDATE tasks
            SET next_holder='claude',
                next_action=$2 || COALESCE(' | old: ' || NULLIF(next_action,''), ''),
                damon_feedback=CASE WHEN COALESCE(damon_feedback,'')='' THEN $3
                                    ELSE damon_feedback || E'\n' || $3 END,
                updated_at=now()
          WHERE id=$1 AND lower(COALESCE(next_holder,''))='damon' RETURNING id`,
        [tid, verdict, verdict]);
      if (!r.rows.length) continue;
      await c.query(
        `INSERT INTO boss_decisions (batch_id, task_id, action, decision, note, prev)
         VALUES ($1,$2,'boss_decide_batch',$3,$4,$5::jsonb)`,
        [batchId, tid, decision, note || null, snapTask(pre)]);
      count++;
    }
    if (!count) { await c.query("ROLLBACK"); return res.status(404).json({ success: false, error: "这些已处理或不在你名下" }); } // 空批回滚:保证没落一条
    await c.query("COMMIT");
    return res.status(200).json({ success: true, batch_id: batchId, count });
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function noteTasks(b, res, pool) {
  const ids = taskIdList(b.task_ids);
  const note = String(b.note || "").trim().slice(0, 200);
  if (!ids.length) return res.status(400).json({ success: false, error: "task_ids 不能为空" });
  if (!note) return res.status(400).json({ success: false, error: "note 不能为空" });
  const fb = `Damon补充:${note} · ${shanghaiWhen()}`;
  const batchId = newBatchId();
  const c = await pool.connect(); // 事务:一批要么全落要么全回滚,不留半个批次
  try {
    await c.query("BEGIN");
    let count = 0;
    for (const tid of ids) {
      const pre = (await c.query(
        `SELECT next_holder, next_action, damon_feedback FROM tasks
          WHERE id=$1 AND lower(COALESCE(next_holder,''))='damon'`, [tid])).rows[0];
      if (!pre) continue;
      const r = await c.query(
        `UPDATE tasks
            SET next_action=$2 || COALESCE(next_action,''),
                damon_feedback=CASE WHEN COALESCE(damon_feedback,'')='' THEN $3
                                    ELSE damon_feedback || E'\n' || $3 END,
                updated_at=now()
          WHERE id=$1 AND lower(COALESCE(next_holder,''))='damon' RETURNING id`, // 不改 holder:只是补话
        [tid, `Damon补充:${note} | `, fb]);
      if (!r.rows.length) continue;
      await c.query(
        `INSERT INTO boss_decisions (batch_id, task_id, action, note, prev) VALUES ($1,$2,'boss_note',$3,$4::jsonb)`,
        [batchId, tid, note, snapTask(pre)]);
      count++;
    }
    if (!count) { await c.query("ROLLBACK"); return res.status(404).json({ success: false, error: "这些已处理或不在你名下" }); } // 空批回滚:保证没落一条
    await c.query("COMMIT");
    return res.status(200).json({ success: true, batch_id: batchId });
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function assignTasks(b, res, pool, me) {
  const ids = taskIdList(b.task_ids);
  const to = String(b.to || "");
  const note = String(b.note || "").trim().slice(0, 200);
  const due = b.due === "tomorrow" ? "明天" : "今天";
  if (!ids.length) return res.status(400).json({ success: false, error: "task_ids 不能为空" });
  if (!ASSIGN_LABEL[to]) return res.status(400).json({ success: false, error: "to 只能是 clerk / nora / ada / claude" });
  const c = await pool.connect(); // 事务:agenda 待办与 tasks 转派同生共死,count=0 全回滚,不留孤儿待办
  try {
    await c.query("BEGIN");
    const pres = (await c.query(
      `SELECT id, title, next_action, next_holder, damon_feedback FROM tasks
        WHERE id = ANY($1::text[]) AND lower(COALESCE(next_holder,''))='damon'`, [ids])).rows;
    if (!pres.length) { await c.query("ROLLBACK"); return res.status(404).json({ success: false, error: "这些已处理或不在你名下" }); }

    let target;
    if (to === "clerk") { // 店员:进今日待办,点圈必须拍照(evidence.need='photo',同 M139 口径)
      const titles = uniq(pres.map((p) => String(p.title || "").trim()).filter(Boolean));
      const a = await c.query(
        `INSERT INTO hr_day_agenda (company_code, work_date, kind, status, title, note, created_by, evidence)
         VALUES ($1,$2,'task','open',$3,$4,'boss','{"need":"photo"}'::jsonb) RETURNING id`,
        [me.company_code, shanghaiToday(), `老板交代:${cut(titles.join("、"), 40)}`,
         (note ? note + "\n" : "") + titles.map((t) => cut(t, 60)).join("\n")]);
      target = `clerk-agenda:${a.rows[0].id}`;
    } else {
      target = ASSIGN_TARGET[to];
    }
    const prefix = note ? `Damon转给${ASSIGN_LABEL[to]}:${note} 限${due}` : `Damon转给${ASSIGN_LABEL[to]}: 限${due}`;
    const batchId = newBatchId();
    let count = 0;
    for (const pre of pres) {
      const r = await c.query(
        `UPDATE tasks
            SET next_holder=$2, next_action=$3 || ' | ' || COALESCE(next_action,''), updated_at=now()
          WHERE id=$1 AND lower(COALESCE(next_holder,''))='damon' RETURNING id`,
        [String(pre.id), target, prefix]);
      if (!r.rows.length) continue;
      await c.query(
        `INSERT INTO boss_decisions (batch_id, task_id, action, decision, note, prev)
         VALUES ($1,$2,'boss_assign',$3,$4,$5::jsonb)`,
        [batchId, String(pre.id), to, note || null, snapTask(pre)]);
      count++;
    }
    if (!count) { await c.query("ROLLBACK"); return res.status(404).json({ success: false, error: "这些已处理或不在你名下" }); } // UPDATE 全没命中:连 agenda 一起回滚,不留孤儿待办
    await c.query("COMMIT");
    return res.status(200).json({ success: true, batch_id: batchId });
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function undoBatch(b, res, pool) {
  const batchId = String(b.batch_id || "").trim();
  if (!batchId) return res.status(400).json({ success: false, error: "缺 batch_id" });
  const rows = (await pool.query(
    `SELECT task_id, prev, created_at FROM boss_decisions
      WHERE batch_id=$1 AND undone_at IS NULL ORDER BY id`, [batchId])).rows;
  if (!rows.length) return res.status(404).json({ success: false, error: "没有可撤回的操作" });
  if (Date.now() - new Date(rows[0].created_at).getTime() > 5 * 60 * 1000) {
    return res.status(400).json({ success: false, error: "已超过5分钟" });
  }
  for (const r of rows) {
    const cur = (await pool.query(`SELECT next_holder FROM tasks WHERE id=$1`, [r.task_id])).rows[0];
    const h = String(cur?.next_holder || "");
    if (h.startsWith("clerk-agenda:")) { // 转给店员的,撤回时把那条待办一并取消
      const aid = Number(h.split(":")[1]);
      if (Number.isInteger(aid) && aid > 0) {
        await pool.query(`UPDATE hr_day_agenda SET status='cancelled' WHERE id=$1`, [aid]);
      }
    }
    const p = r.prev && typeof r.prev === "object" ? r.prev : {};
    await pool.query(
      `UPDATE tasks SET next_holder=$2, next_action=$3, damon_feedback=$4, updated_at=now() WHERE id=$1`,
      [r.task_id, p.next_holder ?? null, p.next_action ?? null, p.damon_feedback ?? null]);
  }
  await pool.query(`UPDATE boss_decisions SET undone_at=now() WHERE batch_id=$1`, [batchId]);
  return res.status(200).json({ success: true });
}

export async function tryBossdeskAction({ action, b, res, pool, me, empId }) {
  if (!BOSSDESK_ACTIONS.has(action)) return false;
  if (!isBossEmployee(me, empId)) {
    res.status(403).json({ success: false, error: "只有老板能操作" });
    return true;
  }
  try {
    if (action === "boss_decide_batch") return await decideBatch(b, res, pool);
    if (action === "boss_note") return await noteTasks(b, res, pool);
    if (action === "boss_assign") return await assignTasks(b, res, pool, me);
    return await undoBatch(b, res, pool);
  } catch (err) { // 决不向上抛:接线在 tryManagerAction 开头,炸了会吃掉老通道
    res.status(500).json({ success: false, error: String(err?.message || err).slice(0, 200) });
    return true;
  }
}
