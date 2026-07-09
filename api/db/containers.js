// containers.js — CRUD for shipment_group + containers + order_containers (v3.2 §6.3)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function clean(v) {
  return String(v ?? "").trim();
}

function isRealContainerNo(v) {
  var s = clean(v);
  return s && !/^TBD(?:-|$)/i.test(s) && !/^PLACEHOLDER/i.test(s);
}

function parseRaw(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (_) { return {}; }
}

function fsFromOrder(o) {
  var raw = parseRaw(o && o.raw);
  var vals = [o && o.fs_no, raw.fs_no, raw.fsNo, o && o.internal_no, raw.internal_no, raw.internalNo, o && o.contract_no, o && o.order_no];
  for (var i = 0; i < vals.length; i++) {
    var m = clean(vals[i]).match(/\bFS[0-9A-Z-]+\b/i);
    if (m) return m[0].toUpperCase();
  }
  return "";
}

function uniq(xs) {
  var seen = new Set();
  return (xs || []).map(clean).filter(function (x) {
    if (!x || seen.has(x)) return false;
    seen.add(x);
    return true;
  });
}

function getCompanyCodes(req, res) {
  const role = req.user?.role;
  if (role === "admin" || role === "system") return null;
  const codes = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : null);
  if (!codes || codes.length === 0) {
    res.status(403).json({ error: "Account scope missing — please log out and log in again." });
    return false;
  }
  return codes;
}

