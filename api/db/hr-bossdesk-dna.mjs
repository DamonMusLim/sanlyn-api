// hr-bossdesk-dna.mjs — 老板拍板落 Nora DNA 先例(M141 nora_dna_cases)的库侧函数
//
// 0929 从 hr-bossdesk.mjs 拆出(审核单第7条:主文件超500行,DNA 相关独立,行为不变):
//   dnaPrep          拍板/补话前取工单+商品事实快照(表没建 → null,不挡主流程)
//   dnaCaseForDecide 拍板写 case(damon_decision=同意/不同意)
//   dnaCaseForNote   补话:并进最近一条未撤销 case 的 damon_note,没有 → 新建 decision=null 的 case
//   dnaRevokeBatch   撤销:该批 case 一并作废
// 读取侧在 ~/wt-nora-review/nora-review.mjs(命中「不同意」先例不再升同类问题)。
// kindLabel/parseNora/extractCodes/brandOf 是先例匹配键(kind/code/brand/Nora结论)的抽取口径,
// 两边必须同源,所以一并放这里;hr-bossdesk.mjs 从本文件 import(单向依赖,本文件不回 import,避免环)。

const uniq = (a) => [...new Set(a)];
const cut = (s, n) => Array.from(String(s ?? "")).slice(0, n).join("");

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

// 品牌词:「」里的优先,否则商品名第一个英文单词;都拿不准 → null(Nora 侧只按有把握的匹配)
function brandOf(name) {
  const s = String(name || "").trim();
  const zh = s.match(/「([^」]{1,20})」/);
  if (zh) return cut(zh[1].split(/[\s/·]+/)[0], 20) || null;
  const en = s.match(/\b[A-Za-z][A-Za-z&'.-]{1,19}\b/);
  return en ? en[0] : null;
}

// ── DNA 先例(M141,0930 Damon:「有 dna 处理么?以后一些问题,类似的就不用问我了」)──
// 表没建(M141 未跑)时 dnaPrep 返回 null:DNA 不写,不挡拍板/补话主流程。
async function dnaPrep(pool, ids) {
  try {
    if (!(await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name='nora_dna_cases'`)).rows.length) return null;
    const ts = (await pool.query(
      `SELECT id::text AS id, title, next_action,
              CASE WHEN status IN ('open','pending_review') AND source='dataops'
                    AND (COALESCE(title,'') ~ '报损' OR COALESCE(dedupe_key,'') ~ 'writeoff|loss|risk')
                   THEN 'writeoff' ELSE 'boss' END AS src
         FROM tasks WHERE id = ANY($1::text[])`, [uniq(ids)])).rows;
    const allCodes = uniq(ts.flatMap((t) => extractCodes(t)));
    const facts = new Map(); // 码 → 当时商品事实快照(kindLabel/brand/落库 facts 共用)
    if (allCodes.length) {
      const fr = await pool.query(`
        SELECT k.product_code, k.product_name, k.cost_price::text AS cost_price, k.out_price::text AS out_price,
               k.stock_num::text AS stock_num, r.store_price::text AS store_price, e.expiration_date::text AS expiration_date
          FROM petstore_skus k
          LEFT JOIN petstore_ops_row r ON r.product_code = k.product_code
          LEFT JOIN LATERAL (SELECT x.expiration_date FROM petstore_offline_expiry_snapshot x
                              WHERE x.product_code = k.product_code ORDER BY x.captured_at DESC LIMIT 1) e ON true
         WHERE k.product_code = ANY($1::text[])`, [allCodes]);
      for (const f of fr.rows) facts.set(String(f.product_code), f);
    }
    const byTask = new Map();
    for (const t of ts) {
      const codes = extractCodes(t);
      byTask.set(String(t.id), {
        kind: kindLabel(t), codes, nora: parseNora(t.next_action),
        brand: brandOf(facts.get(codes[0] || "")?.product_name),
      });
    }
    return { byTask, facts };
  } catch (e) {
    console.error("[bossdesk-dna] dnaPrep失败:", e?.message || e); // 0929 审核单第6条:静默改留痕
    return null;
  }
}

function insertDnaCase(c, d) {
  return c.query(
    `INSERT INTO nora_dna_cases (task_id,kind,product_code,brand,nora_decision,nora_reason,damon_decision,damon_note,facts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [d.tid, d.kind || null, d.code || null, d.brand || null, d.nd || null, d.nr || null,
     d.dd ?? null, d.dn || null, JSON.stringify(d.facts)]);
}

export async function dnaCaseForDecide(c, dna, tid, decision, note, batchId) {
  if (!dna) return;
  const p = dna.byTask.get(tid);
  if (!p) return;
  await insertDnaCase(c, {
    tid, kind: p.kind, code: p.codes[0], brand: p.brand,
    nd: p.nora?.ok === true ? "批" : p.nora?.ok === false ? "不批" : null,
    nr: p.nora?.why || null, dd: decision, dn: note,
    facts: { batch_id: batchId, codes: p.codes, rows: p.codes.map((x) => dna.facts.get(x)).filter(Boolean) },
  });
}

export async function dnaCaseForNote(c, dna, tid, note, batchId) {
  if (!dna) return;
  const p = dna.byTask.get(tid) || { kind: null, codes: [], nora: null, brand: null };
  const u = await c.query(
    `UPDATE nora_dna_cases
        SET damon_note=CASE WHEN COALESCE(damon_note,'')='' THEN $2 ELSE damon_note || E'; ' || $2 END
      WHERE id=(SELECT id FROM nora_dna_cases WHERE task_id=$1 AND revoked_at IS NULL
                 ORDER BY decided_at DESC, id DESC LIMIT 1) RETURNING id`, [tid, note]);
  if (!u.rows.length) await insertDnaCase(c, {
    tid, kind: p.kind, code: p.codes[0], brand: p.brand,
    nd: p.nora?.ok === true ? "批" : p.nora?.ok === false ? "不批" : null,
    nr: p.nora?.why || null, dd: null, dn: note,
    facts: { batch_id: batchId, codes: p.codes, rows: p.codes.map((x) => dna.facts.get(x)).filter(Boolean) },
  });
}

export async function dnaRevokeBatch(pool, batchId) {
  try { // 撤销把该批 DNA 先例一并作废(表没建/M141 未跑时忽略,不挡撤回)
    await pool.query(`UPDATE nora_dna_cases SET revoked_at=now() WHERE revoked_at IS NULL AND facts->>'batch_id'=$1`, [batchId]);
  } catch (e) {
    console.error("[bossdesk-dna] 撤销作废DNA失败:", e?.message || e); // 0929 审核单第6条:静默改留痕
  }
}

export { uniq, cut, parseNora, kindLabel, extractCodes, dnaPrep };
