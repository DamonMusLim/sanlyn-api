// /api/db/export-excel.js
// 生成可下载 Excel 文件 (SpreadsheetML XML - 无需额外安装包)
//
// GET ?type=shipping&id=SP2024xxxx    → 海运计划确认书 Excel
// GET ?type=customs&shipment=xxx      → 报关资料清单 Excel
// GET ?type=cost&id=SP2024xxxx        → 成本核算单 Excel (admin only)
// GET ?type=finance_summary           → 财务汇总 Excel
// GET ?type=finance_shipments         → 海运费用明细 Excel

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const { type, id, shipment, contract, company_code, month } = req.query;

  try {
    const pool = getPool();

    // ════════════════════════════════
    //  海运计划 Excel
    // ════════════════════════════════
    if (type === "shipping" && id) {
      const pRes = await pool.query(
        "SELECT * FROM shipping_plans WHERE _id=$1 OR shipment_no=$1 LIMIT 1", [id]
      );
      if (!pRes.rows.length) return res.status(404).json({ error: "Not found" });
      const p = pRes.rows[0];

      // Linked orders
      let orders = [];
      const nos = p.order_nos || [];
      if (Array.isArray(nos) && nos.length) {
        const ph = nos.map((_,i)=>`$${i+1}`).join(",");
        const oR = await pool.query(
          `SELECT _id,order_no,contract_no,customer_po,raw FROM orders WHERE order_no IN(${ph}) OR contract_no IN(${ph}) OR _id::text IN(${ph})`, nos
        );
        orders = oR.rows;
      }

      const portFees = [
        ["文件费 (Doc Fee)",      p.doc_fee],
        ["通讯费 (TLX Fee)",      p.tlx_fee],
        ["信息传输费",             p.info_trans_fee],
        ["订舱费 (Booking Fee)",  p.bkg_fee],
        ["码头操作费 (THC)",       p.thc_fee],
        ["设备交接费 (EIR)",       p.eir_fee],
        ["铅封费 (Seal Fee)",     p.seal_fee],
      ].filter(([, v]) => v != null && v > 0);

      const portTotal = portFees.reduce((s,[,v]) => s + Number(v||0), 0);

      const rows = [
        _hdr2("三林宠物 — 海运计划确认书"),
        _hdr2(`出运编号: ${p.shipment_no || "—"}`),
        _blank(),
        _hdr("基本信息", 4),
        _row4("提单号 B/L", p.bl_no, "出运编号", p.shipment_no),
        _row4("装运港 POL", p.pol, "目的港 POD", p.pod),
        _row4("船名 Vessel", p.vessel, "航次 Voyage", p.voyage),
        _row4("ETD 开船日", p.etd ? String(p.etd).substring(0,10) : "—", "ETA 到港日", p.eta ? String(p.eta).substring(0,10) : "—"),
        _row4("截关日 Cutoff", p.si_cutoff_date ? String(p.si_cutoff_date).substring(0,10) : (p.cutoff_date||"—"), "柜型", p.container_type || "—"),
        _row4("柜号", p.container_no || "—", "流程状态", p.flow_status || "—"),
        _blank(),
        _hdr("客户与服务商", 4),
        _row4("客户 (中文)", p.customer_cn || p.customer, "Customer (EN)", p.customer_en || p.customer),
        _row4("货代 (国内)", p.forwarder_cn, "Forwarder (EN)", p.forwarder_en || "—"),
        _row4("拖车行", p.trucking_cn || "—", "报关行", p.customs_cn || "—"),
        _blank(),
        ...(orders.length > 0 ? [
          _hdr("关联订单", 5),
          _rowHeader(["#","合同号","客户PO","客户","品类"]),
          ...orders.map((o,i) => {
            const r = o.raw||{};
            return _row([i+1, o.contract_no||r.contractNo||o._id, o.customer_po||r.customerPO||"—", r.companyNameEN||r.companyNameCN||"—", r.category||"—"]);
          }),
          _blank(),
        ] : []),
        _hdr("费用明细", 4),
        _rowHeader(["费用项目","金额","币种","备注"]),
        _row(["海运费 (成本)", p.freight_cost ?? "—", "USD", "内部成本"]),
        _row(["海运费 (报价)", p.freight_sale_usd ?? "—", "USD", "客户报价"]),
        _row(["运费合计", p.freight_total_cny ?? "—", "CNY", ""]),
        ...portFees.map(([lbl,v]) => _row([lbl, v, "CNY", "港杂费"])),
        _row(["港杂合计", portTotal > 0 ? portTotal : "—", "CNY", "小计"]),
        _row(["拖车费", p.trucking_fee ?? "—", "CNY", ""]),
        _row(["报关费", p.customs_fee ?? "—", "CNY", ""]),
        _row(["保险费", p.insurance_cost ?? "—", "CNY", ""]),
        _blank(),
        _row(["备注", p.remarks || "", "", ""]),
      ];

      return _sendExcel(res, rows, `海运计划_${p.shipment_no||id}`, 4);
    }

    // ════════════════════════════════
    //  报关资料清单 Excel
    // ════════════════════════════════
    if (type === "customs") {
      // S17.3 P0: 报关 Excel 需要登录，防止裸查
      if (!requireAuth(req, res)) return;
      const key = shipment || contract;
      let sql = "SELECT * FROM customs_data WHERE 1=1";
      const vals = [];
      if (shipment) { vals.push(shipment); sql += ` AND shipment_no=$${vals.length}`; }
      if (contract) { vals.push(contract); sql += ` AND contract_no=$${vals.length}`; }
      sql += " ORDER BY updated_at DESC LIMIT 1";
      const cR = await pool.query(sql, vals);
      const cd = cR.rows[0];

      let plan = null, order = null;
      if (cd?.shipment_no) {
        const sp = await pool.query("SELECT * FROM shipping_plans WHERE shipment_no=$1 LIMIT 1", [cd.shipment_no]);
        plan = sp.rows[0];
      }
      if (cd?.contract_no || contract) {
        const oq = await pool.query("SELECT *,raw FROM orders WHERE contract_no=$1 OR order_no=$1 LIMIT 1", [cd?.contract_no||contract]);
        order = oq.rows[0];
      }

      const oRaw = order?.raw || {};
      const products = (oRaw.products||[]);

      const DOCS = [
        ["订舱确认函",   "booking_note"],
        ["报关单",        "customs_dec"],
        ["海关放行通知",  "customs_dec_official"],
        ["放货通知书",    "release_note"],
        ["原产地证书",    "origin_cert"],
        ["检疫证书",      "quarantine_report"],
        ["提单草稿",      "bl_draft"],
        ["正本提单",      "bl_final"],
        ["铅封照片",      "seal_photos"],
        ["工厂签收单",    "factory_sign"],
        ["装货明细",      "loading_details"],
      ];

      const uploaded = DOCS.filter(([,k]) => cd?.[k]).length;

      const rows = [
        _hdr2("三林宠物 — 报关资料清单"),
        _hdr2(`合同号: ${cd?.contract_no||contract||"—"}  |  出运编号: ${cd?.shipment_no||shipment||"—"}`),
        _blank(),
        _hdr("出运信息", 4),
        _row4("出运编号", cd?.shipment_no||shipment||"—", "合同号", cd?.contract_no||contract||"—"),
        _row4("报关编号", cd?.customs_no||"—", "提单号 B/L", plan?.bl_no||"—"),
        ...(plan ? [
          _row4("船名/航次", `${plan.vessel||"—"} / ${plan.voyage||"—"}`, "ETD", plan.etd?String(plan.etd).substring(0,10):"—"),
          _row4("装运港 POL", plan.pol||"—", "目的港 POD", plan.pod||"—"),
        ] : []),
        _row4("客户", oRaw.companyNameEN||oRaw.companyNameCN||order?.customer||"—", "", ""),
        _blank(),
        _hdr(`单据完整度 (${uploaded}/${DOCS.length} 已上传)`, 3),
        _rowHeader(["单据名称","状态","文件链接"]),
        ...DOCS.map(([lbl, k]) => {
          const val = cd?.[k];
          const isUrl = typeof val === "string" && val.startsWith("http");
          return _row([lbl, val ? "✓ 已上传" : "待上传", isUrl ? val : (val ? "已存档" : "—")]);
        }),
        _blank(),
        ...(products.length > 0 ? [
          _hdr("装运商品", 5),
          _rowHeader(["#","品名","规格","条码","数量"]),
          ...products.map((p,i) => _row([i+1, p.name||"—", p.spec||"—", p.barcode||p.sku||"—", p.qty||"—"])),
          _blank(),
        ] : []),
      ];

      return _sendExcel(res, rows, `报关资料_${cd?.shipment_no||key}`, 3);
    }

    // ════════════════════════════════
    //  成本核算单 Excel (Finance only)
    // ════════════════════════════════
    if (type === "cost" && id) {
      const pRes = await pool.query(
        "SELECT * FROM shipping_plans WHERE _id=$1 OR shipment_no=$1 LIMIT 1", [id]
      );
      if (!pRes.rows.length) return res.status(404).json({ error: "Not found" });
      const p = pRes.rows[0];

      const portFees = [
        ["文件费", p.doc_fee], ["通讯费", p.tlx_fee], ["信息传输费", p.info_trans_fee],
        ["订舱费", p.bkg_fee], ["THC", p.thc_fee], ["EIR", p.eir_fee], ["铅封费", p.seal_fee],
      ].filter(([,v]) => v != null && Number(v) > 0);

      const portTotal  = portFees.reduce((s,[,v]) => s+Number(v||0), 0);
      const otherTotal = [p.trucking_fee, p.customs_fee, p.insurance_cost].reduce((s,v) => s+Number(v||0), 0);
      const totalCost  = Number(p.freight_total_cny||0);
      const saleFrt    = Number(p.freight_sale_usd||0);
      // Rough profit if exchange rate ~7.2
      const costEstCNY = (Number(p.freight_cost||0) * 7.2) + portTotal + otherTotal;
      const saleEstCNY = (saleFrt * 7.2) + portTotal + otherTotal;
      const profit     = saleEstCNY - costEstCNY;

      const rows = [
        _hdr2("三林宠物 — 海运成本核算单 (内部专用)"),
        _hdr2(`出运编号: ${p.shipment_no||id}   路线: ${p.pol||""}→${p.pod||""}`),
        _blank(),
        _hdr("成本明细", 3),
        _rowHeader(["费用项目", "金额", "备注"]),
        _row(["海运费 (成本价)", `${p.freight_cost??0} USD`, "向货代付款"]),
        _row(["海运费 (报价)", `${p.freight_sale_usd??0} USD`, "向客户收取"]),
        _blank(),
        _rowHeader(["港杂费明细", "金额 CNY", ""]),
        ...portFees.map(([lbl,v]) => _row([lbl, v, ""])),
        _row(["港杂小计", portTotal, ""]),
        _blank(),
        _rowHeader(["其他费用", "金额 CNY", ""]),
        _row(["拖车费", p.trucking_fee ?? 0, ""]),
        _row(["报关费", p.customs_fee ?? 0, ""]),
        _row(["保险费", p.insurance_cost ?? 0, ""]),
        _row(["其他小计", otherTotal, ""]),
        _blank(),
        _hdr("利润估算 (按汇率 7.2)", 3),
        _row(["成本合计 (估)", Math.round(costEstCNY), "CNY"]),
        _row(["报价合计 (估)", Math.round(saleEstCNY), "CNY"]),
        _row(["毛利润 (估)", Math.round(profit), profit >= 0 ? "盈利" : "亏损"]),
        _blank(),
        _row(["生成时间", new Date().toLocaleString("zh-CN", {timeZone:"Asia/Shanghai"}), ""]),
      ];

      return _sendExcel(res, rows, `成本核算_${p.shipment_no||id}`, 3);
    }

    // ════════════════════════════════
    //  财务 - 海运费用汇总 Excel
    // ════════════════════════════════
    if (type === "finance_shipments") {
      let sql = "SELECT * FROM shipping_plans WHERE etd IS NOT NULL ORDER BY etd DESC";
      const vals = [];
      if (month) {
        vals.push(`${month}%`);
        sql = `SELECT * FROM shipping_plans WHERE etd::text LIKE $1 ORDER BY etd DESC`;
      }
      const sRes = await pool.query(sql, vals);
      const plans = sRes.rows;

      const rows = [
        _hdr2("三林宠物 — 海运费用汇总"),
        _hdr2(`共 ${plans.length} 笔 | 导出时间: ${new Date().toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}`),
        _blank(),
        _rowHeader(["出运编号","ETD","路线","船名","提单号","海运成本USD","海运报价USD","港杂CNY","拖车CNY","报关CNY","保险CNY","合计CNY","客户","状态"]),
        ...plans.map(p => {
          const portFees = [p.doc_fee,p.tlx_fee,p.info_trans_fee,p.bkg_fee,p.thc_fee,p.eir_fee,p.seal_fee]
            .reduce((s,v) => s+Number(v||0), 0);
          const total = Number(p.freight_total_cny||0);
          return _row([
            p.shipment_no||"—",
            p.etd ? String(p.etd).substring(0,10) : "—",
            `${p.pol||""}→${p.pod||""}`,
            p.vessel||"—",
            p.bl_no||"—",
            p.freight_cost ?? "",
            p.freight_sale_usd ?? "",
            portFees || "",
            p.trucking_fee ?? "",
            p.customs_fee ?? "",
            p.insurance_cost ?? "",
            total || "",
            p.customer_en || p.customer || "—",
            p.flow_status || "—",
          ]);
        }),
      ];

      return _sendExcel(res, rows, `海运费用汇总_${month||"全部"}`, 14);
    }

    return res.status(400).json({ error: "type 参数无效: shipping / customs / cost / finance_shipments" });

  } catch (err) {
    console.error("[export-excel]", err);
    return res.status(500).json({ error: err.message });
  }
}

