import { getPool, setCors } from "../db.js";

const VIEWS = {
  payments_norm: {
    from: "v_finance_payments_norm",
    orderBy: "id DESC",
    q: ["contract_no", "order_no", "bank_ref"],
  },
  invoices_in_norm: {
    from: "v_finance_invoices_in_norm",
    orderBy: "id DESC",
    q: ["invoice_no", "seller_name", "buyer_name"],
  },
  invoices_out: {
    from: "finance_invoices_out",
    orderBy: "id DESC",
    q: ["invoice_no", "seller_name", "buyer_name"],
    extraSelect: "raw->'recon'->>'status' AS recon_status, raw->'fi'->>'fx_rate' AS fx_rate",
  },
  exceptions: {
    from: "finance_recon_exceptions",
    orderBy: "id DESC",
    q: ["source_id", "invoice_no", "exception_type"],
    defaultPending: true,
  },
  settlement_links: {
    from: "finance_settlement_links",
    orderBy: "id DESC",
    q: ["target_id", "target_type", "source"],
  },
  audit_log: {
    from: "finance_audit_log",
    orderBy: "id DESC",
    q: ["table_name", "row_id", "field"],
  },
};

function clampLimit(value) {
  const n = Number.parseInt(value || "200", 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(n, 1000);
}

function parseOffset(value) {
  const n = Number.parseInt(value || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function addWhere(parts, params, clause, value) {
  params.push(value);
  parts.push(clause.replace("?", `$${params.length}`));
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return req.body;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!req.user || ["customer", "factory"].includes(req.user.role)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  if (req.method === "POST") {
    const body = parseBody(req);
    if (body.action !== "resolve_exception") {
      return res.status(400).json({ ok: false, error: "bad_action" });
    }
    const id = Number.parseInt(body.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });

    const username = req.user.username || "admin";
    const note = String(body.note || "");

    try {
      const pool = getPool();
      const result = await pool.query(
        `UPDATE finance_recon_exceptions
         SET status='resolved', resolved_at=now(), resolved_by=$2
         WHERE id=$1 AND status='pending'`,
        [id, username]
      );
      if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "not_found" });

      await pool.query(
        `INSERT INTO finance_audit_log
          (table_name, row_id, field, old_value, new_value, actor, source, reason)
         VALUES
          ('finance_recon_exceptions', $1, 'status', 'pending', 'resolved', $2, 'finance-views', $3)`,
        [id, username, note]
      );
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[finance-views:resolve_exception]", err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  const cfg = VIEWS[String(req.query.view || "")];
  if (!cfg) return res.status(400).json({ ok: false, error: "bad_view" });

  const limit = clampLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  const where = [];
  const params = [];
  const q = String(req.query.q || "").trim();

  if (cfg.defaultPending && req.query.status !== "all") {
    addWhere(where, params, "status = ?", String(req.query.status || "pending"));
  }
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(`(${cfg.q.map(col => `${col}::text ILIKE ${p}`).join(" OR ")})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const selectSql = cfg.extraSelect ? `*, ${cfg.extraSelect}` : "*";
  const countSql = `SELECT COUNT(*)::int AS total FROM ${cfg.from} ${whereSql}`;
  const rowsSql = `
    SELECT ${selectSql}
    FROM ${cfg.from}
    ${whereSql}
    ORDER BY ${cfg.orderBy}
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;

  try {
    const pool = getPool();
    const [countResult, rowsResult] = await Promise.all([
      pool.query(countSql, params),
      pool.query(rowsSql, [...params, limit, offset]),
    ]);
    return res.status(200).json({
      ok: true,
      rows: rowsResult.rows,
      total: countResult.rows[0]?.total || 0,
    });
  } catch (err) {
    console.error("[finance-views]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
