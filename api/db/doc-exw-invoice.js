// EXW 全费用账单(客户版) — type=exw_invoice
// EXW 客户付全部:一张含海运费(USD)+港杂/拖车等(CNY)的账单,TO=客户。
// 数据真源 = active_freight_supplier_bills 的 sale_amount(客户卖价,不按 payer 过滤);
// 无真实账单则显"待录入账单",绝不落费率卡估算(区别于 fob_portcharge 的兜底卡)。
// 版式复用 fob_portcharge 的洋宝宝 INVOICE + 集装箱明细;字段级 data-field/data-row 供前端绑定。
// 渲染逻辑独立于 shipping-plan-pdf.js(单文件≤500行铁律)。

function esc(s){ if(s===null||s===undefined)return""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmtNum(v){ var n=Number(v); if(!isFinite(n))return"0.00"; return n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtDate(v){ if(!v)return"—"; try{return new Date(v).toISOString().slice(0,10);}catch(e){return String(v);} }
function num(v){ var n=Number(v); return isFinite(n)?n:0; }

// 费目中英对照(仅展示美化,取不到时原样显示 cost_category)
const FEE_EN = {
  "海运费":"Ocean Freight","THC":"THC","码头操作费(THC)":"THC","单证费":"Documentation","电放费":"Telex Release",
  "订舱费":"Booking","封签费":"Seal","铅封费":"Seal","VGM":"VGM","设备交接费":"EIR","设备交接单费":"EIR",
  "港杂费":"Port Misc","场站费":"Yard","场站费用":"Yard","提箱费":"Container Pickup","操作费":"Operation",
  "报关费":"Customs Declaration","舱单费":"Manifest","包干费":"Lumpsum","拖车费":"Trucking","改单费":"Amendment",
  "燃油附加费":"Fuel Surcharge","码头信息服务费":"Terminal Info","EDI":"EDI","申报费":"Declaration","舱单信息费":"Manifest",
  "FE产地证代办费":"Form E Cert","fe_cert":"Form E Cert"
};

export async function renderExwInvoice(pool, p, orders, cust, query){
  query = query || {};
  const genDate = new Date().toISOString().slice(0,10);
  const blNo    = p.bl_no || p.shipment_no || String(p.id||"");
  const invNo   = "INV-" + (p.bl_no || p.shipment_no || String(p.id||"")).replace(/[^A-Z0-9]/gi,"").toUpperCase() + "-" + genDate.replace(/-/g,"");
  const vessel  = [p.vessel, p.voyage].filter(Boolean).join(" / ") || "—";
  const ctnType = p.container_type || "40HQ";
  const freightTerm = String(p.freight_term || "EXW").trim().toUpperCase() || "EXW";
  const ap = String(query.autoprint||"")==="1" ? "<scr"+"ipt>window.onload=function(){window.print()}</scr"+"ipt>" : "";

  // ── 收货人/客户(TO) ──
  const toName = p.customer_en || p.customer || p.customer_cn || (cust && (cust.name_en||cust.name_cn)) || "—";
  const toAddr = (cust && (cust.address||"")) || (p.raw && (p.raw.consigneeAddress||p.raw.customerAddress)) || "";

  // ── 集装箱明细(真源 containers_detail,已去壳的真柜)──
  let ctn = p.containers_detail;
  if(typeof ctn==="string"){ try{ ctn=JSON.parse(ctn); }catch(e){ ctn=[]; } }
  if(!Array.isArray(ctn)) ctn=[];
  const realCtn = ctn.filter(c=>c && (c.container_no||c.containerNo));
  const ctnList = realCtn.length ? realCtn : ctn; // 无真柜则原样(可能空)
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
      <td class="ctn-idx" data-field="container_idx">Container ${i+1}</td>
      <td class="ctn-no" data-field="container_no">${esc(no)}</td>
      <td class="ctn-seal" data-field="seal_no">${esc(seal)}</td>
      <td data-field="po">${esc(po)}</td>
      <td class="ctn-ctn" data-field="ctn">${ctns?ctns.toLocaleString('en'):'—'}</td>
      <td class="ctn-gw" data-field="gw">${gw?fmtNum(gw)+' KGS':'—'}</td>
      <td class="ctn-cbm" data-field="cbm">${cbm?cbm.toFixed(3)+' CBM':'—'}</td>
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
      [blNo, String(p.id)]
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
    const up=r.unit_price!=null?num(r.unit_price):(qty?amt/qty:amt);
    const basis=r.charge_basis||(qty>1?"每柜":"整票");
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
  const noBill  = feeRows.length===0;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>EXW Full-Charge Invoice — ${esc(p.shipment_no||blNo)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:11px;color:#111;background:#e5e7eb;padding:0}
.page{max-width:200mm;margin:14px auto;padding:11mm 13mm;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:14px}
.hdr-l .co-en{font-size:15px;font-weight:900;color:#111;line-height:1.2}
.hdr-l .co-cn{font-size:10px;color:#555;margin-top:3px}
.hdr-l .tag{font-size:8.5px;color:#888;margin-top:4px}
.hdr-r{text-align:right}
.hdr-r .doc-en{font-size:18px;font-weight:900;color:#111;letter-spacing:.05em}
.hdr-r .doc-cn{font-size:10px;color:#555;margin-top:1px}
.hdr-r .inv-no{display:inline-block;font-size:11px;font-weight:800;color:#111;font-family:monospace;border:2px solid #111;border-radius:3px;padding:2px 9px;margin-top:4px}
.info-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:0 12px;margin-bottom:12px;border:1px solid #e0e0e0;border-radius:4px;overflow:hidden}
.info-box{font-size:10px}
.info-box .row{display:grid;grid-template-columns:120px 1fr;border-bottom:1px solid #efefef;min-height:22px}
.info-box .row:last-child{border-bottom:none}
.info-box .lbl{background:#f7f7f7;color:#666;font-weight:700;padding:4px 8px;border-right:1px solid #efefef;display:flex;align-items:center}
.info-box .val{color:#111;font-weight:600;padding:4px 8px;display:flex;align-items:center}
.info-box .val.big{font-size:12px;font-weight:900}
table.charges{width:100%;border-collapse:collapse;font-size:10px;border:1px solid #ccc}
table.charges thead th{background:#111;color:#fff;padding:7px 9px;text-align:left;font-weight:700;font-size:9.5px}
table.charges thead th.r{text-align:right}
table.charges thead th.c{text-align:center}
table.charges tr.section td{background:#333;color:#fff;font-weight:800;font-size:9.5px;text-transform:uppercase;padding:5px 9px}
table.charges tbody td{padding:7px 9px;border-bottom:1px solid #efefef;font-family:monospace;color:#111}
table.charges tbody td.label{font-family:inherit;color:#222}
table.charges tbody td.r{text-align:right}
table.charges tbody td.c{text-align:center}
table.charges tfoot tr td{padding:7px 9px;font-weight:800;font-family:monospace;color:#111;background:#f7f7f7;border-top:2px solid #111}
table.charges tfoot tr td.label{font-family:inherit;text-align:right;font-size:10px}
table.charges tfoot tr td:last-child{text-align:right}
.pay-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0 14px}
.pay-box{padding:12px 14px;border-radius:4px;border:2px solid #111}
.pay-box.usd{background:#f7f7f7}.pay-box.cny{background:#efefef}
.pay-box .plbl{font-size:8.5px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;color:#111;margin-bottom:5px}
.pay-box .pamt{font-size:20px;font-weight:900;font-family:monospace;color:#111}
.pay-box .psub{font-size:8px;color:#666;margin-top:3px}
.bottom{display:grid;grid-template-columns:1.05fr 1fr;gap:10px}
.box-tt,.box-bk{padding:9px 11px;background:#f9f9f9;border:1px solid #ddd;border-radius:4px;font-size:9px;line-height:1.8;color:#444}
.box-tt strong,.box-bk strong{color:#111}
.box-tt .title,.box-bk .title{font-size:9.5px;font-weight:900;color:#111;margin-bottom:4px;text-transform:uppercase;border-bottom:1px solid #ddd;padding-bottom:3px}
tr.ctn-row td{padding:5px 10px;border-bottom:1px solid #efefef;color:#111;font-size:9.5px}
tr.ctn-row td.ctn-idx{color:#888;font-size:9px}
tr.ctn-row td.ctn-no{font-family:monospace;font-weight:800}
tr.ctn-row td.ctn-seal{font-family:monospace;color:#555}
@media print{body{padding:0;background:#fff}.page{margin:0;padding:8mm 10mm;box-shadow:none}}
@media screen{body{background:#f1f5f9}.page{box-shadow:0 4px 32px rgba(0,0,0,.12);margin:20px auto;border-radius:8px}}
</style></head><body>
<div class="page">
  <div class="hdr">
    <div class="hdr-l">
      <div class="co-en">SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.</div>
      <div class="co-cn">上海洋宝宝国际物流有限公司</div>
      <div class="tag">Ocean Freight · Air Freight · Express · Integrated Logistics Solutions</div>
    </div>
    <div class="hdr-r">
      <div class="doc-en">INVOICE</div>
      <div class="doc-cn">海运全费用账单</div>
      <div class="inv-no" data-field="invoice_no">No. ${esc(invNo)}</div>
    </div>
  </div>

  ${noBill?`<div style="background:#fff3cd;border:2px solid #c00;border-radius:4px;padding:8px 12px;margin-bottom:12px;font-size:11px;font-weight:800;color:#c00">
    ⚠️ 该票暂无已录入账单(freight_supplier_bills sale_amount),请先录入费用后再出单。<br>⚠️ No billed charges recorded for this shipment yet — enter charges before issuing.
  </div>`:""}

  <div class="info-grid">
    <div class="info-box">
      <div class="row"><div class="lbl">TO (客户名称):</div><div class="val big" data-field="to">${esc(toName)}</div></div>
      <div class="row"><div class="lbl">SHPT MODE:</div><div class="val">Sea Export</div></div>
      <div class="row"><div class="lbl">INV/BL NO.:</div><div class="val" data-field="bl_no">${esc(blNo)}</div></div>
      <div class="row"><div class="lbl">P.O.L (起运港):</div><div class="val" data-field="pol">${esc(p.pol||"—")}</div></div>
    </div>
    <div class="info-box">
      <div class="row"><div class="lbl">DATE (出单日期):</div><div class="val" data-field="date">${genDate}</div></div>
      <div class="row"><div class="lbl">Vessel/Voyage (船名航次):</div><div class="val" data-field="vessel">${esc(vessel)}</div></div>
      <div class="row"><div class="lbl">ETD (离港日):</div><div class="val" data-field="etd">${fmtDate(p.etd)}</div></div>
      <div class="row"><div class="lbl">P.O.D (目的港):</div><div class="val" data-field="pod">${esc(p.pod||"—")}</div></div>
    </div>
  </div>

  <div style="margin-bottom:12px;border:1px solid #ddd;border-radius:4px;overflow:hidden;font-size:10px">
    <div style="background:#111;color:#fff;font-weight:800;font-size:9.5px;padding:6px 10px;display:flex;justify-content:space-between;align-items:center">
      <span data-field="cntr_summary">Containers / 集装箱明细 (${actualCtnQty} × ${esc(ctnType)})</span>
      <span style="font-weight:700" data-field="freight_term">Freight Term: ${esc(freightTerm)}</span>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:#333;color:#fff;font-size:9px;font-weight:700">
        <th style="padding:5px 8px;text-align:left;width:70px">Container #</th>
        <th style="padding:5px 8px;text-align:left;width:120px">Container No.</th>
        <th style="padding:5px 8px;text-align:left;width:100px">Seal No.</th>
        <th style="padding:5px 8px;text-align:left;width:90px">PO / 合同号</th>
        <th style="padding:5px 8px;text-align:right;width:70px">CTN</th>
        <th style="padding:5px 8px;text-align:right;width:95px">Gross Weight</th>
        <th style="padding:5px 8px;text-align:right;width:75px">Volume</th>
      </tr></thead>
      <tbody>${ctnRows||`<tr><td colspan="7" style="padding:8px;text-align:center;color:#999">— 待绑定柜信息 —</td></tr>`}</tbody>
      <tfoot><tr style="background:#f7f7f7;font-weight:900;border-top:2px solid #111;font-size:9.5px">
        <td style="padding:6px 8px;color:#666;font-size:9px" data-field="cntr_total">${actualCtnQty} × ${esc(ctnType)}</td>
        <td style="padding:6px 8px" colspan="3"></td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace">${footCTN?footCTN.toLocaleString('en'):'—'}</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace">${footGW?fmtNum(footGW)+' KGS':'—'}</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace">${footCBM?footCBM.toFixed(3)+' CBM':'—'}</td>
      </tr></tfoot>
    </table>
  </div>

  <table class="charges">
    <thead><tr>
      <th>Charge Item (费用明细)</th><th>Charge Unit / 计费单位</th>
      <th class="c">Currency / 币种</th><th class="c">Qty / 数量</th>
      <th class="r">Price / 单价</th><th class="r">Amount / 合计</th>
    </tr></thead>
    <tbody>
      ${usdHtml?`<tr class="section"><td colspan="6">Ocean Freight | 海运费</td></tr>${usdHtml}`:""}
      ${cnyHtml?`<tr class="section"><td colspan="6">Local &amp; Other Charges | 港杂及其他</td></tr>${cnyHtml}`:""}
    </tbody>
    <tfoot>
      ${totUSD>0?`<tr><td class="label" colspan="5">SUBTOTAL USD (美金小计)</td><td data-field="subtotal_usd">USD ${fmtNum(totUSD)}</td></tr>`:""}
      ${totCNY>0?`<tr><td class="label" colspan="5">SUBTOTAL CNY (人民币小计)</td><td data-field="subtotal_cny">CNY ${fmtNum(totCNY)}</td></tr>`:""}
    </tfoot>
  </table>

  <div class="pay-grid">
    <div class="pay-box usd">
      <div class="plbl">TOTAL PAYABLE IN USD · 美金应付</div>
      <div class="pamt" data-field="pay_usd">$ ${fmtNum(totUSD)}</div>
      <div class="psub">Ocean freight · Remit to USD A/C below</div>
    </div>
    <div class="pay-box cny">
      <div class="plbl">TOTAL PAYABLE IN CNY · 人民币应付</div>
      <div class="pamt" data-field="pay_cny">¥ ${fmtNum(totCNY)}</div>
      <div class="psub">Local charges · Remit to CNY A/C below</div>
    </div>
  </div>

  <div class="bottom">
    <div class="box-tt">
      <div class="title">TERMS &amp; CONDITIONS (法律声明与条款)</div>
      1. PAYMENT DUE: Please arrange payment strictly within the agreed credit term. Late payment may delay release of the Bill of Lading or cargo.<br>
      2. CURRENCY: Ocean freight settled in USD; local charges settled in CNY, each remitted to the corresponding account.<br>
      3. LIABILITY: All business is transacted under our Standard Trading Conditions.
    </div>
    <div class="box-bk">
      <div class="title">BANKING INFORMATION (银行信息)</div>
      Bank Name: <strong>BANK OF CHINA XIAMEN BRANCH</strong><br>
      Account Name: <strong>SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.</strong><br>
      Swift Code: <strong>BKCHCNBJ73A</strong><br>
      Bank Addr: No. 40 North Hubin Road, Xiamen<br>
      USD Account (美金账号): <strong>433849630299</strong><br>
      CNY Account (人民币账号): <strong>433849860868</strong><br>
      <span style="color:#c00;font-size:8px">* Please check the account number carefully before remittance.</span>
    </div>
  </div>
</div>${ap}</body></html>`;
}
