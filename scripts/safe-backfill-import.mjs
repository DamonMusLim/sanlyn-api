// safe-backfill-import.mjs — B 类数据批量导入 (幂等 + 非破坏) · v4
// 2026-05-23 · 配套 docs/import-templates/ · 经 Mini Codex 多轮审核
//
// 第一铁律: 绝不破坏存量数据。
//   - 按唯一匹配键 UPDATE 现有行; 绝不 INSERT/DROP/TRUNCATE
//   - 只填空字段: 目标列 IS NULL (文本列再含 btrim='') 才写; 非空行不触碰
//   - --force-overwrite 才覆盖非空, 且必须叠加 --yes-overwrite 二次确认
//   - 匹配键必须在 DB 有单列唯一索引(运行时核验), 否则 die (除非 --allow-multi 显式承担风险)
//   - 幂等: 同文件重跑结果一致; CSV 重复键/重复表头/行宽不齐/未闭合或裸引号 → 报错中止
//   - plan 与 apply 同事务内完成, 受影响行 SELECT...FOR UPDATE 加锁 → 无竞态
//   - dry-run: 同样事务内规划, 末尾 ROLLBACK; 按"DB 实际会变更的行"精确计数
//   - apply: 事务内先全表快照备份(同基线); 备份名带时间戳+随机后缀
//   - 审计与回滚文件在 COMMIT 之前写盘; 写盘失败则 ROLLBACK (保证"改了库就一定有回滚脚本")
//   - 回滚以行主键 id 寻址 + 值守卫(IS NOT DISTINCT FROM) → 对唯一键/多行匹配都精确, 不误伤后续修改
//   - 列/表/键全白名单; 标识符引用; 值参数化; 键比较统一 ::text (兼容 int/uuid)
//   - 无 orders×products JOIN (单表 UPDATE, 无笛卡尔)
//
// Usage:
//   node scripts/safe-backfill-import.mjs --table products --file path.csv            (dry-run)
//   node scripts/safe-backfill-import.mjs --table products --file path.csv --apply     (真跑)
//   选项: --match-key <col> --allow-multi --force-overwrite --yes-overwrite

import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import crypto from 'crypto';

