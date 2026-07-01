import { getPool, setCors } from "../db.js";

const SQL = `
  SELECT
    sp._id AS sp_id,
    sp.bl_no AS export_bl,
    sp.vessel,
    sp.voyage,
    sp.etd,
    sp.shipment_no,

    cb.id AS cb_id,
    cb.container_no,
    cb.seal_no,
    cb.contract_no,
    cb.container_type,
    COALESCE(cb.cargo_weight_kg, 0)::numeric AS cb_cargo_weight_kg,
    COALESCE(cb.tare_kg, 0)::numeric AS tare_kg,

    li.id AS li_id,
    COALESCE(li.qty_ctn, 0)::numeric AS qty_ctn,
    li.hs_code AS li_hs_code,
    COALESCE(li.gw_ctn, 0)::numeric AS li_gw_ctn,

    p.hs_code AS product_hs_code,
    p.declaration_name,
    p.bl_description,
    COALESCE(p.gross_weight, 0)::numeric AS product_gw_ctn,
    COALESCE(p.cbm, 0)::numeric AS product_cbm
  FROM shipping_plans sp
  JOIN container_bookings cb ON cb.shipping_plan_id = sp.id
  LEFT JOIN orders o ON o.contract_no = cb.contract_no
  LEFT JOIN order_line_items li ON li.order_id = o.id
  LEFT JOIN products p ON p.id = li.product_id
  WHERE sp.id::text = $1 OR sp._id = $1
  ORDER BY cb.id ASC, li.id ASC
`;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, digits = 3) {
  const m = 10 ** digits;
  return Math.round(num(value) * m) / m;
}

function text(value) {
  return value == null ? "" : String(value);
}

function vesselVoyage(row) {
  return [row.vessel, row.voyage].filter(Boolean).join(" / ");
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const planId = req.query.plan_id || req.query.id;
  if (!planId) return res.status(400).json({ error: "plan_id is required" });

  try {
    const pool = getPool();
    const { rows } = await pool.query(SQL, [planId]);

    if (!rows.length) {
      return res.status(404).json({ error: "Shipping plan not found" });
    }

    const first = rows[0];
    const plan = {
      plan_id: text(first.sp_id),
      export_bl: text(first.export_bl),
      vessel: text(first.vessel),
      voyage: text(first.voyage),
      etd: first.etd || "",
      shipment_no: text(first.shipment_no),
    };

    const containersById = new Map();
    const productsByKey = new Map();

    for (const row of rows) {
      const cbId = row.cb_id;
      if (!containersById.has(cbId)) {
        containersById.set(cbId, {
          cb_id: cbId,
          container_no: text(row.container_no),
          seal_no: text(row.seal_no),
          container_type: text(row.container_type),
          contract_no: text(row.contract_no),
          export_port: "",
          export_bl: text(row.export_bl),
          vessel_voyage: vesselVoyage(row),
          import_arrival_date: "",
          import_bl_no: "",
          pieces: 0,
          gross_weight_kg: 0,
          cbm: 0,
          tare_kg: num(row.tare_kg),
          vgm_kg: 0,
          _hasProductRows: false,
          _fallbackCargoWeight: num(row.cb_cargo_weight_kg),
        });
      }

      const container = containersById.get(cbId);
      if (!row.li_id) continue;

      const qty = num(row.qty_ctn);
      const unitGw = num(row.li_gw_ctn) || num(row.product_gw_ctn);
      const lineGw = qty * unitGw;
      const lineCbm = qty * num(row.product_cbm);
      const product = text(row.declaration_name || row.bl_description);
      const hsCode = text(row.li_hs_code || row.product_hs_code);

      container._hasProductRows = true;
      container.pieces += qty;
      container.gross_weight_kg += lineGw;
      container.cbm += lineCbm;

      const key = [cbId, hsCode, product].join("\u0001");
      if (!productsByKey.has(key)) {
        productsByKey.set(key, {
          cb_id: cbId,
          container_no: text(row.container_no),
          seal_no: text(row.seal_no),
          product,
          hs_code: hsCode,
          qty_ctn: 0,
          gross_weight_kg: 0,
          cbm: 0,
          tare_kg: num(row.tare_kg),
          vgm_kg: 0,
        });
      }

      const productRow = productsByKey.get(key);
      productRow.qty_ctn += qty;
      productRow.gross_weight_kg += lineGw;
      productRow.cbm += lineCbm;
    }

    const containers = Array.from(containersById.values()).map((container) => {
      const gross = container._hasProductRows
        ? container.gross_weight_kg
        : container._fallbackCargoWeight;
      const vgm = gross + container.tare_kg;

      return {
        cb_id: container.cb_id,
        container_no: container.container_no,
        seal_no: container.seal_no,
        container_type: container.container_type,
        contract_no: container.contract_no,
        export_port: container.export_port,
        export_bl: container.export_bl,
        vessel_voyage: container.vessel_voyage,
        import_arrival_date: container.import_arrival_date,
        import_bl_no: container.import_bl_no,
        pieces: round(container.pieces, 0),
        gross_weight_kg: round(gross, 3),
        tare_kg: round(container.tare_kg, 3),
        vgm_kg: round(vgm, 3),
      };
    });

    const vgmByCbId = new Map(containers.map((container) => [container.cb_id, container.vgm_kg]));
    const products = Array.from(productsByKey.values()).map((product) => ({
      ...product,
      qty_ctn: round(product.qty_ctn, 0),
      gross_weight_kg: round(product.gross_weight_kg, 3),
      cbm: round(product.cbm, 3),
      tare_kg: round(product.tare_kg, 3),
      vgm_kg: round(vgmByCbId.get(product.cb_id), 3),
    }));

    return res.json({ plan, containers, products });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