async function orderBelongsToCaller(pool, order_id, codes, res) {
  if (codes === null) return true;
  const r = await pool.query(
    `SELECT 1 FROM orders WHERE id = $1
      AND (company_code = ANY($2::text[])
           OR raw->>'companyCode' = ANY($2::text[])
           OR raw->>'factoryCompanyCode' = ANY($2::text[]))
     LIMIT 1`,
    [order_id, codes]
  );
  if (r.rowCount === 0) {
    res.status(403).json({ error: "Forbidden: order not in your account scope." });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const codes = getCompanyCodes(req, res);
  if (codes === false) return;

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const { action, order_id, container_id, bl, plan_id } = req.query;

      // list_by_order: all containers linked to a given order, with group info
      if (action === "list_by_order") {
        if (!order_id) return res.status(400).json({ error: "order_id required" });
        if (!(await orderBelongsToCaller(pool, order_id, codes, res))) return;

        const r = await pool.query(
          `SELECT c.*, sg.group_code, sg.bl_master, sg.vessel, sg.voyage, sg.pol, sg.pod,
                  oc.ctn_count, oc.cbm AS order_cbm
             FROM order_containers oc
             JOIN containers c      ON c.id = oc.container_id
             LEFT JOIN shipment_group sg ON sg.id = c.shipment_group_id
            WHERE oc.order_id = $1
            ORDER BY c.id`,
          [order_id]
        );
        return res.status(200).json({ data: r.rows });
      }

      // siblings: all order_ids sharing the same container (for co-loading display)
      if (action === "siblings") {
        if (!container_id) return res.status(400).json({ error: "container_id required" });
        // Verify caller owns at least one order in this container
        if (codes !== null) {
          const check = await pool.query(
            `SELECT 1 FROM order_containers oc
               JOIN orders o ON o.id = oc.order_id
              WHERE oc.container_id = $1
                AND (o.company_code = ANY($2::text[])
                     OR o.raw->>'companyCode' = ANY($2::text[])
                     OR o.raw->>'factoryCompanyCode' = ANY($2::text[]))
             LIMIT 1`,
            [container_id, codes]
          );
          if (check.rowCount === 0) {
            return res.status(403).json({ error: "Forbidden: container not linked to your orders." });
          }
        }
        const r = await pool.query(
          `SELECT oc.order_id, oc.ctn_count, oc.cbm
             FROM order_containers oc
            WHERE oc.container_id = $1
            ORDER BY oc.order_id`,
          [container_id]
        );
        return res.status(200).json({ data: r.rows });
      }

      if (action === "slices_by_bl") {
        var blNo = clean(bl);
        var planId = clean(plan_id);
        if (!blNo && !planId) return res.status(400).json({ error: "bl or plan_id required" });

        if (!blNo && planId) {
          const sp = await pool.query("SELECT bl_no FROM shipping_plans WHERE id::text=$1 OR _id::text=$1 LIMIT 1", [planId]);
          blNo = clean(sp.rows[0] && sp.rows[0].bl_no);
        }

        var scopeSql = "";
        var params = [blNo];
        if (codes !== null) {
          params.push(codes);
          scopeSql = ` AND (o.company_code = ANY($${params.length}::text[])
                         OR o.raw->>'companyCode' = ANY($${params.length}::text[])
                         OR o.raw->>'factoryCompanyCode' = ANY($${params.length}::text[]))`;
        }

        var primary = [];
        if (blNo) {
          const pr = await pool.query(
            `SELECT c.container_no, c.seal_no, c.container_type,
                    o.id AS order_id, o.order_no, o.contract_no, o.raw
               FROM order_containers oc
               JOIN containers c ON c.id = oc.container_id
               LEFT JOIN shipment_group sg ON sg.id = c.shipment_group_id
               JOIN orders o ON o.id = oc.order_id
              WHERE (sg.bl_master = $1 OR o.bl_no = $1 OR o.raw->>'blNo' = $1 OR o.raw->>'bl_no' = $1)
                AND NULLIF(btrim(c.container_no), '') IS NOT NULL
                ${scopeSql}
              ORDER BY c.id, o.id`,
            params
          );
          primary = pr.rows || [];
        }

        var rows = primary;
        if (!rows.length) {
          var fbParams = [blNo || null, planId || null];
          var fbScopeSql = "";
          if (codes !== null) {
            fbParams.push(codes);
            fbScopeSql = ` AND (o.company_code = ANY($${fbParams.length}::text[])
                             OR o.raw->>'companyCode' = ANY($${fbParams.length}::text[])
                             OR o.raw->>'factoryCompanyCode' = ANY($${fbParams.length}::text[]))`;
          }
          const fb = await pool.query(
            `SELECT cb.container_no, cb.seal_no, cb.container_type,
                    o.id AS order_id, o.order_no, o.contract_no, o.raw
               FROM container_bookings cb
               LEFT JOIN orders o
                 ON o.order_no = cb.contract_no
                 OR o.contract_no = cb.contract_no
                 OR o.customer_po = cb.contract_no
              WHERE (($1::text IS NOT NULL AND cb.bl_no = $1)
                  OR ($2::text IS NOT NULL AND cb.shipping_plan_id::text = $2))
                AND NULLIF(btrim(cb.container_no), '') IS NOT NULL
                ${fbScopeSql}
              ORDER BY cb.id, o.id`,
            fbParams
          );
          rows = fb.rows || [];
        }

        var grouped = new Map();
        rows.forEach(function (r) {
          if (!isRealContainerNo(r.container_no)) return;
          var key = clean(r.container_no);
          if (!grouped.has(key)) grouped.set(key, { container_no: key, seal_no: clean(r.seal_no), container_type: clean(r.container_type), order_ids: [], order_nos: [], _fs: [] });
          var g = grouped.get(key);
          if (!g.seal_no) g.seal_no = clean(r.seal_no);
          if (!g.container_type) g.container_type = clean(r.container_type);
          if (r.order_id) g.order_ids.push(String(r.order_id));
          g.order_nos.push(r.order_no || r.contract_no);
          g._fs.push(fsFromOrder(r));
        });
        var data = Array.from(grouped.values()).map(function (g) {
          var fs = uniq(g._fs);
          return {
            container_no: g.container_no,
            seal_no: g.seal_no,
            container_type: g.container_type,
            order_ids: uniq(g.order_ids).map(function (id) { return Number(id); }).filter(function (id) { return Number.isFinite(id); }),
            order_nos: uniq(g.order_nos),
            fs_no: fs[0] || "",
          };
        });
        return res.status(200).json({ data });
      }

      return res.status(400).json({ error: "action must be list_by_order, siblings, or slices_by_bl" });
    }

    // ── POST — create shipment_group + container + link orders atomically ──
    if (req.method === "POST") {
      const b = req.body || {};
      // order_ids: array of { order_id, ctn_count?, cbm? }
      if (!Array.isArray(b.order_ids) || b.order_ids.length === 0) {
        return res.status(400).json({ error: "order_ids array required" });
      }

      // Verify caller owns all orders being linked
      for (const entry of b.order_ids) {
        const oid = typeof entry === "object" ? entry.order_id : entry;
        if (!(await orderBelongsToCaller(pool, oid, codes, res))) return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // 1. Upsert shipment_group by group_code if provided, else insert new
        let sg_id;
        if (b.group_code) {
          const existing = await client.query(
            `SELECT id FROM shipment_group WHERE group_code = $1`,
            [b.group_code]
          );
          if (existing.rows.length > 0) {
            sg_id = existing.rows[0].id;
          }
        }
        if (!sg_id) {
          const sg = await client.query(
            `INSERT INTO shipment_group (group_code, bl_master, vessel, voyage, pol, pod)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              b.group_code  || null,
              b.bl_master   || null,
              b.vessel      || null,
              b.voyage      || null,
              b.pol         || null,
              b.pod         || null,
            ]
          );
          sg_id = sg.rows[0].id;
        }

        // 2. Insert container
        const ct = await client.query(
          `INSERT INTO containers (shipment_group_id, container_no, seal_no, container_type,
                                   gross_weight_kg, total_cbm, loaded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            sg_id,
            b.container_no    || null,
            b.seal_no         || null,
            b.container_type  || null,
            b.gross_weight_kg || null,
            b.total_cbm       || null,
            b.loaded_at       || null,
          ]
        );
        const container = ct.rows[0];

        // 3. Link each order to this container
        for (const entry of b.order_ids) {
          const oid = typeof entry === "object" ? entry.order_id : entry;
          await client.query(
            `INSERT INTO order_containers (order_id, container_id, ctn_count, cbm)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (order_id, container_id) DO UPDATE
               SET ctn_count = EXCLUDED.ctn_count, cbm = EXCLUDED.cbm`,
            [
              oid,
              container.id,
              typeof entry === "object" ? (entry.ctn_count || null) : null,
              typeof entry === "object" ? (entry.cbm       || null) : null,
            ]
          );
        }

        await client.query("COMMIT");
        return res.status(201).json({ data: { shipment_group_id: sg_id, container } });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