const ROW_PK = 'id'; // 三张表都有唯一 id, 用作回滚/审计的行寻址列
const TABLES = {
  products: {
    uniqueKeys: ['id'], multiKeys: ['sku'],
    columns: ['factory_code','net_weight','gross_weight','cbm','carton_qty','box_l','box_w','box_h',
              'brand_authorization_no','factory_registration_no','shelf_life_days'],
    defaultKey: 'id',
  },
  orders:         { uniqueKeys: ['id'], multiKeys: [], columns: ['pi_no','sc_no'], defaultKey: 'id' },
  shipping_plans: { uniqueKeys: ['id','_id'], multiKeys: [], columns:
              ['doc_cutoff','cargo_cutoff','booking_no','so_no','hbl_no','mbl_no','vessel','etd','container_type'],
              defaultKey: 'id' },
};
const EXAMPLE_KEY = '__EXAMPLE_DELETE_THIS_ROW__';
const TEXT_TYPES = new Set(['text', 'character varying']);

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`); if (i === -1) return def;
  const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true;
}
const TABLE = arg('table'), FILE = arg('file');
const APPLY = process.argv.includes('--apply');
const ALLOW_MULTI = process.argv.includes('--allow-multi');
const FORCE = process.argv.includes('--force-overwrite');
const YES_OVERWRITE = process.argv.includes('--yes-overwrite');
const MATCH_KEY_ARG = arg('match-key');
function die(m) { console.error(`\n❌ ${m}\n`); process.exit(1); }

if (!TABLE || !FILE) die('必填: --table <products|orders|shipping_plans> --file <csv>');
const cfg = TABLES[TABLE]; if (!cfg) die(`未知表 "${TABLE}" (仅: ${Object.keys(TABLES).join(', ')})`);
if (!fs.existsSync(FILE)) die(`找不到文件: ${FILE}`);
const matchKey = MATCH_KEY_ARG || cfg.defaultKey;
const isUnique = cfg.uniqueKeys.includes(matchKey), isMulti = cfg.multiKeys.includes(matchKey);
if (!isUnique && !isMulti) die(`匹配键 "${matchKey}" 不在 ${TABLE} 键白名单 (唯一:${cfg.uniqueKeys.join('/')}; 多行:${cfg.multiKeys.join('/')||'无'})`);
if (isMulti && !ALLOW_MULTI) die(`"${matchKey}" 非唯一键, 必须 --allow-multi 且经 Damon 确认`);
if (FORCE && !YES_OVERWRITE) die(`--force-overwrite 是高风险(覆盖非空)! 必须叠加 --yes-overwrite 二次确认.`);

// ── 严格 RFC4180 解析 (拒绝裸引号/未闭合引号) ─────────────────────────────────
function parseCSV(text) {
  const rows = []; let row = [], f = '';
  let st = 'field'; // field(字段起始) | unq(无引号中) | inq(引号中) | post(闭合引号后)
  const endField = () => { row.push(f); f = ''; st = 'field'; };
  const endRow = () => { row.push(f); rows.push(row); row = []; f = ''; st = 'field'; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (st === 'field') {
      if (c === '"') st = 'inq';
      else if (c === ',') { row.push(''); }
      else if (c === '\n') { endRow(); }
      else if (c === '\r') {}
      else { f = c; st = 'unq'; }
    } else if (st === 'unq') {
      if (c === '"') die(`CSV 第 ${rows.length+1} 行无引号字段内出现裸引号 " (疑似格式损坏)`);
      else if (c === ',') endField();
      else if (c === '\n') endRow();
      else if (c === '\r') {}
      else f += c;
    } else if (st === 'inq') {
      if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else st = 'post'; }
      else f += c;
    } else { // post
      if (c === ',') endField();
      else if (c === '\n') endRow();
      else if (c === '\r') {}
      else die(`CSV 第 ${rows.length+1} 行引号闭合后出现非法字符 (只允许逗号/换行/结束)`);
    }
  }
  if (st === 'inq') die('CSV 格式损坏: 存在未闭合的引号');
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const raw = parseCSV(fs.readFileSync(FILE, 'utf8'));
if (raw.length < 1) die('CSV 为空');
const header = raw[0].map(h => h.trim());
const dataRows = raw.slice(1);
if (header[0] !== matchKey) die(`CSV 第一列必须是匹配键 "${matchKey}", 实为 "${header[0]}"`);
if (new Set(header).size !== header.length) die(`CSV 表头有重复列名`);
const dataCols = header.slice(1);
const bad = dataCols.filter(c => !cfg.columns.includes(c));
if (bad.length) die(`CSV 含不允许的列: ${bad.join(', ')}\n  ${TABLE} 仅允许: ${cfg.columns.join(', ')}`);
if (!dataCols.length) die('CSV 除匹配键外无数据列');
dataRows.forEach((r, i) => { if (r.length !== header.length) die(`第 ${i+2} 行列数 ${r.length} ≠ 表头 ${header.length}`); });

const csvRows = []; const seen = new Map();
dataRows.forEach((r, i) => {
  const k = (r[0] ?? '').trim();
  if (!k || k === EXAMPLE_KEY) return;
  if (seen.has(k)) die(`CSV 内匹配键 "${k}" 重复 (第 ${seen.get(k)+2} 与 ${i+2} 行)`);
  seen.set(k, i);
  const vals = {};
  dataCols.forEach((c, idx) => { const v = (r[idx+1] ?? '').trim(); if (v !== '') vals[c] = v; });
  csvRows.push({ key: k, vals });
});

const pool = new pg.Pool({
  host: process.env.PG_HOST, port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false, max: 3,
});
const Q = (s) => `"${s.replace(/"/g, '""')}"`;
const lit = (v) => v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
function castType(dt) {
  switch (dt) {
    case 'integer': case 'bigint': case 'smallint': return 'bigint';
    case 'numeric': case 'double precision': case 'real': return 'numeric';
    case 'date': return 'date';
    case 'timestamp without time zone': return 'timestamp';
    case 'timestamp with time zone': return 'timestamptz';
    case 'boolean': return 'boolean';
    default: return 'text';
  }
}
const emptyCond = (col, dt) => TEXT_TYPES.has(dt) ? `(${Q(col)} IS NULL OR btrim(${Q(col)})='')` : `${Q(col)} IS NULL`;

