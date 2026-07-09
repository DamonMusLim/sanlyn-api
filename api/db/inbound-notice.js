// /api/db/inbound-notice.js
// 入货通知 / 订舱确认单 (CARGO RECEIPT / BOOKING CONFIRMATION) — 给工厂/车队看:
// 哪条船、几号收箱开始、几号截港/截关/截单/VGM、几个什么柜、送到哪个港。
// 数据源 = shipping_plans (+ orders 汇总品名/箱数)。截港等时间字段的上游 = 货代订舱确认书(OCR入库,A1)/码头船期系统。
// 版式照 ESL BOOKING CONFIRMATION 范本。字段只对应不编造:空就显"—"。

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function clean(v) { return String(v ?? "").trim(); }
function parseRaw(v) { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v); } catch (_) { return {}; } }
function pick() { for (var i = 0; i < arguments.length; i++) { var v = arguments[i]; if (v !== null && v !== undefined && String(v).trim() !== "") return v; } return ""; }

// timestamptz(UTC) → 北京时间 "YYYY-MM-DD HH:mm"; date型 → "YYYY-MM-DD"; 空→"—"
function fmtDT(v) {
  if (v == null || v === "") return "—";
  var s = String(v);
  // 纯日期(无时间) → 只显日期
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var d = new Date(s);
  if (Number.isNaN(d.getTime())) return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
  var b = new Date(d.getTime() + 8 * 3600 * 1000); // +08 北京
  var p = function (n) { return String(n).padStart(2, "0"); };
  var Y = b.getUTCFullYear(), M = p(b.getUTCMonth() + 1), D = p(b.getUTCDate());
  var h = p(b.getUTCHours()), m = p(b.getUTCMinutes());
  if (h === "00" && m === "00") return Y + "-" + M + "-" + D; // 只有日期精度
  return Y + "-" + M + "-" + D + " " + h + ":" + m;
}
function fmtDate(v) { if (!v) return "—"; var s = String(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s; }
function fmtNum(v, dec) { var n = Number(v); if (!Number.isFinite(n) || n === 0) return "—"; return n.toLocaleString("en-US", { minimumFractionDigits: dec == null ? 0 : dec, maximumFractionDigits: dec == null ? 0 : dec }); }

async function loadPlan(pool, shipmentId) {
  var r = await pool.query(
    `SELECT * FROM shipping_plans WHERE _id::text=$1 OR id::text=$1 OR shipment_no=$1 OR bl_no=$1 OR booking_no=$1 LIMIT 1`,
    [String(shipmentId)]
  );
  return r.rows[0] || null;
}
function orderKeys(plan) {
  var raw = parseRaw(plan.raw);
  var xs = [].concat(Array.isArray(plan.order_nos) ? plan.order_nos : [])
    .concat(Array.isArray(plan.contract_nos) ? plan.contract_nos : [])
    .concat(Array.isArray(raw.orderNos) ? raw.orderNos : [])
    .concat(Array.isArray(raw.contractNos) ? raw.contractNos : [])
    .concat(clean(plan.contract_no) ? [plan.contract_no] : []);
  var seen = new Set();
  return xs.map(clean).filter(function (x) { if (!x || seen.has(x)) return false; seen.add(x); return true; });
}
async function loadOrders(pool, plan) {
  var keys = orderKeys(plan);
  if (!keys.length) return [];
  var r = await pool.query(
    `SELECT * FROM orders WHERE order_no = ANY($1::text[]) OR contract_no = ANY($1::text[]) OR _id::text = ANY($1::text[]) OR id::text = ANY($1::text[]) ORDER BY id ASC`,
    [keys]
  );
  return r.rows;
}
// 按柜取 order_containers→containers (P4真源), 用于 per-柜 明细行
async function loadContainerSlices(pool, plan) {
  var bl = clean(plan.bl_no);
  if (!bl) return [];
  try {
    var r = await pool.query(
      `SELECT c.container_no, c.seal_no, c.container_type,
              array_agg(DISTINCT o.order_no) AS order_nos
         FROM order_containers oc
         JOIN containers c ON c.id = oc.container_id
         LEFT JOIN shipment_group sg ON sg.id = c.shipment_group_id
         JOIN orders o ON o.id = oc.order_id
        WHERE (sg.bl_master = $1 OR o.bl_no = $1 OR o.raw->>'blNo' = $1 OR o.raw->>'bl_no' = $1)
          AND NULLIF(btrim(c.container_no),'') IS NOT NULL
        GROUP BY c.container_no, c.seal_no, c.container_type
        ORDER BY c.container_no`,
      [bl]
    );
    return r.rows || [];
  } catch (_) { return []; }
}

function fsFromOrders(orders) {
  var set = new Set();
  orders.forEach(function (o) {
    var raw = parseRaw(o.raw);
    var vals = [o.fs_no, raw.fs_no, raw.fsNo, o.internal_no, raw.internal_no, o.contract_no];
    for (var i = 0; i < vals.length; i++) {
      var m = String(vals[i] || "").match(/\bFS[0-9A-Z-]+\b/i);
      if (m) { set.add(m[0].toUpperCase()); break; }
    }
  });
  return [...set];
}

export async function renderInboundNotice(pool, shipmentId, opts) {
  opts = opts || {};
  var plan = await loadPlan(pool, shipmentId);
  if (!plan) return `<!DOCTYPE html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h3>入货通知</h3><p>未找到船务计划: ${esc(shipmentId)}</p></body>`;
  var raw = parseRaw(plan.raw);
  var orders = await loadOrders(pool, plan);
  var slices = await loadContainerSlices(pool, plan);

  var bookingNo = pick(plan.booking_no, plan.forwarder_booking_no, raw.bookingNo, plan.bl_no, plan.shipment_no);
  var extRef = pick(plan.forwarder_booking_no, raw.forwarderMark, "");
  var vv = [clean(plan.vessel), clean(plan.voyage)].filter(Boolean).join(" / ") || "—";
  var carriageTerm = pick(plan.freight_term, raw.carriageTerm, "CY / CY");
  var carrier = pick(plan.shipping_line, plan.carrier_code, "—");
  var forwarder = pick(plan.forwarder_cn, plan.forwarder_en, "—");
  var pol = pick(plan.pol, "—"), pod = pick(plan.pod, "—");
  var ctnQty = pick(plan.container_qty, raw.containerQty, "");
  var ctnType = pick(plan.container_type, raw.containerType, "—");

  // 汇总货 (缺 per-柜 时用)
  var totQty = 0, totGw = 0, totCbm = 0;
  orders.forEach(function (o) { totQty += Number(o.total_qty || 0); totGw += Number(o.gross_weight || 0); totCbm += Number(o.total_cbm || 0); });
  var fsList = fsFromOrders(orders);
  var fsText = fsList.join(" / ") || pick(plan.contract_no, "—");

  // 时间字段映射 (照 ESL)
  var rows = [
    ["预计开船 ETD", fmtDT(plan.etd)],
    ["预计到港 ETA", fmtDT(plan.eta)],
    ["收箱开始 CY Open", fmtDT(pick(plan.port_open_date, ""))],
    ["截港 CY Cut-off", fmtDT(pick(plan.port_cutoff_at, plan.cargo_cutoff, ""))],
    ["截关 Customs Closing", fmtDT(pick(plan.customs_cutoff, ""))],
    ["VGM 截止 VGM Cut-off", fmtDT(pick(plan.vgm_cutoff, plan.vgm_cutoff_at, ""))],
    ["截单 SI Cut-off", fmtDT(pick(plan.si_cutoff_date, plan.doc_cutoff_at, plan.doc_cutoff, ""))],
  ];

  // 品名/箱数明细行: 有 per-柜就每柜一行, 否则一条汇总
  var commodityRows;
  if (slices.length) {
    commodityRows = slices.map(function (s, i) {
      var ordShort = (s.order_nos || []).filter(Boolean).map(function (n) { return String(n).replace(/^\d+-/, ""); }).join("/");
      return `<tr><td>${i + 1}</td><td>${esc(s.container_type || ctnType)}</td><td>${esc(s.container_no || "—")}</td><td>${esc(s.seal_no || "—")}</td><td class="l">${esc(ordShort || fsText)}</td></tr>`;
    }).join("");
  } else {
    commodityRows = `<tr><td>1</td><td>${esc(ctnType)}</td><td>${ctnQty ? esc(ctnQty) + " 柜" : "—"}</td><td>—</td><td class="l">${esc(fsText)}</td></tr>`;
  }

  var genAt = fmtDT(new Date().toISOString());
  var title = "入货通知 · CARGO RECEIPT NOTICE";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>入货通知 — ${esc(bookingNo)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:12px;color:#0f172a;background:#f1f5f9}
.page{max-width:210mm;margin:18px auto;padding:14mm 12mm;background:#fff;box-shadow:0 4px 32px rgba(0,0,0,.12);border-radius:8px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1e3a8a;padding-bottom:10px;margin-bottom:14px}
.co-name{font-size:16px;font-weight:900;color:#1e3a8a}.co-sub{font-size:9px;color:#94a3b8;margin-top:2px}
.doc-t{font-size:17px;font-weight:800;color:#1e3a8a;text-align:right}
.ref{font-family:monospace;font-size:12px;font-weight:700;background:#eff6ff;padding:2px 9px;border-radius:4px;border:1px solid #bfdbfe;display:inline-block;margin-top:4px}
.gen{font-size:9px;color:#94a3b8;margin-top:3px;text-align:right}
.grid2{display:grid;grid-template-columns:1fr 1fr;border:1px solid #cbd5e1;border-bottom:none}
.cell{padding:7px 10px;border-bottom:1px solid #e2e8f0;border-right:1px solid #e2e8f0}
.cell:nth-child(2n){border-right:none}
.lbl{font-size:8.5px;font-weight:700;color:#1e3a8a;text-transform:uppercase;letter-spacing:.05em}
.val{font-size:12.5px;font-weight:700;color:#0f172a;margin-top:2px}
.section-t{font-size:11px;font-weight:800;color:#1e3a8a;margin:16px 0 6px}
.cut{border:2px solid #dc2626;border-radius:6px;overflow:hidden;margin-top:6px}
.cut-h{background:#fef2f2;color:#dc2626;font-weight:800;font-size:11px;padding:6px 10px;border-bottom:1px solid #fecaca}
.cut-grid{display:grid;grid-template-columns:repeat(2,1fr)}
.cut-c{padding:7px 12px;border-bottom:1px solid #f1f5f9;border-right:1px solid #f1f5f9;display:flex;justify-content:space-between;align-items:center;gap:8px}
.cut-c:nth-child(2n){border-right:none}
.cut-l{font-size:10.5px;color:#475569;font-weight:600}.cut-v{font-size:12.5px;font-weight:800;color:#0f172a;font-family:monospace}
table{width:100%;border-collapse:collapse;margin-top:6px}
thead th{background:#1e3a8a;color:#fff;padding:6px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;text-align:center}
tbody td{padding:6px 8px;border:1px solid #e2e8f0;font-size:11px;text-align:center}
tbody td.l{text-align:left;font-family:monospace}
.notes{margin-top:16px;font-size:9.5px;color:#64748b;line-height:1.7}
.notes b{color:#334155}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;border-radius:0}}
</style></head><body>
<div class="page">
  <div class="hdr">
    <div><div class="co-name">三林宠物 Sanlyn</div><div class="co-sub">XIAMEN SANLYN IMPORT AND EXPORT CO., LTD</div><div class="co-sub">ai.sanlynos.com</div></div>
    <div><div class="doc-t">${title}</div><div class="ref">${esc(bookingNo)}</div><div class="gen">生成时间 Generated: ${genAt}</div></div>
  </div>

  <div class="grid2">
    <div class="cell"><div class="lbl">订舱号 Booking No.</div><div class="val">${esc(bookingNo)}</div></div>
    <div class="cell"><div class="lbl">参考号 Ext. Ref.</div><div class="val">${esc(extRef || "—")}</div></div>
    <div class="cell"><div class="lbl">船名/航次 Vessel / Voyage</div><div class="val">${esc(vv)}</div></div>
    <div class="cell"><div class="lbl">运输条款 Carriage Term</div><div class="val">${esc(carriageTerm)}</div></div>
    <div class="cell"><div class="lbl">起运港 Port of Load</div><div class="val">${esc(pol)}</div></div>
    <div class="cell"><div class="lbl">卸货港 Port of Discharge</div><div class="val">${esc(pod)}</div></div>
    <div class="cell"><div class="lbl">承运人 Carrier</div><div class="val">${esc(carrier)}</div></div>
    <div class="cell"><div class="lbl">货代 Forwarder</div><div class="val">${esc(forwarder)}</div></div>
  </div>

  <div class="section-t">⏰ 关键时间节点 (KEY DEADLINES) — 工厂/车队务必在截港前送货装柜</div>
  <div class="cut">
    <div class="cut-h">🚨 逾期截港/截单将无法配载,费用与损失由责任方承担</div>
    <div class="cut-grid">
      ${rows.map(function (r) { return `<div class="cut-c"><span class="cut-l">${r[0]}</span><span class="cut-v">${esc(r[1])}</span></div>`; }).join("")}
    </div>
  </div>

  <div class="section-t">📦 箱量 / 货物 (CONTAINERS &amp; CARGO)</div>
  <div class="grid2">
    <div class="cell"><div class="lbl">箱量 Container Qty</div><div class="val">${ctnQty ? esc(ctnQty) + " × " + esc(ctnType) : esc(ctnType)}</div></div>
    <div class="cell"><div class="lbl">FS / 合同号 Contract</div><div class="val">${esc(fsText)}</div></div>
    <div class="cell"><div class="lbl">总箱数 Total CTNS</div><div class="val">${fmtNum(totQty)}${totQty ? " CTN" : ""}</div></div>
    <div class="cell"><div class="lbl">总毛重 / 体积 GW / CBM</div><div class="val">${fmtNum(totGw)}${totGw ? " KG" : ""} · ${fmtNum(totCbm, 3)}${totCbm ? " CBM" : ""}</div></div>
  </div>
  <table>
    <thead><tr><th>序号</th><th>箱型 Type</th><th>柜号 Container No.</th><th>封签 Seal</th><th>订单/FS Order · FS</th></tr></thead>
    <tbody>${commodityRows}</tbody>
  </table>

  <div class="notes">
    <b>重要提示 REMARKS:</b><br>
    1. 以上时间以码头船期系统及货代订舱确认书为准;如有变动,请及时与相应客服/单证联系确认。<br>
    2. 工厂/车队须在<b>截港时间</b>前将货物送达指定堆场并完成装柜、施封(记录柜号+封签号回传)。<br>
    3. 危险品/特殊装载须提前书面确认;漏报、瞒报导致的一切损失与费用由责任方承担。<br>
    4. 改单、电放须提前一个工作日与我司确认。<br>
    <span style="color:#94a3b8">— 本通知由 Sanlyn OS 供应链引擎生成 · Generated &amp; Verified by Sanlyn OS Supply Chain Engine</span>
  </div>
</div>
</body></html>`;
}
