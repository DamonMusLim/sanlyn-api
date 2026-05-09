import { getPool, setCors } from "../db.js";

// QC Checks API
//   GET    /api/qc-checks?order_contract_no=FS...   -> list by order
//   GET    /api/qc-checks?product_id=123            -> list by product
//   GET    /api/qc-checks?review_status=pending     -> list pending review
//   POST   /api/qc-checks                           -> create QC record
//   PATCH  /api/qc-checks?id=N                      -> update (review, fix)

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();

    // ---- GET ----
    if (req.method === "GET") {
      var { order_contract_no, product_id, review_status, qc_result, factory_code, limit = 200 } = req.query;
      var conds = [], vals = [];
      if (order_contract_no) { vals.push(order_contract_no); conds.push("order_contract_no = $" + vals.length); }
      if (product_id)        { vals.push(parseInt(product_id)); conds.push("product_id = $" + vals.length); }
      if (review_status)     { vals.push(review_status); conds.push("review_status = $" + vals.length); }
      if (qc_result)         { vals.push(qc_result); conds.push("qc_result = $" + vals.length); }
      if (factory_code)      { vals.push(factory_code); conds.push("factory_code = $" + vals.length); }
      var where = conds.length ? " WHERE " + conds.join(" AND ") : "";
      vals.push(parseInt(limit));
      var sql = `
        SELECT q.*, p.product_name, p.product_name_cn, p.sku, p.shelf_life_days
        FROM qc_checks q
        LEFT JOIN products p ON p.id = q.product_id
        ${where}
        ORDER BY q.qc_date DESC NULLS LAST, q.created_at DESC
        LIMIT $${vals.length}
      `;
      var r = await pool.query(sql, vals);
      return res.status(200).json({ data: r.rows });
    }

    // ---- POST (create) ----
    if (req.method === "POST") {
      var b = req.body || {};
      if (!b.order_contract_no) return res.status(400).json({ error: "order_contract_no required" });

      // compute best_before from products.shelf_life_days if missing
      var bestBefore = b.best_before || null;
      if (!bestBefore && b.production_date && b.product_id) {
        var pr = await pool.query("SELECT shelf_life_days FROM products WHERE id = $1", [b.product_id]);
        var sld = pr.rows[0] && pr.rows[0].shelf_life_days;
        if (sld) {
          var d = new Date(b.production_date);
          d.setDate(d.getDate() + parseInt(sld));
          bestBefore = d.toISOString().slice(0, 10);
        }
      }

      var cols = [
        "order_contract_no", "product_id", "product_sku",
        "batch_no", "production_date", "best_before", "qty",
        "qc_result", "qc_date", "qc_by", "checklist", "photos", "fail_reason",
        "entry_mode", "factory_code",
      ];
      var vals2 = [
        b.order_contract_no, b.product_id || null, b.product_sku || null,
        b.batch_no || null, b.production_date || null, bestBefore, b.qty || 0,
        b.qc_result || "pending",
        b.qc_date || b.production_date || null,
        b.qc_by || null,
        JSON.stringify(b.checklist || {}),
        JSON.stringify(b.photos || []),
        b.fail_reason || "",
        b.entry_mode || "realtime",
        b.factory_code || null,
      ];
      var ph = cols.map((_, i) => "$" + (i + 1)).join(", ");
      var sql = `INSERT INTO qc_checks (${cols.join(", ")}) VALUES (${ph}) RETURNING *`;
      var r = await pool.query(sql, vals2);
      return res.status(201).json({ data: r.rows[0] });
    }

    // ---- PATCH (update / review) ----
    if (req.method === "PATCH") {
      var id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });
      var b = req.body || {};
      var allowed = [
        "qc_result", "qc_date", "qc_by", "checklist", "photos", "fail_reason",
        "batch_no", "production_date", "best_before", "qty",
        "reviewed_by", "review_status",
        // Phase 2 review fields (aliased names accepted too)
        "reviewer", "reviewed_at",
      ];
      var sets = [], vals3 = [], n = 0;
      for (var f of allowed) {
        if (b[f] !== undefined) {
          n++;
          var v = b[f];
          if (f === "checklist" || f === "photos") v = JSON.stringify(v);
          sets.push(f + " = $" + n);
          vals3.push(v);
        }
      }
      // 支持 reviewer 作为 reviewed_by 的别名
      if (b.reviewer !== undefined && b.reviewed_by === undefined) {
        n++;
        sets.push("reviewed_by = $" + n);
        vals3.push(b.reviewer);
      }
      // 支持 reviewed_at 显式传入 或 自动设置（审核动作时）
      if (b.reviewed_at) {
        n++;
        sets.push("reviewed_at = $" + n);
        vals3.push(b.reviewed_at);
      } else if (b.review_status && b.review_status !== "pending") {
        sets.push("reviewed_at = NOW()");
      } else if (b.qc_result && b.qc_result !== "pending" && b.reviewed_by) {
        // 通过 qc_result 驱动审核时间
        sets.push("reviewed_at = NOW()");
      }
      if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });
      sets.push("updated_at = NOW()");
      n++;
      vals3.push(parseInt(id));
      var sql = `UPDATE qc_checks SET ${sets.join(", ")} WHERE id = $${n} RETURNING *`;
      var r = await pool.query(sql, vals3);
      if (!r.rows.length) return res.status(404).json({ error: "not found" });
      return res.status(200).json({ data: r.rows[0] });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
