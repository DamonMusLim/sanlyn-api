#!/usr/bin/env node

import 'dotenv/config';   // 读 /opt/sanlyn-api-test/.env 里的 DATABASE_URL
import pg from 'pg';

const { Pool } = pg;

const WRITE_FLAG = '--write';
const DRY_RUN_FLAG = '--dry-run';

const isWrite = process.argv.includes(WRITE_FLAG);
const isDryRun = !isWrite || process.argv.includes(DRY_RUN_FLAG);

const SOURCE_INVOICE_LINE = '铁证1:进项票逐行';
const SOURCE_INVOICE_AMOUNT = '铁证2:进项票金额';
const SOURCE_ORDER_QTY = '订单箱数';
const SOURCE_ORDER_NAME = '订单品名';
const SOURCE_SINGLE_ORDER_FACTORY = '整票单订单单工厂';
const SOURCE_DECL_ITEM_ORDER = '报关单逐项订单';

const FIELD_FACTORY_COMPANY_ID = 'factory_company_id';
const FIELD_FACTORY_SOURCE = 'factory_source';
const FIELD_FACTORY_CONFLICT = 'factory_conflict';

const CONFIDENCE_IRON = '铁证';
const CONFIDENCE_INFER = '推断';
const CONFIDENCE_NONE = '无';

const STATE_UNRESOLVED = 'unresolved';
const STATE_CONFLICT = 'conflict';

const REASON_AUTO_FILL = 'factory_reconcile 自动补: 铁证命中';
const REASON_SOURCE_UPGRADE = 'factory_reconcile 依据升级: 铁证同厂';
const REASON_CONFLICT = 'factory_reconcile 冲突告警: 铁证与锁定工厂不一致';
const REASON_QUEUE_REBUILD = 'factory_reconcile 重建当前待办队列';

const ORDER_SOURCES = [
  SOURCE_ORDER_QTY,
  SOURCE_ORDER_NAME,
  SOURCE_SINGLE_ORDER_FACTORY,
  SOURCE_DECL_ITEM_ORDER,
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function usageAndExit() {
  console.error('用法: node factory_reconcile.mjs [--dry-run|--write]');
  process.exit(2);
}

if (process.argv.some((arg) => !['node', WRITE_FLAG, DRY_RUN_FLAG].includes(arg) && arg.startsWith('--'))) {
  usageAndExit();
}

function logDetail(title, rows) {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log('  无');
    return;
  }

  for (const row of rows) {
    console.log(
      [
        `  报关单=${row.declaration_no}`,
        `项=${row.sort_order}`,
        `品名=${row.declaration_name_cn ?? ''}`,
        `箱数=${row.qty ?? ''}`,
        `金额=${row.declaration_amount ?? ''}`,
        `旧厂=${row.old_company_id ?? ''}`,
        `新厂=${row.new_company_id ?? row.suggest_company_id ?? ''}`,
        `依据=${row.evidence_source ?? row.suggest_source ?? ''}`,
        row.note ? `备注=${row.note}` : null,
      ]
        .filter(Boolean)
        .join(' | '),
    );
  }
}

/* 清表前把上一轮的 E 档异常快照出来（指纹 + 类型分布），用于判断「有没有变糟」 */
async function snapshotMismatch(client) {
  const t = await client.query(`SELECT to_regclass('public.customs_line_factory_queue') r`);
  if (!t.rows[0].r) return { fps: new Set(), byType: {}, count: 0 };
  const has = await client.query(`
    SELECT count(*) n FROM information_schema.columns
     WHERE table_name='customs_line_factory_queue' AND column_name='fingerprint'`);
  if (!Number(has.rows[0].n)) return { fps: new Set(), byType: {}, count: 0 };
  const rows = (await client.query(
    `SELECT fingerprint, issue_type FROM customs_line_factory_queue
      WHERE fingerprint IS NOT NULL AND state='mismatch'`)).rows;
  const byType = {};
  rows.forEach(x => { byType[x.issue_type] = (byType[x.issue_type] || 0) + 1 });
  return { fps: new Set(rows.map(x => x.fingerprint)), byType, count: rows.length };
}

