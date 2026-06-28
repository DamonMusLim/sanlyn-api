// templates/po.js — 采购合同 PURCHASE ORDER
// ★ 锁版 v2.0 2026-06-18 — 灰底原版，禁止修改样式
// 以后要改必须: chattr -i po.js → 改 → chattr +i po.js → 报备 Damon
// 样式来源: documents.js.bak-20260617-114005 原始版
export function renderPO(d, h) {
  var prods = d.prods || [];
  var termsSections = [
    { heading:"一、交付与物流 / Delivery & Logistics", body:"乙方负责将货物运至甲方指定仓库，运费及风险由乙方承担。工厂自提时乙方须安全整装截至甲方车辆。" },
    { heading:"二、质量与验收 / Quality Control", body:"标准：封样+书面规格书+材质克重+跌落测试报告为准。7个工作日内抽检>=5%。任何不良：全批退换或按实际损失全额补偿，含海外客户索赔，不设1%豁免。出口后60天内因制造缺陷引发的海外索赔，乙方保留追偿责任。" },
    { heading:"三、付款条款 / Payment Terms", body:"30%定金：签约3个工作日内。40%验收款：验收合格7个工作日内。30%质保尾款：出口后60天无争议后付清。逾期按银行同期贷款利率计息。" },
    { heading:"四、合同效力与争议 / Validity & Disputes", body:"双方签字盖章后生效。争议：协商→CIETAC厦门仲裁→乙方所在地法院。甲方协商期间保留货物产权全权。由Sanlyn OS供应链系统生成，具有商业确认效力。" },
  ];
  return h.wrap("Purchase Order — " + d.noPO, `
    <style>
      .po-header{text-align:center;padding:10px 0 4px;}
      .po-header-cn{font-size:20px;font-weight:bold;letter-spacing:4px;display:block;}
      .po-header-en{font-size:12px;font-weight:600;color:#555;letter-spacing:2px;display:block;margin-top:2px;padding-bottom:10px;border-bottom:2px solid #222;}
      .po-parties{display:grid;grid-template-columns:1fr 1fr;border:1px solid #aaa;margin-top:0;}
      .po-party{padding:10px 14px;}
      .po-party+.po-party{border-left:1px solid #aaa;}
      .po-party-title{font-size:11px;font-weight:800;background:#f0f0f0;margin:-10px -14px 8px;padding:5px 14px;border-bottom:1px solid #ddd;letter-spacing:.03em;}
      .po-row{display:flex;font-size:11px;line-height:1.7;}
      .po-lbl{color:#555;width:72px;flex-shrink:0;}
      .po-val{font-weight:600;color:#111;}
      .po-ref{border:1px solid #aaa;border-top:none;background:#fafafa;font-size:11px;}
      .po-ref-row{display:flex;gap:40px;padding:9px 16px;}
      .po-ref-row+.po-ref-row{border-top:1px solid #e5e5e5;}
      .po-ref span{color:#333;white-space:nowrap;}
      .po-ref strong{color:#111;}
      .po-ref .fill-blank{display:inline-block;min-width:130px;border-bottom:1px solid #999;color:#aaa;font-style:italic;font-size:10px;}
      @page{size:A4;margin:18mm 16mm;}
      .sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:14px;}
      .sig-box{border-top:1px solid #ccc;padding:12px 14px 40px;font-size:11px;color:#333;position:relative;min-height:70px;}.seal-img{position:absolute;right:16px;top:-40px;width:90px;height:90px;object-fit:contain;opacity:0.88;pointer-events:none;}
    </style>
    <div class="po-header">
      <span class="po-header-cn">采购合同</span>
      <span class="po-header-en">PURCHASE ORDER</span>
    </div>
    <div class="po-parties">
      <div class="po-party">
        <div class="po-party-title">买方开票资料 · Buyer</div>
        <div class="po-row"><span class="po-lbl">公司名称：</span><span class="po-val">${h.esc(d.buyerCN)}</span></div>
        <div class="po-row"><span class="po-lbl">税号：</span><span class="po-val">${h.esc(d.buyerTaxNo)||"—"}</span></div>
        <div class="po-row"><span class="po-lbl">开户银行：</span><span class="po-val">${h.esc(d.buyerBank)||"—"}</span></div>
        <div class="po-row"><span class="po-lbl">银行账户：</span><span class="po-val">${h.esc(d.buyerAccount)||"—"}</span></div>
      </div>
      <div class="po-party">
        <div class="po-party-title">卖方账户信息 · Vendor</div>
        <div class="po-row"><span class="po-lbl">公司名称：</span><span class="po-val">${h.esc(d.vendorCN)}</span></div>
        <div class="po-row"><span class="po-lbl">税号：</span><span class="po-val">${h.esc(d.vendorTaxNo)||"—"}</span></div>
        <div class="po-row"><span class="po-lbl">开户银行：</span><span class="po-val">${h.esc(d.vendorBank)||"—"}</span></div>
        <div class="po-row"><span class="po-lbl">银行账户：</span><span class="po-val">${h.esc(d.vendorAccount)||"—"}</span></div>
      </div>
    </div>
    <div class="po-ref">
      <div class="po-ref-row">
        <span>单号 / Order No.: <strong>${h.esc(d.noPO)}</strong></span>
        <span>合同号 / Contract No.: <strong>${h.esc(d.cno||d.noPO)}</strong></span>
        <span>下单日期 / Order Date: <strong>${h.esc(h.fmtD(d.orderDate)||"—")}</strong></span>
      </div>
      <div class="po-ref-row">
        <span>期望交货日期 / Requested Delivery Date: <strong>${h.esc(d.deliveryDate||"")}</strong><span class="fill-blank" style="${d.deliveryDate?'display:none':''}">______________</span></span>
        <span>预计交货日期 / Estimated Delivery Date: <span class="fill-blank">（乙方填写 · Vendor to complete）</span></span>
      </div>
    </div>
    <table>
      <thead><tr>
        <th style="width:36px">行号<br>NO.</th>
        <th>品名 / ITEM DESCRIPTION</th>
        <th style="width:70px;text-align:center">数量 / QTY</th>
        <th style="width:72px;text-align:right">单价(袋)<br>PER BAG</th>
        <th style="width:72px;text-align:right">箱价<br>CTN PRICE</th>
        <th style="width:90px;text-align:right">金额 / AMOUNT</th>
        <th style="width:110px;text-align:center">条形码 / BARCODE</th>
      </tr></thead>
      <tbody>
        ${prods.length===0
          ? `<tr><td>01</td><td colspan="5" style="color:#999;font-style:italic">— 产品明细将自动填入 —</td></tr>`
          : (function(){var _rows=[];var _idx=0;var _lastLbl=null;prods.forEach(function(p){if(p._label&&p._label!==_lastLbl){_rows.push(`<tr style="background:#eff6ff"><td colspan="7" style="font-weight:700;color:#1d4ed8;font-size:11px;padding:5px 12px;border-top:2px solid #bfdbfe">${h.esc(p._label)}</td></tr>`);_lastLbl=p._label;}var fp=h.pick(p.factoryPrice,p.factory_price,p.unitPrice,p.price);var sub=Number(p.factory_subtotal||0);if(!sub&&p.qty&&fp)sub=Number(p.qty)*Number(fp);var iq=Number(p.inner_qty||p.innerQty||1);var bagP=iq>1?Number(fp)/iq:null;var fullName=h.pick(p.productName,p.name,"-");_idx++;_rows.push(`<tr><td style="text-align:center">${String(_idx).padStart(2,"0")}</td><td>${h.esc(fullName)}</td><td style="text-align:center">${h.esc(String(p.qty||"-"))}</td><td class="text-right">${bagP!==null?h.fmtM(bagP):"—"}</td><td class="text-right">${h.fmtM(fp)}</td><td class="text-right">${h.fmtM(sub)}</td><td style="text-align:center;font-size:10px;color:#444;letter-spacing:0.5px">${h.esc(p.barcode||p.code||"")}</td></tr>`);});return _rows.join("");})()}
        <tr class="total-row"><td colspan="2" style="text-align:right;font-size:11px;color:#555">合计 / TOTAL AMOUNT:</td><td style="text-align:center">${h.fmtM(d.tqty,0)}</td><td></td><td></td><td class="text-right" style="font-size:14px;font-weight:900">${h.fmtM(d.totPO)}</td><td></td></tr>
      </tbody>
    </table>
    <div style="margin-top:10px;font-size:10.5px;line-height:1.65;color:#333;border:1px solid #ddd;padding:8px 14px;border-radius:4px;">
      <strong style="font-size:11px">备注：</strong>
      ${termsSections.map(function(t){return`<div style="margin-top:6px"><strong>${h.esc(t.heading)}</strong><div style="color:#444;margin-top:1px">${h.esc(t.body)}</div></div>`;}).join("")}
    </div>
    ${d.factoryNotes?`<div style="margin-top:10px;font-size:10px;line-height:1.7;color:#333;border:1px solid #f5c518;padding:8px 14px;border-radius:4px;background:#fffdf0;"><strong style="font-size:11px;color:#b8860b;">⚠ 产品特殊要求 / Special Production Requirements：</strong><div style="white-space:pre-wrap;margin-top:4px">${h.esc(d.factoryNotes)}</div></div>`:""}    
    <div class="sig-grid">
      <div class="sig-box"><span>买方代表：</span><span style="font-weight:normal;font-size:9px;margin-left:4px">（签字 / 盖章）</span></div>
      <div class="sig-box" style="position:relative">${d._seal?"<img class=\"seal-img\" src=\"" + h.esc(d._seal) + "\" alt=\"seal\"/>":""}  <span>卖方代表：</span><span style="font-weight:normal;font-size:9px;margin-left:4px">（签字 / 盖章）</span></div>
    </div>

  `, d.ap);
}