// ════════════════════════════════════════════════
//  SpreadsheetML XML helpers
//  生成 Excel 2003 XML 格式 (无需任何 npm 包)
// ════════════════════════════════════════════════

function _xml(v) {
  if (v == null) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _cell(v, style) {
  if (v == null || v === "") return `<Cell ss:StyleID="${style||"def"}"><Data ss:Type="String"></Data></Cell>`;
  const num = typeof v === "number" || (typeof v === "string" && !isNaN(v) && v.trim() !== "");
  const type = num ? "Number" : "String";
  const val  = _xml(v);
  return `<Cell ss:StyleID="${style||"def"}"><Data ss:Type="${type}">${val}</Data></Cell>`;
}

function _blank()              { return { type: "blank" }; }
function _hdr(text, cols=4)    { return { type: "hdr",  text, cols }; }
function _hdr2(text)           { return { type: "hdr2", text }; }
function _rowHeader(cells)     { return { type: "rowHeader", cells }; }
function _row(cells)           { return { type: "row", cells }; }
function _row4(l1,v1,l2,v2)   { return { type: "row4", l1,v1,l2,v2 }; }

function _renderRow(r) {
  if (r.type === "blank") {
    return `<Row ss:Height="8"></Row>`;
  }
  if (r.type === "hdr2") {
    return `<Row ss:Height="22"><Cell ss:StyleID="title"><Data ss:Type="String">${_xml(r.text)}</Data></Cell></Row>`;
  }
  if (r.type === "hdr") {
    return `<Row ss:Height="18"><Cell ss:StyleID="sectionHdr" ss:MergeAcross="${(r.cols||4)-1}"><Data ss:Type="String">${_xml(r.text)}</Data></Cell></Row>`;
  }
  if (r.type === "rowHeader") {
    return `<Row ss:Height="16">${r.cells.map(c => `<Cell ss:StyleID="colHdr"><Data ss:Type="String">${_xml(c)}</Data></Cell>`).join("")}</Row>`;
  }
  if (r.type === "row") {
    return `<Row ss:Height="16">${r.cells.map(c => _cell(c, "def")).join("")}</Row>`;
  }
  if (r.type === "row4") {
    return `<Row ss:Height="15">
      ${_cell(r.l1, "lbl")}${_cell(r.v1, "val")}
      ${_cell(r.l2, "lbl")}${_cell(r.v2, "val")}
    </Row>`;
  }
  return "";
}

function _sendExcel(res, rows, filename, colCount) {
  // Build column widths
  const colWidths = {
    2: [160, 200],
    3: [160, 120, 200],
    4: [110, 160, 110, 160],
    5: [60, 160, 100, 120, 80],
    14: [100,80,140,100,100,80,80,80,80,80,80,80,120,80],
  };
  const widths = colWidths[colCount] || Array(colCount).fill(100);
  const cols = widths.map(w => `<Column ss:Width="${w}"/>`).join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:x="urn:schemas-microsoft-com:office:excel">
 <Styles>
  <Style ss:ID="def">
   <Font ss:FontName="微软雅黑" ss:Size="10"/>
   <Alignment ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="title">
   <Font ss:FontName="微软雅黑" ss:Size="14" ss:Bold="1" ss:Color="#1E3A8A"/>
   <Alignment ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="sectionHdr">
   <Font ss:FontName="微软雅黑" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1E3A8A" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="colHdr">
   <Font ss:FontName="微软雅黑" ss:Size="9" ss:Bold="1" ss:Color="#334155"/>
   <Interior ss:Color="#EFF6FF" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#1E3A8A"/>
   </Borders>
  </Style>
  <Style ss:ID="lbl">
   <Font ss:FontName="微软雅黑" ss:Size="9" ss:Bold="1" ss:Color="#64748B"/>
   <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="val">
   <Font ss:FontName="微软雅黑" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
   <Alignment ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
 </Styles>
 <Worksheet ss:Name="Sheet1">
  <Table>
   ${cols}
   ${rows.map(_renderRow).join("\n   ")}
  </Table>
 </Worksheet>
</Workbook>`;

  const safeName = filename.replace(/[^\u4e00-\u9fff\w\-_]/g, "_");
  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.xls`);
  res.setHeader("Cache-Control", "no-cache");
  return res.status(200).send(xml);
}
