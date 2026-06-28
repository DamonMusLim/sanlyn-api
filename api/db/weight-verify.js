// /api/db/weight-verify.js — Weight & CBM verification against products master
// POST { order_id: number, skus?: string[] }
// Auth: requireAuth (admin role only)
//
// Logic:
//   1. Fetch order_line_items for order_id (optionally filtered by skus)
//   2. JOIN products with DISTINCT ON (sku), is_canonical DESC NULLS LAST, id DESC
//   3. For each line item, infer nw/gw/cbm from master product data
//   4. Compare inferred vs stored values and produce per-row action verdict
//
// Action values:
//   'write'      — oli field is NULL, inferred value available → safe to write
//   'ok'         — stored vs inferred within threshold
//   'warn'       — stored vs inferred exceeds threshold
//   'cant_calc'  — required master fields missing, cannot infer
//
// NOTE: products.weight_unit and products.is_canonical are new columns expected
//       to exist (or be NULL-safe). If not yet migrated they will be treated as NULL.
//       weight_unit NULL is treated as 'per_carton'.
//       is_canonical NULL is treated as false (id DESC tiebreak applies).

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ─── thresholds ────────────────────────────────────────────────────────────
const NW_THRESHOLD  = 0.05;   //  5%
const GW_THRESHOLD  = 0.08;   //  8%  (non-estimated)
const GW_EST_THRESH = 0.15;   // 15%  (estimated gross weight)
const CBM_THRESHOLD = 0.10;   // 10%

// ─── cat1 → gw multiplier ──────────────────────────────────────────────────
function gwMultiplier(cat1) {
  if (!cat1) return { mult: 1.12, estimated: true };
  const c = cat1.toLowerCase();
  if (/湿粮|罐头|wet/.test(c)) return { mult: 1.18, estimated: true };
  if (/干粮|零食|干/.test(c))  return { mult: 1.10, estimated: true };
  return { mult: 1.12, estimated: true };
}

// ─── pct diff helper ───────────────────────────────────────────────────────
function pctDiff(stored, inferred) {
  if (inferred === 0) return stored === 0 ? 0 : Infinity;
  return Math.abs(stored - inferred) / inferred;
}