/* ===== E 档 · 报关逐项 vs 税局退税联 一致性检查（只报不改） =====
   与 forge 两轮评审后定稿（双方 PASS）。要点：
   1) 排在 A自动补 → B升级 → C冲突 之后、D重建队列 之前，基于收敛后的最终状态
   2) 先做匹配唯一性：任一侧 count>1、只有一侧有、item_no 非纯数字 → 全进 match_anomaly，
      不参与金额比对（硬转 int 会错位）
   3) 逐字段比：金额>1元 / 数量>0.01(同单位才比) / 单位不同 / 净重>0.5 / 币制非人民币
      NULL 用 IS DISTINCT FROM 显式判不一致，不靠三值逻辑
   4) ⛔ 一律不改 customs_declaration_items —— 金额是钱，改错直接影响催票额和退税额；
      今天那 10 行里有 3 行必须人判（币制混、抄的是别票的数）
   5) ⛔ 不逐条写 data_guard_log —— 那会把「改动留痕」污染成「每日快照」，
      10 行 × 365 天 = 3650 条把真正的变更淹掉。只在【变糟】时写一条汇总。
      变糟的定义（forge 提的盲点）：总数增加 / 任一 issue_type 增加 / 出现新的异常行
      （即使旧异常消失把总数抵平了） */
