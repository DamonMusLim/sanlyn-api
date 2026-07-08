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
    cb.declaration_cargo_name AS goods_desc,
    COALESCE(cb.cargo_weight_kg, 0)::numeric AS cb_cargo_weight_kg,
    COALESCE(cb.tare_weight_kg, cb.tare_kg, 0)::numeric AS tare_kg,

    li.id AS li_id,
    COALESCE(li.qty_ctn, 0)::numeric AS qty_ctn,
    li.hs_code AS li_hs_code,
    li.product_name AS li_product_name,
    COALESCE(li.gw_ctn, 0)::numeric AS li_gw_ctn,
    COALESCE(li.cbm_ctn, 0)::numeric AS li_cbm_ctn,

    p.hs_code AS product_hs_code,
    p.declaration_name,
    p.bl_description,
    COALESCE(p.gross_weight, 0)::numeric AS product_gw_ctn,
    COALESCE(p.cbm, 0)::numeric AS product_cbm
    ,COALESCE(o.total_cbm, 0)::numeric AS order_cbm
  FROM shipping_plans sp
  JOIN container_bookings cb ON cb.shipping_plan_id = sp.id
  LEFT JOIN orders o ON (o.order_no = cb.contract_no OR o.contract_no = cb.contract_no) AND o.bl_no = sp.bl_no
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
          cbm_official: num(row.order_cbm),
          tare_kg: num(row.tare_kg),
          goods_desc: text(row.goods_desc),
          _blDescSet: new Set(),
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
      const lineCbm = qty * (num(row.li_cbm_ctn) || num(row.product_cbm));
      const product = text(row.declaration_name || row.bl_description || row.li_product_name);
      const hsCode = text(row.li_hs_code || row.product_hs_code);

      container._hasProductRows = true;
      if (row.bl_description) container._blDescSet.add(text(row.bl_description));
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
      const gross = container._fallbackCargoWeight > 0
        ? container._fallbackCargoWeight
        : container.gross_weight_kg;
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
        goods_desc: container.goods_desc || Array.from(container._blDescSet).join(" / "),
        import_arrival_date: container.import_arrival_date,
        import_bl_no: container.import_bl_no,
        pieces: round(container.pieces, 0),
        cbm: round(container.cbm_official, 3),
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

    if (String(req.query.format || "") === "xlsx") {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("装箱资料");
      ws.mergeCells("A1:P1");
      ws.getCell("A1").value = "装箱资料";
      ws.getCell("A1").font = { bold: true, size: 16 };
      ws.getCell("A1").alignment = { horizontal: "center" };
      ws.addRow([]);
      ws.addRow(["船名航次", [plan.vessel, plan.voyage].filter(Boolean).join(" / "), "", "外贸提单号", plan.export_bl, "", "截单/ETD", plan.etd ? String(plan.etd).slice(0,10) : "", "", "Shipment No", plan.shipment_no]);
      ws.addRow([]);
      const header = ["序号","进口船名航次","内贸到港时间","进口内贸提单号","柜型","柜号","封铅","外贸出口港口","对应外贸提单号","对应船名航次","货品描述","件数","CBM","柜重GW","皮重TARE","VGM"];
      const hr = ws.addRow(header);
      hr.font = { bold: true };
      hr.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } }; c.border = { top:{style:"thin"}, left:{style:"thin"}, bottom:{style:"thin"}, right:{style:"thin"} }; });
      (containers || []).forEach((c, i) => {
        const r = ws.addRow([
          i + 1, c.vessel_voyage || "", c.import_arrival_date || "", c.import_bl_no || "",
          c.container_type || "", c.container_no || "", c.seal_no || "", c.export_port || "",
          c.export_bl || "", c.vessel_voyage || "", c.goods_desc || "",
          Number(c.pieces) || 0, Number(c.cbm) || 0, Number(c.gross_weight_kg) || 0,
          Number(c.tare_kg) || 0, Number(c.vgm_kg) || 0,
        ]);
        r.eachCell((cell) => { cell.border = { top:{style:"thin"}, left:{style:"thin"}, bottom:{style:"thin"}, right:{style:"thin"} }; });
      });
      ws.columns.forEach((col) => { col.width = 14; });
      const buf = await wb.xlsx.writeBuffer();
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const _fn = (plan.shipment_no || plan.export_bl || "transfer");
      res.setHeader("Content-Disposition", "attachment; filename=\"PackingList-" + _fn + ".xlsx\"; filename*=UTF-8''" + encodeURIComponent("装箱资料-" + _fn + ".xlsx"));
      return res.end(Buffer.from(buf));
    }

    return res.json({ plan, containers, products });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