// ─── per-field verdict ─────────────────────────────────────────────────────
function verdict(storedRaw, inferred, threshold) {
  const stored = storedRaw != null ? parseFloat(storedRaw) : null;
  if (inferred == null) return "cant_calc";
  if (stored == null)   return "write";
  const diff = pctDiff(stored, inferred);
  return diff > threshold ? "warn" : "ok";
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const body = req.body || {};
  const orderId = parseInt(body.order_id);
  // FIX: use explicit NaN + range check instead of falsy check
  if (isNaN(orderId) || orderId <= 0) {
    return res.status(400).json({ error: "order_id required" });
  }
  const skuFilter = Array.isArray(body.skus) && body.skus.length > 0 ? body.skus : null;

  const pool = getPool();

  try {
    // ── Step 1: fetch line items ─────────────────────────────────────────
    let oliQuery, oliParams;
    if (skuFilter) {
      oliQuery  = `SELECT * FROM order_line_items WHERE order_id = $1 AND sku = ANY($2) ORDER BY sort_order ASC, id ASC`;
      oliParams = [orderId, skuFilter];
    } else {
      oliQuery  = `SELECT * FROM order_line_items WHERE order_id = $1 ORDER BY sort_order ASC, id ASC`;
      oliParams = [orderId];
    }
    const oliResult = await pool.query(oliQuery, oliParams);
    const lineItems = oliResult.rows;

    if (lineItems.length === 0) {
      return res.status(200).json({ order_id: orderId, rows: [], summary: { total: 0 } });
    }

    // ── Step 2: fetch best product record per sku ────────────────────────
    const skus = [...new Set(lineItems.map(r => r.sku).filter(Boolean))];

    let productMap = {};
    if (skus.length > 0) {
      // DISTINCT ON (sku): is_canonical=true first, then highest id
      // weight_unit and is_canonical may not exist yet — use COALESCE/NULL-safe cast
      // FIX: added product_name to SELECT so prod.product_name is available below
      const prodResult = await pool.query(
        `SELECT DISTINCT ON (sku)
           sku, cat1, cat1_cn,
           net_weight, gross_weight, cbm,
           carton_qty,
           box_l, box_w, box_h,
           product_name,
           COALESCE(weight_unit, 'per_carton') AS weight_unit,
           COALESCE(is_canonical, false)       AS is_canonical,
           id
         FROM products
         WHERE sku = ANY($1)
           AND active = true
         ORDER BY sku,
                  (COALESCE(is_canonical, false)) DESC,
                  id DESC`,
        [skus]
      );
      for (const p of prodResult.rows) {
        productMap[p.sku] = p;
      }
    }

    // ── Step 3 & 4: compute inferred values and produce verdicts ─────────
    const rows = lineItems.map(oli => {
      const sku  = oli.sku;
      const prod = sku ? productMap[sku] : null;

      if (!prod) {
        // No master record at all
        return {
          oli_id:      oli.id,
          sku,
          product_name: oli.product_name || null,

          // stored
          oli_nw_ctn:  oli.nw_ctn  != null ? parseFloat(oli.nw_ctn)  : null,
          oli_gw_ctn:  oli.gw_ctn  != null ? parseFloat(oli.gw_ctn)  : null,
          oli_cbm_ctn: oli.cbm_ctn != null ? parseFloat(oli.cbm_ctn) : null,

          // inferred
          inferred_nw:  null, inferred_nw_source:  "no_master",
          inferred_gw:  null, inferred_gw_source:  "no_master", gw_estimated: false,
          inferred_cbm: null, inferred_cbm_source: "no_master",

          action_nw:  "cant_calc",
          action_gw:  "cant_calc",
          action_cbm: "cant_calc",

          overall_action: "cant_calc",
          notes: ["no matching product in master (sku not found or inactive)"]
        };
      }

      const notes = [];

      // ── NW ──────────────────────────────────────────────────────────────
      let inferredNw     = null;
      let inferredNwSrc  = null;

      const masterNw      = prod.net_weight    != null ? parseFloat(prod.net_weight)  : null;
      const cartonQty     = prod.carton_qty    != null ? parseInt(prod.carton_qty)    : null;
      const weightUnit    = prod.weight_unit;  // 'per_piece' | 'per_carton' (default)

      if (masterNw != null) {
        if (weightUnit === "per_piece") {
          if (cartonQty) {
            inferredNw    = parseFloat((masterNw * cartonQty).toFixed(4));
            inferredNwSrc = "per_piece × carton_qty";
          } else {
            inferredNwSrc = "MISSING_carton_qty";
            notes.push("weight_unit=per_piece but carton_qty is NULL");
          }
        } else {
          inferredNw    = parseFloat(masterNw.toFixed(4));
          inferredNwSrc = "per_carton direct";
        }
      } else {
        inferredNwSrc = "MISSING_net_weight";
      }

      // ── GW ──────────────────────────────────────────────────────────────
      let inferredGw      = null;
      let inferredGwSrc   = null;
      let gwEstimated     = false;

      const masterGw = prod.gross_weight != null ? parseFloat(prod.gross_weight) : null;

      if (masterGw != null && masterGw > 0) {
        inferredGw    = parseFloat(masterGw.toFixed(4));
        inferredGwSrc = "products.gross_weight direct";
        gwEstimated   = false;
      } else if (inferredNw != null) {
        // fall back to cat1 estimation
        const cat1Label = prod.cat1 || prod.cat1_cn || "";
        const { mult, estimated } = gwMultiplier(cat1Label);
        inferredGw    = parseFloat((inferredNw * mult).toFixed(4));
        inferredGwSrc = `ESTIMATED via cat1="${cat1Label || "(empty)"}" ×${mult}`;
        gwEstimated   = estimated;
        notes.push(`gross_weight not in master, GW estimated (${inferredGwSrc})`);
      } else {
        inferredGwSrc = "MISSING_net_weight (cant estimate)";
      }

      // ── CBM ─────────────────────────────────────────────────────────────
      let inferredCbm    = null;
      let inferredCbmSrc = null;

      const boxL = prod.box_l != null ? parseFloat(prod.box_l) : null;
      const boxW = prod.box_w != null ? parseFloat(prod.box_w) : null;
      const boxH = prod.box_h != null ? parseFloat(prod.box_h) : null;

      if (boxL != null && boxW != null && boxH != null && boxL > 0 && boxW > 0 && boxH > 0) {
        inferredCbm    = parseFloat((boxL * boxW * boxH / 1e6).toFixed(6));
        inferredCbmSrc = `box ${boxL}×${boxW}×${boxH} cm / 1e6`;
      } else if (prod.cbm != null && parseFloat(prod.cbm) > 0) {
        inferredCbm    = parseFloat(parseFloat(prod.cbm).toFixed(6));
        inferredCbmSrc = "products.cbm direct";
      } else {
        inferredCbmSrc = "MISSING";
        notes.push("no box_l/w/h and no cbm in master");
      }

      // ── Verdict per field ────────────────────────────────────────────────
      const actionNw  = verdict(oli.nw_ctn,  inferredNw,  NW_THRESHOLD);
      const actionGw  = verdict(oli.gw_ctn,  inferredGw,  gwEstimated ? GW_EST_THRESH : GW_THRESHOLD);
      const actionCbm = verdict(oli.cbm_ctn, inferredCbm, CBM_THRESHOLD);

      // Overall = worst severity: cant_calc > warn > write > ok
      const severity = { cant_calc: 3, warn: 2, write: 1, ok: 0 };
      const worst    = [actionNw, actionGw, actionCbm]
        .sort((a, b) => severity[b] - severity[a])[0];

      return {
        oli_id:       oli.id,
        sku,
        product_name: oli.product_name || prod.product_name || null,
        qty_ctn:      oli.qty_ctn != null ? parseFloat(oli.qty_ctn) : null,

        // stored values (oli)
        oli_nw_ctn:   oli.nw_ctn  != null ? parseFloat(oli.nw_ctn)  : null,
        oli_gw_ctn:   oli.gw_ctn  != null ? parseFloat(oli.gw_ctn)  : null,
        oli_cbm_ctn:  oli.cbm_ctn != null ? parseFloat(oli.cbm_ctn) : null,

        // inferred values
        inferred_nw:       inferredNw,
        inferred_nw_source: inferredNwSrc,

        inferred_gw:        inferredGw,
        inferred_gw_source: inferredGwSrc,
        gw_estimated:       gwEstimated,

        inferred_cbm:        inferredCbm,
        inferred_cbm_source: inferredCbmSrc,

        // per-field actions
        action_nw:  actionNw,
        action_gw:  actionGw,
        action_cbm: actionCbm,

        // worst-case overall action for this row
        overall_action: worst,

        notes,

        // diff percentages (null if cant_calc)
        diff_nw_pct:  (oli.nw_ctn  != null && inferredNw  != null)
          ? parseFloat((pctDiff(parseFloat(oli.nw_ctn),  inferredNw)  * 100).toFixed(2))
          : null,
        diff_gw_pct:  (oli.gw_ctn  != null && inferredGw  != null)
          ? parseFloat((pctDiff(parseFloat(oli.gw_ctn),  inferredGw)  * 100).toFixed(2))
          : null,
        diff_cbm_pct: (oli.cbm_ctn != null && inferredCbm != null)
          ? parseFloat((pctDiff(parseFloat(oli.cbm_ctn), inferredCbm) * 100).toFixed(2))
          : null,
      };
    });

    // ── Summary ────────────────────────────────────────────────────────────
    const summary = {
      total:      rows.length,
      ok:         rows.filter(r => r.overall_action === "ok").length,
      write:      rows.filter(r => r.overall_action === "write").length,
      warn:       rows.filter(r => r.overall_action === "warn").length,
      cant_calc:  rows.filter(r => r.overall_action === "cant_calc").length,
    };

    return res.status(200).json({ order_id: orderId, rows, summary });

  } catch (err) {
    console.error("[weight-verify] error:", err);
    return res.status(500).json({ error: err.message });
  }
}