async function checkCktsMismatch(client, prevSnap) {
  await client.query(`
    ALTER TABLE customs_line_factory_queue
      ADD COLUMN IF NOT EXISTS issue_type   varchar(32),
      ADD COLUMN IF NOT EXISTS fingerprint  text,
      ADD COLUMN IF NOT EXISTS ours         jsonb,
      ADD COLUMN IF NOT EXISTS theirs       jsonb`);

  const rows = (await client.query(`
    WITH ours AS (
      SELECT cd.declaration_no dn, ci.sort_order so, ci.declaration_name_cn nm,
             ci.qty, ci.unit, ci.declaration_amount amt, ci.declaration_currency cur,
             ci.net_weight_kg nw
        FROM customs_declaration_items ci
        JOIN customs_declarations cd ON cd.id = ci.declaration_id
       WHERE ci.deleted_at IS NULL AND cd.declaration_no ~ '^[0-9]{18}$'
    ),
    theirs AS (
      SELECT k.customs_no dn, k.item_no, k.goods_name nm, k.amount_cny amt,
             k.legal_qty lq, k.legal_unit lu,
             CASE WHEN k.item_no ~ '^[0-9]+$' THEN k.item_no::int END so
        FROM finance_rebate_ckts_lines k
       WHERE k.customs_no ~ '^[0-9]{18}$' AND k.amount_cny IS NOT NULL
    ),
    -- ⚠️ 只比【两边都有这张报关单】的。税局那批只拉了 4–8 月，
    --    我方逐项里大量票税局侧压根没有，FULL JOIN 会把「一边没有」全当异常（实测 451 行噪音）。
    shared_decl AS (
      SELECT dn FROM ours GROUP BY dn
      INTERSECT
      SELECT dn FROM theirs GROUP BY dn
    ),
    -- 行数结构不同（报关行归并/拆分）→ 整票报一条，不逐行刷屏
    shape AS (
      SELECT b.dn,
             (SELECT count(*) FROM ours o WHERE o.dn=b.dn) n_ours,
             (SELECT count(*) FROM theirs t WHERE t.dn=b.dn) n_theirs
        FROM shared_decl b
    ),
    aligned AS (   -- 行数一致的票，才逐项比字段
      SELECT o.dn, o.so, o.nm, o.qty o_qty, o.unit o_unit, o.amt o_amt, o.cur o_cur, o.nw o_nw,
             t.amt t_amt, t.lq t_lq, t.lu t_lu
        FROM ours o
        JOIN shape s ON s.dn = o.dn AND s.n_ours = s.n_theirs
        JOIN theirs t ON t.dn = o.dn AND t.so = o.so
    )
    SELECT dn, so::text item_no, nm, NULL::numeric o_qty, NULL::text o_unit,
           NULL::numeric o_amt, NULL::text o_cur, NULL::numeric o_nw,
           NULL::numeric t_amt, NULL::numeric t_lq, NULL::text t_lu,
           'match_anomaly' issue_type,
           ('我方 '||n_ours||' 行 / 税局 '||n_theirs||' 行') note
      FROM (SELECT dn, NULL::int so, NULL::text nm, n_ours, n_theirs FROM shape WHERE n_ours <> n_theirs) x
    UNION ALL
    SELECT dn, so::text, nm, o_qty, o_unit, o_amt, o_cur, o_nw, t_amt, t_lq, t_lu,
           CASE
             WHEN o_amt IS DISTINCT FROM t_amt AND abs(COALESCE(o_amt,-1) - t_amt) > 1 THEN 'amount_diff'
             WHEN COALESCE(o_cur,'CNY') NOT IN ('CNY','人民币','142') THEN 'currency_flag'
             -- ⛔ 单位不同不算异常：我方记的是【成交单位】（箱），税局记的是【法定单位】（千克），
             --    两个本来就不是一回事，金额一致就说明没问题。
             --    0813 实测不加这条会出 50 行假警报（802346/660860/521266 全是箱 vs 千克）。
             --    只有【单位相同时】才比数量。
             WHEN o_unit IS NOT NULL AND t_lu IS NOT NULL AND o_unit = t_lu
                  AND abs(COALESCE(o_qty,-1) - COALESCE(t_lq,-1)) > 0.01 THEN 'qty_diff'
             WHEN o_nw IS NOT NULL AND t_lu = '千克' AND abs(o_nw - t_lq) > 0.5 THEN 'nw_diff'
           END,
           NULL
      FROM aligned
  `)).rows.filter(r => r.issue_type);

  const byType = {};
  rows.forEach(r => { byType[r.issue_type] = (byType[r.issue_type] || 0) + 1 });
  const fp = r => `${r.dn}#${r.item_no}#${r.issue_type}`;

  const prevFp = prevSnap.fps, prevByType = prevSnap.byType, prevCount = prevSnap.count;

  const nowFp = new Set(rows.map(fp));
  const added = [...nowFp].filter(x => !prevFp.has(x));
  const worse = rows.length > prevCount
    || Object.keys(byType).some(k => (byType[k] || 0) > (prevByType[k] || 0))
    || added.length > 0;

  for (const r of rows) {
    await client.query(`
      INSERT INTO customs_line_factory_queue
        (declaration_no, item_no, goods_name, state, issue_type, fingerprint, ours, theirs, note, refreshed_at)
      VALUES ($1,$2,$3,'mismatch',$4,$5,$6::jsonb,$7::jsonb,$8,NOW())`,
      [r.dn, r.item_no, r.nm, r.issue_type, fp(r),
       JSON.stringify({ qty: r.o_qty, unit: r.o_unit, amount: r.o_amt, currency: r.o_cur, net_weight: r.o_nw }),
       JSON.stringify({ amount: r.t_amt, legal_qty: r.t_lq, legal_unit: r.t_lu }),
       'ckts mismatch - report only, never auto-fix']);
  }

  if (worse) {
    await client.query(`
      INSERT INTO data_guard_log(table_name,row_key,field,old_value,new_value,reason)
      VALUES ('customs_declaration_items','__ckts_mismatch__','ckts_mismatch_summary',$1::text,$2::text,$3)`,
      [JSON.stringify({ count: prevCount, by_type: prevByType }),
       JSON.stringify({ count: rows.length, by_type: byType, newly_added: added.slice(0, 20) }),
       'ckts mismatch got worse (total up / any issue_type up / new anomaly rows)']);
  }

  console.log(`\nE 报关逐项↔税局退税联：不一致 ${rows.length} 行` + (worse ? '  ⚠ 比上次变糟，已写汇总日志' : '  （未变糟，不写日志）'));
  if (rows.length) {
    console.table(rows.map(r => ({
      报关单: r.dn, 项: r.item_no, 品名: r.nm, 类型: r.issue_type,
      我方: r.o_amt, 税局: r.t_amt, 我方数量: (r.o_qty ?? '') + (r.o_unit || ''),
      税局数量: (r.t_lq ?? '') + (r.t_lu || ''),
    })));
  }
  return { count: rows.length, byType, worse };
}

