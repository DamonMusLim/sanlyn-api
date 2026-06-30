const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function assertIdent(value, name) {
  if (!IDENT_RE.test(value || "")) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value;
}

function validateConfig(config) {
  if (!config || !config.source || !Array.isArray(config.items)) {
    throw new Error("Invalid closure config");
  }

  const { table, keyCol, dateCol, labelCol } = config.source;
  assertIdent(table, "source.table");
  assertIdent(keyCol, "source.keyCol");
  assertIdent(dateCol, "source.dateCol");
  if (labelCol) assertIdent(labelCol, "source.labelCol");

  config.items.forEach((item, index) => {
    if (!item || !item.key || !item.doneSql) {
      throw new Error(`Invalid config.items[${index}]`);
    }
    if (item.deadlineCol) {
      assertIdent(item.deadlineCol, `config.items[${index}].deadlineCol`);
    }
  });
}

function buildQuery(config) {
  const { table, keyCol, dateCol, labelCol } = config.source;

  const selectCols = [
    `src.${keyCol} AS __key`,
    labelCol ? `src.${labelCol} AS __label` : `src.${keyCol} AS __label`,
    `GREATEST((CURRENT_DATE - src.${dateCol}::date), 0)::int AS __stuck_days`,
  ];

  const joins = [];

  config.items.forEach((item, index) => {
    const alias = `item_${index}`;

    selectCols.push(`COALESCE(${alias}.done, false) AS __done_${index}`);
    selectCols.push(`${alias}.doc_url AS __doc_url_${index}`);

    if (item.deadlineCol) {
      selectCols.push(
        `CASE WHEN src.${item.deadlineCol} IS NULL THEN NULL ELSE (src.${item.deadlineCol}::date - CURRENT_DATE)::int END AS __days_to_deadline_${index}`,
      );
    } else {
      selectCols.push(`NULL::int AS __days_to_deadline_${index}`);
    }

    joins.push(`
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(done_row.done, false)::boolean AS done,
          done_row.doc_url::text AS doc_url
        FROM (${item.doneSql}) done_row
        LIMIT 1
      ) ${alias} ON true
    `);
  });

  return `
    SELECT
      ${selectCols.join(",\n      ")}
    FROM ${table} src
    ${joins.join("\n")}
    WHERE ($1::date IS NULL OR src.${dateCol}::date >= $1::date)
      AND ($2::date IS NULL OR src.${dateCol}::date <= $2::date)
    ORDER BY src.${dateCol} DESC NULLS LAST, src.${keyCol}
  `;
}

function rowUrgency(missingDeadlineDays) {
  if (!missingDeadlineDays.length) {
    return { urgency: "normal", days_to_deadline: null };
  }

  const days_to_deadline = Math.min(...missingDeadlineDays);

  if (days_to_deadline < 0) {
    return { urgency: "overdue", days_to_deadline };
  }
  if (days_to_deadline <= 3) {
    return { urgency: "urgent", days_to_deadline };
  }
  return { urgency: "normal", days_to_deadline };
}

function mapRow(row, config) {
  const items = {};
  let stage = "已闭环";
  let owner = null;
  const missingDeadlineDays = [];

  config.items.forEach((item, index) => {
    const done = row[`__done_${index}`] === true;
    const docUrl = row[`__doc_url_${index}`] ?? null;
    const status = done ? "done" : "missing";

    items[item.key] = {
      status,
      doc_url: docUrl,
    };

    if (!done && stage === "已闭环") {
      stage = item.key;
      owner = item.owner || null;
    }

    const days = row[`__days_to_deadline_${index}`];
    if (!done && item.deadlineCol && Number.isInteger(days)) {
      missingDeadlineDays.push(days);
    }
  });

  const urgency = rowUrgency(missingDeadlineDays);

  return {
    key: row.__key,
    label: row.__label,
    stage,
    owner,
    urgency: urgency.urgency,
    days_to_deadline: urgency.days_to_deadline,
    items,
    stuck_days: row.__stuck_days,
  };
}

export async function getClosure(pool, config, { from, to } = {}) {
  validateConfig(config);

  const sql = buildQuery(config);
  const params = [from || null, to || null];
  const { rows } = await pool.query(sql, params);

  return rows.map((row) => mapRow(row, config));
}