(async () => {
  const client = await pool.connect();
  let committed = false;
  try {
    console.log(`\n══ safe-backfill-import v4 ══`);
    console.log(`表=${TABLE}  匹配键=${matchKey}  数据列=[${dataCols.join(',')}]`);
    console.log(`模式=${APPLY ? '🔴 APPLY' : '🟢 DRY-RUN'}  策略=${FORCE ? '⚠️ 覆盖非空' : '只填空'}  allow-multi=${ALLOW_MULTI}\n`);

    const typeRows = (await client.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [TABLE])).rows;
    const colType = Object.fromEntries(typeRows.map(r => [r.column_name, r.data_type]));
    for (const c of [matchKey, ROW_PK, ...dataCols]) if (!colType[c]) die(`列 "${c}" 在表 ${TABLE} 不存在`);

    // 唯一性核验: 必须是"全表单列唯一索引" — 排除部分索引(indpred)与表达式索引(indexprs),
    // 它们只能证明子集/表达式唯一, 不能证明整表按该列唯一
    const uq = (await client.query(
      `SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
        WHERE i.indrelid=('public.'||$1)::regclass AND i.indisunique AND i.indnatts=1
          AND i.indpred IS NULL AND i.indexprs IS NULL AND a.attname=$2 LIMIT 1`,
      [TABLE, matchKey])).rows.length > 0;
    if (!uq && !ALLOW_MULTI) die(`匹配键 "${matchKey}" 在 DB 无单列唯一索引, 无法保证唯一匹配. 请改用有唯一约束的键, 或显式 --allow-multi 承担风险.`);
    console.log(`匹配键 DB 唯一约束: ${uq ? '✅ 有' : '⚠️ 无(--allow-multi)'}\n`);

    const emptySel = dataCols.map(c => `COUNT(*) FILTER (WHERE ${emptyCond(c, colType[c])}) AS ${Q(c)}`).join(', ');
    const keys = csvRows.map(r => r.key);

    await client.query('BEGIN');
    if (keys.length) await client.query(`SELECT 1 FROM public.${Q(TABLE)} WHERE ${Q(matchKey)}::text = ANY($1) FOR UPDATE`, [keys]);
    const before = (await client.query(`SELECT ${emptySel} FROM public.${Q(TABLE)}`)).rows[0];

    const mc = new Map();
    if (keys.length) (await client.query(
      `SELECT ${Q(matchKey)}::text AS k, COUNT(*)::int AS n FROM public.${Q(TABLE)} WHERE ${Q(matchKey)}::text = ANY($1) GROUP BY 1`, [keys]
    )).rows.forEach(r => mc.set(r.k, r.n));

    const plan = { noMatch: 0, multiSkip: 0 }; const multiReport = [];
    const colWrites = Object.fromEntries(dataCols.map(c => [c, []]));
    const validKeys = [];
    for (const cr of csvRows) {
      const n = mc.get(cr.key) || 0;
      if (n === 0) { plan.noMatch++; continue; }
      if (n > 1 && !ALLOW_MULTI) { plan.multiSkip++; continue; }
      if (n > 1) multiReport.push(`${cr.key}→${n}行`);
      validKeys.push(cr.key);
      for (const [col, val] of Object.entries(cr.vals)) colWrites[col].push({ key: cr.key, val });
    }
    if (plan.multiSkip > 0 && !ALLOW_MULTI) die(`匹配键有 ${plan.multiSkip} 个值命中多行! 拒绝部分导入.`);

    // 每列采集"将变更行"(以行主键 id 寻址) + 旧值/新值 → 精确 dry-run/审计/回滚
    const perColWillChange = {}; const audit = [];
    for (const col of dataCols) {
      const ws = colWrites[col]; if (!ws.length) { perColWillChange[col] = 0; continue; }
      const params = []; const vrows = ws.map((w, i) => { params.push(w.key, w.val); return `($${i*2+1}::text, $${i*2+2}::text)`; });
      const cond = FORCE ? 'TRUE' : emptyCond(col, colType[col]);
      const sel = `SELECT t.${Q(ROW_PK)}::text AS rid, t.${Q(col)}::text AS oldv, w.newv AS newv
                     FROM public.${Q(TABLE)} t
                     JOIN (VALUES ${vrows.join(',')}) AS w(k, newv) ON t.${Q(matchKey)}::text = w.k
                    WHERE ${cond}`;
      const chRows = (await client.query(sel, params)).rows;
      perColWillChange[col] = chRows.length;
      for (const cr of chRows) audit.push({ rid: cr.rid, col, oldv: cr.oldv, newv: cr.newv, castT: castType(colType[col]) });
    }

    console.log(`── 规划结果 ──`);
    console.log(`匹配键(有效): ${validKeys.length}  跳过-无匹配:${plan.noMatch}  多行匹配:${plan.multiSkip}`);
    console.log(`各列实际将变更行数:`, perColWillChange);
    if (ALLOW_MULTI && multiReport.length) console.log(`⚠️ 多行匹配键:`, multiReport);
    console.log(`各列当前"空"数(NULL或空串):`, before);

    if (!APPLY) { await client.query('ROLLBACK'); console.log(`\n🟢 DRY-RUN 完成(已 ROLLBACK), 未写库.\n`); return; }
    if (!audit.length) { await client.query('ROLLBACK'); console.log(`\n无可写单元格, 未写库.\n`); return; }

    const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const bkp = `_import_backup_${TABLE}_${ts}_${crypto.randomBytes(3).toString('hex')}`;
    await client.query(`CREATE TABLE public.${Q(bkp)} AS SELECT * FROM public.${Q(TABLE)}`);

    // 以行主键 id 寻址的精确 UPDATE (只更新已审计的行)
    let updated = 0;
    for (const col of dataCols) {
      const cells = audit.filter(a => a.col === col); if (!cells.length) continue;
      const ct = cells[0].castT;
      const params = []; const vrows = cells.map((a, i) => { params.push(a.rid, a.newv); return `($${i*2+1}::text, $${i*2+2}::text)`; });
      const sql = `UPDATE public.${Q(TABLE)} t SET ${Q(col)} = w.newv::${ct}
                     FROM (VALUES ${vrows.join(',')}) AS w(rid, newv)
                    WHERE t.${Q(ROW_PK)}::text = w.rid`;
      updated += (await client.query(sql, params)).rowCount;
    }
    const after = (await client.query(`SELECT ${emptySel} FROM public.${Q(TABLE)}`)).rows[0];

    // ── COMMIT 前写盘: 审计 + 精确回滚 (写盘失败 → finally ROLLBACK, 保证"改库必有回滚") ──
    const tsvEsc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    const auditFile = `${FILE}.audit_${ts}.tsv`;
    fs.writeFileSync(auditFile, 'row_id\tcolumn\told_value\tnew_value\n' +
      audit.map(a => `${tsvEsc(a.rid)}\t${tsvEsc(a.col)}\t${tsvEsc(a.oldv)}\t${tsvEsc(a.newv)}`).join('\n') + '\n');

    let rb = `-- Rollback for import into ${TABLE} @ ${ts}\n-- 以行主键 ${ROW_PK} 寻址 + 值守卫: 仅回退本次实际写入且至今未被改动的单元格\nBEGIN;\n`;
    for (const col of dataCols) {
      const cells = audit.filter(a => a.col === col); if (!cells.length) continue;
      const ct = cells[0].castT;
      const vlist = cells.map(a => `(${lit(a.rid)}, ${a.oldv === null ? 'NULL' : lit(a.oldv)}, ${lit(a.newv)})`).join(',\n    ');
      rb += `UPDATE public.${Q(TABLE)} t SET ${Q(col)} = w.oldv::${ct}\n` +
            `  FROM (VALUES\n    ${vlist}\n  ) AS w(rid, oldv, newv)\n` +
            ` WHERE t.${Q(ROW_PK)}::text = w.rid AND t.${Q(col)} IS NOT DISTINCT FROM w.newv::${ct};\n`;
    }
    rb += `COMMIT;\n-- 确认后可清理快照: DROP TABLE public.${Q(bkp)};\n`;
    const rbFile = `${FILE}.rollback_${ts}.sql`;
    fs.writeFileSync(rbFile, rb);

    await client.query('COMMIT'); committed = true;

    console.log(`\n── APPLY 完成 ──`);
    console.log(`实际 UPDATE 影响行(累计): ${updated}`);
    console.log(`📦 备份: public.${bkp}`);
    console.log(`各列"空"数 BEFORE → AFTER:`);
    for (const c of dataCols) console.log(`  ${c}: ${before[c]} → ${after[c]}`);
    console.log(`📝 审计: ${auditFile} (${audit.length} 单元格)`);
    console.log(`↩️  精确回滚: ${rbFile}`);
    console.log(`✅ 完成.\n`);
  } catch (e) {
    if (!committed) { try { await client.query('ROLLBACK'); } catch {} }
    die(`失败已 ROLLBACK (存量未改, 无残留备份/部分写入). 错误: ${e.message}`);
  } finally {
    if (!committed) { try { await client.query('ROLLBACK'); } catch {} }
    client.release(); await pool.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