async function main() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 所有中文值都通过参数传入，避免 SQL_ASCII 下中文 SQL 字面量出问题。
    const params = {
      sourceInvoiceLine: SOURCE_INVOICE_LINE,
      sourceInvoiceAmount: SOURCE_INVOICE_AMOUNT,
      orderSources: ORDER_SOURCES,
      fieldFactoryCompanyId: FIELD_FACTORY_COMPANY_ID,
      fieldFactorySource: FIELD_FACTORY_SOURCE,
      fieldFactoryConflict: FIELD_FACTORY_CONFLICT,
      confidenceIron: CONFIDENCE_IRON,
      confidenceInfer: CONFIDENCE_INFER,
      confidenceNone: CONFIDENCE_NONE,
      stateUnresolved: STATE_UNRESOLVED,
      stateConflict: STATE_CONFLICT,
      reasonAutoFill: REASON_AUTO_FILL,
      reasonSourceUpgrade: REASON_SOURCE_UPGRADE,
      reasonConflict: REASON_CONFLICT,
      reasonQueueRebuild: REASON_QUEUE_REBUILD,
    };

    await client.query(`
      CREATE TABLE IF NOT EXISTS customs_line_factory_queue (
        declaration_no text,
        item_no integer,
        goods_name text,
        qty numeric,
        amount numeric,
        order_no text,
        suggest_company_id integer,
        suggest_factory text,
        suggest_source text,
        confidence text,
        state text,
        locked_factory text,
        note text,
        refreshed_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    /* ⚠️ E 档要跟「上一轮」比才能判断有没有变糟，而队列表在这里就被清空了。
       所以必须【先快照再清表】，否则 prev 永远是空、每天都误判成变糟、日志天天刷。 */
    const prevMismatch = await snapshotMismatch(client);

    await client.query('TRUNCATE customs_line_factory_queue');

    // 归一公司别名：name_cn / factory_name / short_name 都算，merged_into_code 再跳到存续公司。
    await client.query(`
      CREATE TEMP TABLE tmp_company_alias ON COMMIT DROP AS
      WITH raw_alias AS (
        SELECT c.id AS alias_company_id, c.code, NULLIF(BTRIM(c.name_cn), '') AS variant FROM companies c
        UNION ALL
        SELECT c.id AS alias_company_id, c.code, NULLIF(BTRIM(c.factory_name), '') AS variant FROM companies c
        UNION ALL
        SELECT c.id AS alias_company_id, c.code, NULLIF(BTRIM(c.short_name), '') AS variant FROM companies c
      ),
      active_company AS (
        SELECT
          c.id,
          c.code,
          c.name_cn,
          c.factory_name,
          c.short_name,
          c.active
        FROM companies c
      ),
      resolved AS (
        SELECT
          r.variant,
          COALESCE(m2.id, m1.id, self.id) AS company_id,
          COALESCE(m2.name_cn, m1.name_cn, self.name_cn) AS company_name,
          COALESCE(m2.factory_name, m1.factory_name, self.factory_name) AS factory_name,
          COALESCE(m2.short_name, m1.short_name, self.short_name) AS short_name,
          COALESCE(m2.active, m1.active, self.active) AS active
        FROM raw_alias r
        JOIN companies self ON self.id = r.alias_company_id
        LEFT JOIN companies m1 ON m1.code = self.merged_into_code
        LEFT JOIN companies m2 ON m2.code = m1.merged_into_code
        WHERE r.variant IS NOT NULL
      )
      SELECT DISTINCT ON (variant)
        variant,
        company_id,
        COALESCE(factory_name, company_name, short_name) AS factory_label
      FROM resolved
      WHERE company_id IS NOT NULL
        AND COALESCE(active, TRUE) IS TRUE
      ORDER BY variant, company_id
    `);

    await client.query('CREATE INDEX ON tmp_company_alias (variant)');

    // 铁证候选：只接受同一项同一档铁证最终唯一指向一家公司的情况。
    await client.query(
      `
      CREATE TEMP TABLE tmp_iron_evidence ON COMMIT DROP AS
      WITH invoice_lines AS (
        SELECT
          i.id AS item_id,
          ca.company_id,
          ca.factory_label,
          $1::text AS evidence_source
        FROM customs_declaration_items i
        JOIN customs_declarations d ON d.id = i.declaration_id
          -- 🔒 只认 18 位真报关单号。提单号当主键的那些行是【模版】
          --    （Damon：「不是说改过来！这是模版！」），绝不能当真单自动填工厂。
          AND d.declaration_no ~ '^[0-9]{18}$'
        JOIN finance_invoices_in fi ON d.declaration_no = ANY(fi.customs_nos)
        JOIN tmp_company_alias ca ON ca.variant = NULLIF(BTRIM(fi.seller_name), '')
        -- ⚠️ line_items 里 qty/amt 可能是空字符串，直接声明成 numeric 会 22P02 报错
        --    （0813 实测整跑失败）。先按 text 取出来，再 NULLIF 安全转。
        CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(fi.line_items, '[]'::jsonb)) AS li(nm text, qty text, amt text)
        WHERE i.deleted_at IS NULL
          AND NULLIF(BTRIM(i.declaration_name_cn), '') = NULLIF(BTRIM(li.nm), '')
          AND i.qty IS NOT DISTINCT FROM NULLIF(BTRIM(li.qty), '')::numeric
      ),
      invoice_amount AS (
        SELECT
          i.id AS item_id,
          ca.company_id,
          ca.factory_label,
          $2::text AS evidence_source
        FROM customs_declaration_items i
        JOIN customs_declarations d ON d.id = i.declaration_id
          -- 🔒 只认 18 位真报关单号。提单号当主键的那些行是【模版】
          --    （Damon：「不是说改过来！这是模版！」），绝不能当真单自动填工厂。
          AND d.declaration_no ~ '^[0-9]{18}$'
        JOIN finance_invoices_in fi ON d.declaration_no = ANY(fi.customs_nos)
        JOIN tmp_company_alias ca ON ca.variant = NULLIF(BTRIM(fi.seller_name), '')
        WHERE i.deleted_at IS NULL
          AND i.declaration_amount IS NOT NULL
          AND fi.amount_incl_tax IS NOT NULL
          AND ABS(fi.amount_incl_tax - i.declaration_amount) < 1
      ),
      all_evidence AS (
        SELECT * FROM invoice_lines
        UNION ALL
        SELECT * FROM invoice_amount
      ),
      unique_by_source AS (
        SELECT
          item_id,
          evidence_source,
          MIN(company_id) AS company_id,
          MIN(factory_label) AS factory_label
        FROM all_evidence
        GROUP BY item_id, evidence_source
        HAVING COUNT(DISTINCT company_id) = 1
      )
      SELECT DISTINCT ON (item_id)
        item_id,
        company_id,
        factory_label,
        evidence_source
      FROM unique_by_source
      ORDER BY
        item_id,
        CASE WHEN evidence_source = $1::text THEN 1 ELSE 2 END
      `,
      [params.sourceInvoiceLine, params.sourceInvoiceAmount],
    );

    await client.query('CREATE INDEX ON tmp_iron_evidence (item_id)');

    // 推断候选只进队列，不直接写 factory_company_id。
    await client.query(
      `
      CREATE TEMP TABLE tmp_infer_evidence ON COMMIT DROP AS
      WITH direct_order AS (
        SELECT
          i.id AS item_id,
          ca.company_id,
          ca.factory_label,
          $1::text AS suggest_source
        FROM customs_declaration_items i
        JOIN orders o ON o.id = i.order_id
        JOIN tmp_company_alias ca ON ca.variant = NULLIF(BTRIM(o.factory), '')
        WHERE i.deleted_at IS NULL
      ),
      order_line_qty AS (
        SELECT
          i.id AS item_id,
          ca.company_id,
          ca.factory_label,
          $2::text AS suggest_source
        FROM customs_declaration_items i
        JOIN customs_declarations d ON d.id = i.declaration_id
          -- 🔒 只认 18 位真报关单号。提单号当主键的那些行是【模版】
          --    （Damon：「不是说改过来！这是模版！」），绝不能当真单自动填工厂。
          AND d.declaration_no ~ '^[0-9]{18}$'
        JOIN orders o ON o.id = i.order_id
        JOIN order_line_items oli ON oli.order_id = o.id
        JOIN tmp_company_alias ca ON ca.variant = NULLIF(BTRIM(o.factory), '')
        WHERE i.deleted_at IS NULL
          AND i.qty IS NOT DISTINCT FROM oli.qty_ctn
      ),
      order_line_name AS (
        SELECT
          i.id AS item_id,
          ca.company_id,
          ca.factory_label,
          $3::text AS suggest_source
        FROM customs_declaration_items i
        JOIN orders o ON o.id = i.order_id
        JOIN order_line_items oli ON oli.order_id = o.id
        JOIN tmp_company_alias ca ON ca.variant = NULLIF(BTRIM(o.factory), '')
        WHERE i.deleted_at IS NULL
          AND NULLIF(BTRIM(i.declaration_name_cn), '') = NULLIF(BTRIM(oli.declaration_name), '')
      ),
      single_factory AS (
        SELECT
          i.id AS item_id,
          MIN(ca.company_id) AS company_id,
          MIN(ca.factory_label) AS factory_label,
          $4::text AS suggest_source
        FROM customs_declaration_items i
        JOIN customs_declarations d ON d.id = i.declaration_id
          -- 🔒 只认 18 位真报关单号。提单号当主键的那些行是【模版】
          --    （Damon：「不是说改过来！这是模版！」），绝不能当真单自动填工厂。
          AND d.declaration_no ~ '^[0-9]{18}$'
        JOIN orders o ON o.id = i.order_id
        JOIN tmp_company_alias ca ON ca.variant = NULLIF(BTRIM(o.factory), '')
        WHERE i.deleted_at IS NULL
        GROUP BY i.id, d.id
        HAVING COUNT(DISTINCT o.id) = 1 AND COUNT(DISTINCT ca.company_id) = 1
      ),
      all_infer AS (
        SELECT * FROM direct_order
        UNION ALL
        SELECT * FROM order_line_qty
        UNION ALL
        SELECT * FROM order_line_name
        UNION ALL
        SELECT * FROM single_factory
      ),
      unique_infer AS (
        SELECT
          item_id,
          MIN(company_id) AS company_id,
          MIN(factory_label) AS factory_label,
          MIN(suggest_source) AS suggest_source
        FROM all_infer
        GROUP BY item_id
        HAVING COUNT(DISTINCT company_id) = 1
      )
      SELECT * FROM unique_infer
      `,
      [
        params.sourceDeclItemOrder ?? SOURCE_DECL_ITEM_ORDER,
        params.sourceOrderQty ?? SOURCE_ORDER_QTY,
        params.sourceOrderName ?? SOURCE_ORDER_NAME,
        params.sourceSingleOrderFactory ?? SOURCE_SINGLE_ORDER_FACTORY,
      ],
    );

    await client.query('CREATE INDEX ON tmp_infer_evidence (item_id)');

    const autoRows = (
      await client.query(
        `
        WITH candidates AS (
          SELECT
            i.id,
            d.declaration_no,
            i.sort_order,
            i.declaration_name_cn,
            i.qty,
            i.declaration_amount,
            i.factory_company_id AS old_company_id,
            e.company_id AS new_company_id,
            e.evidence_source
          FROM customs_declaration_items i
          JOIN customs_declarations d ON d.id = i.declaration_id
          -- 🔒 只认 18 位真报关单号。提单号当主键的那些行是【模版】
          --    （Damon：「不是说改过来！这是模版！」），绝不能当真单自动填工厂。
          AND d.declaration_no ~ '^[0-9]{18}$'
          JOIN tmp_iron_evidence e ON e.item_id = i.id
          WHERE i.deleted_at IS NULL
            AND i.factory_company_id IS NULL
        ),
        upd AS (
          UPDATE customs_declaration_items i
          SET
            factory_company_id = c.new_company_id,
            factory_source = c.evidence_source,
            factory_locked_at = NOW()
          FROM candidates c
          WHERE i.id = c.id
          RETURNING
            c.id,
            c.declaration_no,
            c.sort_order,
            c.declaration_name_cn,
            c.qty,
            c.declaration_amount,
            c.old_company_id,
            c.new_company_id,
            c.evidence_source
        ),
        log_company AS (
          INSERT INTO data_guard_log(table_name, row_key, field, old_value, new_value, reason, created_at)
          SELECT
            'customs_declaration_items',
            id::text,
            $1::text,
            old_company_id::text,
            new_company_id::text,
            $2::text,
            NOW()
          FROM upd
        ),
        log_source AS (
          INSERT INTO data_guard_log(table_name, row_key, field, old_value, new_value, reason, created_at)
          SELECT
            'customs_declaration_items',
            id::text,
            $3::text,
            NULL,
            evidence_source,
            $2::text,
            NOW()
          FROM upd
        )
        SELECT * FROM upd
        ORDER BY declaration_no, sort_order, id
        `,
        [
          params.fieldFactoryCompanyId,
          params.reasonAutoFill,
          params.fieldFactorySource,
        ],
      )
    ).rows;

    const upgradeRows = (
      await client.query(
        `
        WITH candidates AS (
          SELECT
            i.id,
            d.declaration_no,
            i.sort_order,
            i.declaration_name_cn,
            i.qty,
            i.declaration_amount,
            i.factory_company_id AS old_company_id,
            i.factory_company_id AS new_company_id,
            i.factory_source AS old_source,
            e.evidence_source
          FROM customs_declaration_items i
          JOIN customs_declarations d ON d.id = i.declaration_id
          -- 🔒 只认 18 位真报关单号。提单号当主键的那些行是【模版】
          --    （Damon：「不是说改过来！这是模版！」），绝不能当真单自动填工厂。
          AND d.declaration_no ~ '^[0-9]{18}$'
          JOIN tmp_iron_evidence e ON e.item_id = i.id
          WHERE i.deleted_at IS NULL
            AND i.factory_company_id = e.company_id
            AND i.factory_source = ANY($1::text[])
        ),
        upd AS (
          UPDATE customs_declaration_items i
          SET
            factory_source = c.evidence_source,
            factory_locked_at = COALESCE(i.factory_locked_at, NOW())
          FROM candidates c
          WHERE i.id = c.id
          RETURNING
            c.id,
            c.declaration_no,
            c.sort_order,
            c.declaration_name_cn,
            c.qty,
            c.declaration_amount,
            c.old_company_id,
            c.new_company_id,
            c.old_source,
            c.evidence_source
        ),
        log_source AS (
          INSERT INTO data_guard_log(table_name, row_key, field, old_value, new_value, reason, created_at)
          SELECT
            'customs_declaration_items',
            id::text,
            $2::text,
            old_source,
            evidence_source,
            $3::text,
            NOW()
          FROM upd
        )
        SELECT * FROM upd
        ORDER BY declaration_no, sort_order, id
        `,
        [
          params.orderSources,
          params.fieldFactorySource,
          params.reasonSourceUpgrade,
        ],
      )
    ).rows;

    const conflictRows = (
      await client.query(
        `
        WITH conflicts AS (
          SELECT
            i.id,
            d.declaration_no,
            i.sort_order,
            i.declaration_name_cn,
            i.qty,
            i.declaration_amount,
            i.factory_company_id AS old_company_id,
            e.company_id AS new_company_id,
            e.factory_label,
            e.evidence_source,
            COALESCE(c.factory_name, c.name_cn, c.short_name) AS locked_factory
          FROM customs_declaration_items i
          JOIN customs_declarations d ON d.id = i.declaration_id
          -- 🔒 只认 18 位真报关单号。提单号当主键的那些行是【模版】
          --    （Damon：「不是说改过来！这是模版！」），绝不能当真单自动填工厂。
          AND d.declaration_no ~ '^[0-9]{18}$'
          JOIN tmp_iron_evidence e ON e.item_id = i.id
          LEFT JOIN companies c ON c.id = i.factory_company_id
          WHERE i.deleted_at IS NULL
            AND i.factory_company_id IS NOT NULL
            AND i.factory_company_id <> e.company_id
        ),
        log_conflict AS (
          INSERT INTO data_guard_log(table_name, row_key, field, old_value, new_value, reason, created_at)
          SELECT
            'customs_declaration_items',
            id::text,
            $1::text,
            old_company_id::text,
            new_company_id::text,
            $2::text,
            NOW()
          FROM conflicts
        )
        SELECT *
        FROM conflicts
        ORDER BY declaration_no, sort_order, id
        `,
        [
          params.fieldFactoryConflict,
          params.reasonConflict,
        ],
      )
    ).rows;

    await client.query(
      `
      INSERT INTO customs_line_factory_queue (
        declaration_no,
        item_no,
        goods_name,
        qty,
        amount,
        order_no,
        suggest_company_id,
        suggest_factory,
        suggest_source,
        confidence,
        state,
        locked_factory,
        note,
        refreshed_at
      )
      WITH conflict_items AS (
        SELECT
          i.id AS item_id,
          e.company_id AS suggest_company_id,
          e.factory_label AS suggest_factory,
          e.evidence_source AS suggest_source,
          $1::text AS confidence,
          $2::text AS state,
          COALESCE(c.factory_name, c.name_cn, c.short_name) AS locked_factory,
          $3::text AS note
        FROM customs_declaration_items i
        JOIN tmp_iron_evidence e ON e.item_id = i.id
        LEFT JOIN companies c ON c.id = i.factory_company_id
        WHERE i.deleted_at IS NULL
          AND i.factory_company_id IS NOT NULL
          AND i.factory_company_id <> e.company_id
      ),
      unresolved_items AS (
        SELECT
          i.id AS item_id,
          COALESCE(e.company_id, inf.company_id) AS suggest_company_id,
          COALESCE(e.factory_label, inf.factory_label) AS suggest_factory,
          COALESCE(e.evidence_source, inf.suggest_source) AS suggest_source,
          CASE
            WHEN e.company_id IS NOT NULL THEN $1::text
            WHEN inf.company_id IS NOT NULL THEN $4::text
            ELSE $5::text
          END AS confidence,
          $6::text AS state,
          NULL::text AS locked_factory,
          $7::text AS note
        FROM customs_declaration_items i
        LEFT JOIN tmp_iron_evidence e ON e.item_id = i.id
        LEFT JOIN tmp_infer_evidence inf ON inf.item_id = i.id
        WHERE i.deleted_at IS NULL
          AND i.factory_company_id IS NULL
      ),
      queue_rows AS (
        SELECT * FROM conflict_items
        UNION ALL
        SELECT * FROM unresolved_items
      )
      SELECT
        d.declaration_no,
        i.sort_order,
        i.declaration_name_cn,
        i.qty,
        i.declaration_amount,
        o.order_no,
        q.suggest_company_id,
        q.suggest_factory,
        q.suggest_source,
        q.confidence,
        q.state,
        q.locked_factory,
        q.note,
        NOW()
      FROM queue_rows q
      JOIN customs_declaration_items i ON i.id = q.item_id
      JOIN customs_declarations d ON d.id = i.declaration_id
          -- 🔒 只认 18 位真报关单号。提单号当主键的那些行是【模版】
          --    （Damon：「不是说改过来！这是模版！」），绝不能当真单自动填工厂。
          AND d.declaration_no ~ '^[0-9]{18}$'
      LEFT JOIN orders o ON o.id = i.order_id
      ORDER BY d.declaration_no, i.sort_order, i.id
      `,
      [
        params.confidenceIron,
        params.stateConflict,
        params.reasonConflict,
        params.confidenceInfer,
        params.confidenceNone,
        params.stateUnresolved,
        params.reasonQueueRebuild,
      ],
    );

    /* E 档排在 A/B/C 之后、队列明细打印之前：基于收敛后的最终状态比对，
       它自己往队列里插 state='mismatch' 的行，跟 D 档的 unresolved 行并存。 */
    const mismatch = await checkCktsMismatch(client, prevMismatch);

    const queueRows = (
      await client.query(`
        SELECT
          declaration_no,
          item_no AS sort_order,
          goods_name AS declaration_name_cn,
          qty,
          amount AS declaration_amount,
          order_no,
          suggest_company_id,
          suggest_factory,
          suggest_source,
          confidence,
          state,
          locked_factory,
          note
        FROM customs_line_factory_queue
        ORDER BY declaration_no, item_no
      `)
    ).rows;

    const counts = (
      await client.query(`
        SELECT
          (SELECT COUNT(*)::integer FROM customs_declaration_items i WHERE i.factory_locked_at IS NOT NULL) AS readback_marker,
          (SELECT COUNT(*)::integer FROM customs_line_factory_queue) AS queue_count
      `)
    ).rows[0];

    if (isDryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    console.log(`模式: ${isDryRun ? 'dry-run，不落库' : 'write，已落库'}`);
    console.log(`E 不一致 ${mismatch.count} 行` + (mismatch.worse ? '（比上次变糟）' : ''));
    console.log(`自动补 ${autoRows.length} 行 / 升级 ${upgradeRows.length} 行 / 冲突 ${conflictRows.length} 行 / 队列 ${counts.queue_count} 行`);

    logDetail('自动补明细', autoRows);
    logDetail('升级明细', upgradeRows);
    logDetail('冲突明细', conflictRows);
    logDetail('队列明细', queueRows);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 回滚失败时保留原始错误输出。
    }
    console.error('执行失败，已整体 ROLLBACK');
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
