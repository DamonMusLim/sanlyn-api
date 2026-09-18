// EXW 全费用账单(客户版) — type=exw_invoice
// EXW 客户付全部:一张含海运费(USD)+港杂/拖车等(CNY)的账单,TO=客户。
// 数据真源 = active_freight_supplier_bills 的 sale_amount(客户卖价,不按 payer 过滤);
// 无真实账单则显"待录入账单",绝不落费率卡估算(区别于 fob_portcharge 的兜底卡)。
// 版式复用 fob_portcharge 的洋宝宝 INVOICE + 集装箱明细;字段级 data-field/data-row 供前端绑定。
// 渲染逻辑独立于 shipping-plan-pdf.js(单文件≤500行铁律)。
import { docIssueDate } from "./lib/portcharge-close-loop.js";
import { getLockedCustomerBill, renderLockedCustomerBillHtml } from "./lib/customer-bill-snapshot.js";

function esc(s){ if(s===null||s===undefined)return""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmtNum(v){ var n=Number(v); if(!isFinite(n))return"0.00"; return n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtDate(v){ if(!v)return"—"; try{return new Date(v).toISOString().slice(0,10);}catch(e){return String(v);} }
function num(v){ var n=Number(v); return isFinite(n)?n:0; }
function cleanBlNo(v){ return String(v||"").split("#")[0].trim(); }
function isPendingBl(v){ v=cleanBlNo(v); return !v || /待补/.test(v); }
function feeBasisLabel(v){
  v=String(v||"").trim();
  if(v==="per_container")return"Per Container / 每柜";
  if(v==="per_bl")return"Per B/L / 每票";
  return v;
}

// 费目中英对照(仅展示美化,取不到时原样显示 cost_category)
const FEE_EN = {
  "海运费":"Ocean Freight","THC":"THC","码头操作费(THC)":"THC","单证费":"Documentation","电放费":"Telex Release",
  "订舱费":"Booking","封签费":"Seal","铅封费":"Seal","VGM":"VGM","设备交接费":"EIR","设备交接单费":"EIR",
  "港杂费":"Port Misc","场站费":"Yard","场站费用":"Yard","提箱费":"Container Pickup","操作费":"Operation",
  "报关费":"Customs Declaration","舱单费":"Manifest","包干费":"Lumpsum","拖车费":"Trucking","改单费":"Amendment",
  "燃油附加费":"Fuel Surcharge","码头信息服务费":"Terminal Info","EDI":"EDI","申报费":"Declaration","舱单信息费":"Manifest",
  "FE产地证代办费":"Form E Cert","fe_cert":"Form E Cert"
};

export async function renderExwInvoice(pool, p, orders, cust, query, res){
  query = query || {};
  const lockedBill = await getLockedCustomerBill(pool, p.bl_no, "exw_invoice", query.payer_company_code);
  if (lockedBill) return renderLockedCustomerBillHtml(lockedBill);
  const genDate = docIssueDate(p);
  const isQuote = String((query&&query.quote)||"")==="1"; // 报价表模式(发货前):英文QUOTATION,只客户+航线,无柜无银行
  const rawBlNo = cleanBlNo(p.bl_no);
  const blNo    = rawBlNo || "待补提单号";
  const vessel  = [p.vessel, p.voyage].filter(Boolean).join(" / ") || "—";
  const ctnType = p.container_type || "40HQ";
  const serviceScope = "Ocean Freight + Local Charges / 海运费+港杂";
  const ap = String(query.autoprint||"")==="1" ? "<scr"+"ipt>window.onload=function(){window.print()}</scr"+"ipt>" : "";
  const docWarnings = [];

  // ── 收货人/客户(TO) ──
  const toName = p.customer_en || p.customer || p.customer_cn || (cust && (cust.name_en||cust.name_cn)) || "—";
  const toAddr = (cust && (cust.address||"")) || (p.raw && (p.raw.consigneeAddress||p.raw.customerAddress)) || "";

  // ── 对外发票号 · 锁版:老号不动;新号=EXW-提单号-出单日 ──
  const _rawObj = (p.raw && typeof p.raw==="object") ? p.raw : {};
  let invNo = _rawObj.exw_invoice_no || p.exw_invoice_no || "";
  if(!invNo){
    if(isPendingBl(rawBlNo)){
      invNo = "待补提单号";
      docWarnings.push("提单号为空或待补，未生成EXW全费用单号");
    }else{
      invNo = "EXW-" + rawBlNo + "-" + genDate.replace(/-/g,"");
      try{ // 幂等锁定:仅当为空时写,避免并发改老号
        await pool.query(
          `UPDATE shipping_plans SET raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object('exw_invoice_no',$2::text,'exw_invoice_issued_at',$3::text) WHERE id=$1 AND (raw->>'exw_invoice_no') IS NULL`,
          [p.id, invNo, genDate]
        );
      }catch(e){}
    }
  }

  // ── 当日参考汇率(USD_CNY)· 客户参考,各币种仍按币种分付 ──
  let fxRate = 0;
  try{
    const fr = await pool.query(
      `SELECT rate FROM exchange_rates
        WHERE currency_pair='USD_CNY' AND fetched_at::date <= $1::date
        ORDER BY fetched_at DESC LIMIT 1`,
      [genDate]
    );
    if(fr.rows.length) fxRate = parseFloat(fr.rows[0].rate) + 0.1;
  }catch(e){}

  // ── 集装箱明细:优先 container_bookings(每柜真实毛重/封号,复用 fob_invoice 数据源),退回 containers_detail ──
  let ctnList = [];
  try{
    const cb = await pool.query(
      `SELECT container_no, seal_no, contract_no, cargo_weight_kg::numeric AS gw, vgm_weight_kg::numeric AS vgm
         FROM container_bookings WHERE shipping_plan_id=$1 AND COALESCE(container_no,'')<>'' ORDER BY id`,
      [p.id]
    );
    if(cb.rows.length) ctnList = cb.rows.map(r=>({container_no:r.container_no, seal_no:r.seal_no, contracts:r.contract_no?[r.contract_no]:[], cargo_kg:r.gw||r.vgm}));
  }catch(e){}
  if(!ctnList.length){
    let ctn = p.containers_detail;
    if(typeof ctn==="string"){ try{ ctn=JSON.parse(ctn); }catch(e){ ctn=[]; } }
    if(!Array.isArray(ctn)) ctn=[];
    const realCtn = ctn.filter(c=>c && (c.container_no||c.containerNo));
    ctnList = realCtn.length ? realCtn : ctn;
  }
  const actualCtnQty = ctnList.length || num(p.container_qty) || 0;
  let footGW=0, footCBM=0, footCTN=0;
  const ctnRows = ctnList.map((c,i)=>{
    const no  = c.container_no||c.containerNo||"—";
    const seal= c.seal_no||c.sealNo||c.seal||"—";
    const po  = Array.isArray(c.contracts)&&c.contracts.length ? c.contracts.join(", ") : (c.po||c.contract_no||"—");
    const gw  = num(c.cargo_kg||c.gross_kg||c.gross_weight_kg||c.grossWeight);
    const cbm = num(c.cbm||c.total_cbm||c.volume);
    const ctns= num(c.cartons||c.ctn||c.total_cartons);
    footGW+=gw; footCBM+=cbm; footCTN+=ctns;
    return `<tr class="ctn-row" data-field="container" data-row="${i}">
      <td class="ctn-idx" data-field="container_idx">Cntr ${i+1}</td>
      <td class="ctn-no" data-field="container_no">${esc(no)}</td>
      <td class="ctn-seal" data-field="seal_no">${esc(seal)}</td>
      <td data-field="po">${esc(po)}</td>
      <td class="ctn-ctn" data-field="ctn">${ctns?ctns.toLocaleString('en'):'—'}</td>
      <td class="ctn-gw" data-field="gw">${gw?fmtNum(gw)+'&nbsp;KGS':'—'}</td>
      <td class="ctn-cbm" data-field="cbm">${cbm?cbm.toFixed(3)+'&nbsp;CBM':'—'}</td>
    </tr>`;
  }).join("");

  // ── 费用:该票全部 fsb 卖价行,不按 payer 过滤(EXW 全给客户)──
  let feeRows=[];
  try{
    const r = await pool.query(
      `SELECT cost_category, currency, sale_amount, qty, unit_price, charge_basis
         FROM active_freight_supplier_bills
        WHERE (bl_no=$1 OR link_plan_id=$2)
          AND COALESCE(sale_amount,0) > 0
          AND COALESCE(rebill_status,'') NOT IN ('voided','absorbed')
        ORDER BY (CASE WHEN UPPER(COALESCE(currency,'CNY'))='USD' THEN 0 ELSE 1 END), sale_amount DESC`,
      [rawBlNo || p.bl_no || "", String(p.id)]
    );
    feeRows = r.rows||[];
  }catch(e){ feeRows=[]; }

  const usdRows = feeRows.filter(r=>String(r.currency||"").toUpperCase()==="USD");
  const cnyRows = feeRows.filter(r=>String(r.currency||"").toUpperCase()!=="USD");
  let totUSD=0, totCNY=0;
  function feeRowHtml(r){
    const cat=r.cost_category||"—";
    const en=FEE_EN[cat]||"";
    const cur=String(r.currency||"CNY").toUpperCase();
    const amt=num(r.sale_amount);
    if(cur==="USD")totUSD+=amt; else totCNY+=amt;
    const qty=num(r.qty)||1;
    const up=qty?amt/qty:amt; // 单价=卖价÷数量,保证 qty×单价=金额 对齐(不用成本 unit_price)
    const rawBasis=r.charge_basis||(qty>1?"每柜":"整票");
    const basis=feeBasisLabel(rawBasis);
    if(rawBasis==="per_container" && actualCtnQty>0 && qty!==actualCtnQty){
      docWarnings.push(`${cat}费用数量与柜数不一致: Qty=${qty}, 柜数=${actualCtnQty}`);
    }
    return `<tr data-field="fee" data-row="${esc(cat)}" data-cur="${cur}">
      <td class="label" data-field="fee_name">${esc(cat)}${en?` <span style="color:#999;font-size:8.5px">${esc(en)}</span>`:""}</td>
      <td data-field="fee_basis">${esc(basis)}</td>
      <td class="c" data-field="fee_cur">${cur}</td>
      <td class="c" data-field="fee_qty">${qty}</td>
      <td class="r" data-field="fee_price">${fmtNum(up)}</td>
      <td class="r" data-field="fee_amt">${fmtNum(amt)}</td>
    </tr>`;
  }
  const usdHtml = usdRows.map(feeRowHtml).join("");
  const cnyHtml = cnyRows.map(feeRowHtml).join("");
  // 汇总版(?summary=1):海运/港杂各收成一行总额(详情看报价表);totUSD/totCNY 已由上方 map 累加
  const _sum = String(query.summary||"")==="1";
  const usdShow = (_sum && totUSD>0) ? `<tr data-field="fee" data-cur="USD"><td class="label" data-field="fee_name">海运费总额 Ocean Freight (Total)</td><td>Per B/L / 每票</td><td class="c">USD</td><td class="c">1</td><td class="r">${fmtNum(totUSD)}</td><td class="r" data-field="fee_amt">${fmtNum(totUSD)}</td></tr>` : usdHtml;
  const cnyShow = (_sum && totCNY>0) ? `<tr data-field="fee" data-cur="CNY"><td class="label" data-field="fee_name">港杂及其他总额 Local &amp; Other Charges (Total)</td><td>Per B/L / 每票</td><td class="c">CNY</td><td class="c">1</td><td class="r">${fmtNum(totCNY)}</td><td class="r" data-field="fee_amt">${fmtNum(totCNY)}</td></tr>` : cnyHtml;
  const noBill  = feeRows.length===0;
  const warningHeader = docWarnings.map(w=>encodeURIComponent(w)).join(";");
  try{
    const outRes = res || (query && (query.res || query._res || query.response));
    if(outRes && typeof outRes.setHeader==="function" && warningHeader)outRes.setHeader("X-Doc-Warnings", warningHeader);
  }catch(e){}

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>EXW Full-Charge Invoice — ${esc(invNo||blNo)}</title>
<meta name="doc-warnings" content="${esc(warningHeader)}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:11px;color:#111;background:#e5e7eb;padding:0}
.page{max-width:200mm;margin:14px auto;padding:11mm 13mm;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:14px}
.hdr-l{min-width:0}
.hdr-l .co-en{font-size:15px;font-weight:900;color:#111;line-height:1.2;white-space:nowrap}
.hdr-l .co-cn{font-size:10px;color:#555;margin-top:3px}
.hdr-l .tag{font-size:8.5px;color:#888;margin-top:4px}
.hdr-r{flex:0 0 auto;min-width:190px;text-align:right}
.hdr-r .doc-en{font-size:18px;font-weight:900;color:#111;letter-spacing:.05em}
.hdr-r .doc-cn{font-size:10px;color:#555;margin-top:1px}
.hdr-r .inv-no{display:inline-block;font-size:10px;font-weight:800;color:#111;font-family:monospace;border:2px solid #111;border-radius:3px;padding:2px 8px;margin-top:4px;white-space:nowrap;word-break:keep-all}
.info-grid{display:grid;grid-template-columns:112px 1fr 112px 1fr;margin-bottom:12px;border:1px solid #e0e0e0;border-radius:4px;overflow:hidden;font-size:10px}
.info-grid .lbl,.info-grid .val{min-height:22px;padding:4px 8px;border-right:1px solid #efefef;border-bottom:1px solid #efefef;display:flex;align-items:center}
.info-grid .lbl{background:#f7f7f7;color:#666;font-weight:700}
.info-grid .val{color:#111;font-weight:600;min-width:0}
.info-grid .val:nth-child(4n){border-right:none}
.info-grid .to-val{grid-column:2/5;display:block;font-size:12px;font-weight:900}
.info-grid .to-addr{font-size:9px;font-weight:400;color:#555;margin-top:2px;line-height:1.35}
table.charges{width:100%;border-collapse:collapse;font-size:10px;border:1px solid #ccc}
table.charges thead th{background:#111;color:#fff;padding:7px 8px;text-align:left;font-weight:700;font-size:9px;white-space:nowrap}
table.charges thead th.r{text-align:right}
table.charges thead th.c{text-align:center}
table.charges tr.section td{background:#333;color:#fff;font-weight:800;font-size:9.5px;text-transform:uppercase;padding:5px 9px}
table.charges tbody td{padding:7px 9px;border-bottom:1px solid #efefef;font-family:monospace;color:#111}
table.charges tbody td.label{font-family:inherit;color:#222}
table.charges tbody td:nth-child(2),table.charges tbody td:nth-child(3),table.charges tbody td:nth-child(4),table.charges tbody td:nth-child(5),table.charges tbody td:nth-child(6){white-space:nowrap}
table.charges tbody td.r{text-align:right}
table.charges tbody td.c{text-align:center}
table.charges tfoot tr td{padding:7px 9px;font-weight:800;font-family:monospace;color:#111;background:#f7f7f7;border-top:2px solid #111}
table.charges tfoot tr td.label{font-family:inherit;text-align:right;font-size:10px}
table.charges tfoot tr td:last-child{text-align:right}
.fx-note{text-align:right;font-size:8.5px;color:#666;margin:6px 0 4px;font-style:italic}
.fx-note strong{color:#111;font-style:normal}
.pay-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:8px 0 14px}
.pay-box{padding:12px 14px;border-radius:4px;border:2px solid #111}
.pay-box.usd{background:#f7f7f7}.pay-box.cny{background:#efefef}
.pay-box .plbl{font-size:8.5px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;color:#111;margin-bottom:5px}
.pay-box .pamt{font-size:20px;font-weight:900;font-family:monospace;color:#111}
.pay-box .psub{font-size:8px;color:#666;margin-top:3px}
.bottom{display:grid;grid-template-columns:1.05fr 1fr;gap:10px}
.box-tt,.box-bk{padding:9px 11px;background:#f9f9f9;border:1px solid #ddd;border-radius:4px;font-size:9px;line-height:1.8;color:#444}
.box-tt strong,.box-bk strong{color:#111}
.box-tt .title,.box-bk .title{font-size:9.5px;font-weight:900;color:#111;margin-bottom:4px;text-transform:uppercase;border-bottom:1px solid #ddd;padding-bottom:3px}
table.cntr{width:100%;border-collapse:collapse;table-layout:fixed}
table.cntr th{padding:5px 7px;text-align:left;white-space:nowrap;background:#333;color:#fff;font-size:9px;font-weight:700}
table.cntr th.r{text-align:right}
tr.ctn-row td{padding:5px 7px;border-bottom:1px solid #efefef;color:#111;font-size:9.5px;white-space:nowrap}
tr.ctn-row td.ctn-idx{color:#888;font-size:9px}
tr.ctn-row td.ctn-no{font-family:monospace;font-weight:800}
tr.ctn-row td.ctn-seal{font-family:monospace;color:#555}
@media print{body{padding:0;background:#fff}.page{margin:0;padding:6mm 9mm;box-shadow:none}table.charges tbody td{padding:4px 9px}table.charges thead th{padding:5px 9px}table.charges tr.section td{padding:3px 9px}table.charges tfoot tr td{padding:5px 9px}.pay-box{padding:8px 12px}.pay-box .pamt{font-size:18px}.pay-grid{margin:6px 0 8px}.fx-note{margin:3px 0 3px}.pay-grid,.pay-box,.bottom,.box-tt,.box-bk{page-break-inside:avoid;break-inside:avoid}}
@media screen{body{background:#f1f5f9}.page{box-shadow:0 4px 32px rgba(0,0,0,.12);margin:20px auto;border-radius:8px}}
</style></head><body>
<div class="page">
  <div class="hdr">
    <div class="hdr-l">
      <div class="co-en">SHANGHAI OCEAN BABY INT'L LOGISTICS CO., LTD.</div>
      <div class="co-cn">上海洋宝宝国际物流有限公司</div>
      <div class="tag">Ocean Freight · Air Freight · Express · Integrated Logistics Solutions</div>
    </div>
    <div class="hdr-r">
      <div class="doc-en">${isQuote?'QUOTATION':'INVOICE'}</div>
      <div class="inv-no" data-field="invoice_no">No. ${esc(invNo)}</div>
    </div>
  </div>

  ${noBill?`<div style="background:#fff3cd;border:2px solid #c00;border-radius:4px;padding:8px 12px;margin-bottom:12px;font-size:11px;font-weight:800;color:#c00">
    ⚠️ 该票暂无已录入账单(freight_supplier_bills sale_amount),请先录入费用后再出单。<br>⚠️ No billed charges recorded for this shipment yet — enter charges before issuing.
  </div>`:""}

  ${isQuote?`<div style="border:1px solid #e0e0e0;border-radius:4px;padding:8px 12px;margin-bottom:12px;font-size:10px;line-height:1.6">
    <div data-field="to"><span style="color:#666;font-weight:700">TO / 客户: </span><span style="font-size:12px;font-weight:900">${esc(toName)}</span></div>
    <div style="color:${toAddr?'#555':'#bbb'};font-size:9px" data-field="to_addr">${toAddr?esc(toAddr):'Address 地址: _______________________________'}</div>
    <div style="margin-top:5px;border-top:1px dashed #ddd;padding-top:5px;display:flex;gap:24px;flex-wrap:wrap">
      <span data-field="pol"><b>Route 航线:</b> ${esc(p.pol||"—")} &rarr; ${esc(p.pod||"—")}</span>
      <span data-field="vessel"><b>Vessel 船名航次:</b> ${esc(vessel)}</span>
    </div>
  </div>`:`<div class="info-grid">
    <div class="lbl">TO (客户名称):</div><div class="val to-val" data-field="to">${esc(toName)}<div class="to-addr" style="color:${toAddr?'#555':'#bbb'}" data-field="to_addr">${toAddr?esc(toAddr):'地址 Address: _______________________________'}</div></div>
    <div class="lbl">DATE (出单日期):</div><div class="val" data-field="date">${genDate}</div><div class="lbl">INV/BL NO.:</div><div class="val" data-field="bl_no">${esc(blNo)}</div>
    <div class="lbl">Vessel/Voyage:</div><div class="val" data-field="vessel">${esc(vessel)}</div><div class="lbl">ETD (离港日):</div><div class="val" data-field="etd">${fmtDate(p.etd)}</div>
    <div class="lbl">P.O.L (起运港):</div><div class="val" data-field="pol">${esc(p.pol||"—")}</div><div class="lbl">P.O.D (目的港):</div><div class="val" data-field="pod">${esc(p.pod||"—")}</div>
    <div class="lbl">SHPT MODE:</div><div class="val">Sea Export</div><div class="lbl">Service:</div><div class="val" data-field="service">${esc(serviceScope)}</div>
  </div>`}

  ${!isQuote?`<div style="margin-bottom:12px;border:1px solid #ddd;border-radius:4px;overflow:hidden;font-size:10px">
    <div style="background:#111;color:#fff;font-weight:800;font-size:9.5px;padding:6px 10px;display:flex;justify-content:space-between;align-items:center">
      <span data-field="cntr_summary">Containers / 集装箱明细 (${actualCtnQty} × ${esc(ctnType)})</span>
      <span style="font-weight:700" data-field="service">Service: ${esc(serviceScope)}</span>
    </div>
    <table class="cntr">
      <colgroup><col style="width:54px"><col style="width:112px"><col style="width:88px"><col style="width:112px"><col style="width:48px"><col style="width:116px"><col style="width:78px"></colgroup>
      <thead><tr>
        <th>Cntr #</th>
        <th>Container No.</th>
        <th>Seal No.</th>
        <th>PO / 合同号</th>
        <th class="r">CTN</th>
        <th class="r">Gross Weight</th>
        <th class="r">Volume</th>
      </tr></thead>
      <tbody>${ctnRows||`<tr><td colspan="7" style="padding:8px;text-align:center;color:#999">— 待绑定柜信息 —</td></tr>`}</tbody>
      <tfoot><tr style="background:#f7f7f7;font-weight:900;border-top:2px solid #111;font-size:9.5px">
        <td style="padding:6px 8px;color:#666;font-size:9px" data-field="cntr_total">${actualCtnQty} × ${esc(ctnType)}</td>
        <td style="padding:6px 8px" colspan="3"></td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace">${footCTN?footCTN.toLocaleString('en'):'—'}</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace;white-space:nowrap">${footGW?fmtNum(footGW)+'&nbsp;KGS':'—'}</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace;white-space:nowrap">${footCBM?footCBM.toFixed(3)+'&nbsp;CBM':'—'}</td>
      </tr></tfoot>
    </table>
  </div>`:""}

  <table class="charges">
    <colgroup><col style="width:30%"><col style="width:18%"><col style="width:11%"><col style="width:8%"><col style="width:15%"><col style="width:18%"></colgroup>
    <thead><tr>
      <th>Charge Item / 费用明细</th><th>Unit / 计费单位</th>
      <th class="c">Curr. / 币种</th><th class="c">Qty / 数量</th>
      <th class="r">Unit Price / 单价</th><th class="r">Amount / 合计</th>
    </tr></thead>
    <tbody>
      ${usdShow?`<tr class="section"><td colspan="6">Ocean Freight | 海运费</td></tr>${usdShow}`:""}
      ${cnyShow?`<tr class="section"><td colspan="6">Local &amp; Other Charges | 港杂及其他</td></tr>${cnyShow}`:""}
    </tbody>
    <tfoot>
      ${totUSD>0?`<tr><td class="label" colspan="5">SUBTOTAL USD (美金小计)</td><td data-field="subtotal_usd">USD ${fmtNum(totUSD)}</td></tr>`:""}
      ${totCNY>0?`<tr><td class="label" colspan="5">SUBTOTAL CNY (人民币小计)</td><td data-field="subtotal_cny">CNY ${fmtNum(totCNY)}</td></tr>`:""}
    </tfoot>
  </table>

  ${fxRate>0?`<div class="fx-note">* 任选一种方式: 分币种支付(海运费付USD账户、港杂付CNY账户),或按出单日汇率整张折成一种币种全额支付。Either payment method is acceptable: pay each currency separately (ocean freight to USD A/C and local charges to CNY A/C), or pay the whole invoice in one currency converted at the invoice-date rate.</div>
  <div class="fx-note">开票日期汇率 Invoice Date Rate (<strong>${genDate}</strong>): <strong>1 USD = ${fxRate.toFixed(4)} CNY</strong></div>`:""}
  <div class="pay-grid">
    <div class="pay-box usd">
      <div class="plbl">TOTAL PAYABLE IN USD · 全付美金</div>
      <div class="pamt" data-field="pay_usd">$ ${fmtNum(fxRate>0?(totUSD+totCNY/fxRate):totUSD)}</div>
      <div class="psub">${fxRate>0?`海运 USD ${fmtNum(totUSD)} + 港杂 CNY ${fmtNum(totCNY)} ÷ ${fxRate.toFixed(4)}`:"Ocean freight · Remit to USD A/C below"}</div>
    </div>
    <div class="pay-box cny">
      <div class="plbl">TOTAL PAYABLE IN CNY · 全付人民币</div>
      <div class="pamt" data-field="pay_cny">¥ ${fmtNum(fxRate>0?(totCNY+totUSD*fxRate):totCNY)}</div>
      <div class="psub">${fxRate>0?`港杂 CNY ${fmtNum(totCNY)} + 海运 USD ${fmtNum(totUSD)} × ${fxRate.toFixed(4)}`:"Local charges · Remit to CNY A/C below"}</div>
    </div>
  </div>

  <div class="bottom" style="${isQuote?'grid-template-columns:1fr':''}">
    <div class="box-tt">
      <div class="title">${isQuote?'TERMS (报价条款)':'TERMS &amp; CONDITIONS (法律声明与条款)'}</div>
      ${isQuote?`1. VALIDITY: This quotation is valid until advised; rates subject to carrier / market change.<br>
      2. CURRENCY: Ocean freight quoted in USD; local charges in CNY.<br>
      3. This is a QUOTATION for reference only, NOT an invoice for payment.<br>
      <span style="color:#c00;font-weight:700">* 以上报价如遇市场波动、船期变更或改单等特殊情况,将实时更新,以我司最终确认为准。The above rates are subject to real-time update in the event of market fluctuation, schedule change or order amendment; our final confirmation shall prevail.</span>`:`1. PAYMENT DUE: Please arrange payment strictly within the agreed credit term. Late payment may delay release of the Bill of Lading or cargo.<br>
      2. PAYMENT OPTION: Pay USD/CNY items separately to the corresponding accounts, or pay the whole invoice in either USD or CNY using the invoice-date exchange rate shown above. 付款方式: 可按币种分别支付至对应账户,也可按上方出单日汇率整张折美金或人民币全额支付。<br>
      3. LIABILITY: All business is transacted under our Standard Trading Conditions.`}
    </div>
    ${!isQuote?`<div class="box-bk">
      <div class="title">BANKING INFORMATION (银行信息)</div>
      Bank Name: <strong>BANK OF CHINA XIAMEN BRANCH</strong><br>
      Account Name: <strong>SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.</strong><br>
      Swift Code: <strong>BKCHCNBJ73A</strong><br>
      Bank Addr: No. 40 North Hubin Road, Xiamen<br>
      USD Account (美金账号): <strong>433849630299</strong><br>
      CNY Account (人民币账号): <strong>433849860868</strong><br>
      <span style="color:#c00;font-size:8px">* Please check the account number carefully before remittance.</span>
    </div>`:""}
  </div>
</div>${ap}</body></html>`;
}
