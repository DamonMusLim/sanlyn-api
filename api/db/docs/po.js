export async function renderPo(ctx){
  let { pool, o, raw, prods, tqty, cfg, ordNo, cno, id, html, _xlsCapture, totRow, ap, esc, pick, fmtM, fmtD, wrap } = ctx;

        var noPO=pick(o.order_no,o.contract_no,id);
        // ── Factory resolution ─────────────────────────────────────────────────
        // raw.factory is often populated with the ISSUING company (BABI/PetBaby),
        // NOT the actual manufacturing factory. Filter those out, then resolve via:
        //   1) order_no encoded factory code (format: {cust}-{FACTORY_CODE}-{seq})
        //   2) orders.factory_code / raw.factory_code / raw.factoryCode
        //   3) products[].factory_code derived from order's SKUs
        //   4) raw.factory / raw.factoryName (if not self-referential)
        var SELLER_KWORDS=["PET BABY","OCEANBABY","OCEAN BABY","BABI","SANLYN","巴匕","洋宝宝","宠宝"];
        var rawFacStr=pick(raw.factory,raw.factoryName,raw.supplier,"");
        var isSelf=SELLER_KWORDS.some(function(k){return rawFacStr.toUpperCase().includes(k.toUpperCase());});
        if(isSelf) rawFacStr="";

        // Step 1: extract factory po_prefix from order_no (e.g. "48-LL-1" → "LL")
        var orderNoParts=(o.order_no||"").split("-");
        var orderNoFac=orderNoParts.length>=3 ? orderNoParts[1] : "";

        // Step 2: explicit factory_code fields
        var fcode=o.factory_code||raw.factory_code||raw.factoryCode||"";

        // Step 3: if still no code, derive from products SKUs
        if(!fcode && !orderNoFac && prods.length){
          try{
            var skus=prods.map(function(p){return p.sku||p.barcode||"";}).filter(Boolean);
            if(skus.length){
              var pfR=await pool.query("SELECT factory_code FROM products WHERE sku=ANY($1) AND factory_code IS NOT NULL LIMIT 1",[skus]);
              if(pfR.rows.length) fcode=pfR.rows[0].factory_code||"";
            }
          }catch(e){}
        }

        var factory=rawFacStr||"[FACTORY]";
        var buyerTaxNo=pick(cfg.taxNo,raw.sellerTaxNo,"");
        var vendorTaxNo=pick(raw.factoryTaxNo,raw.vendorTaxNo,"");
        var vendorAddress="", vendorBank="", vendorAccount="";
        try{
          // Try lookup by po_prefix (from order_no) first — most reliable
          var fR=null;
          if(orderNoFac){
            fR=await pool.query("SELECT * FROM factories WHERE po_prefix=$1 LIMIT 1",[orderNoFac]);
          }
          // Try by factory_code (matches factories.company_code or po_prefix)
          if((!fR||!fR.rows.length) && fcode){
            fR=await pool.query("SELECT * FROM factories WHERE company_code=$1 OR po_prefix=$1 LIMIT 1",[fcode]);
          }
          // Fallback: name search on whatever string we have
          if(!fR||!fR.rows.length){
            var fSearch=(factory!=="[FACTORY]")?factory.replace(/股份|有限公司|进出口/g,"").trim().slice(0,6):"";
            if(fSearch) fR=await pool.query("SELECT * FROM factories WHERE name=$1 OR name LIKE $2 LIMIT 1",[factory,'%'+fSearch+'%']);
          }
          if(fR && fR.rows.length){
            var fd=fR.rows[0];
            factory=fd.name||factory;           // always use the real factory name from DB
            vendorTaxNo=vendorTaxNo||fd.tax_no||"";
            vendorAddress=fd.address||"";
            vendorBank=fd.bank_name||"";
            vendorAccount=fd.bank_account||"";
          }
        }catch(e){}
        var totPO=prods.reduce(function(s,p){var fp=pick(p.factoryPrice,p.unitPrice,p.price);var sub=Number(p.subtotalFactory||p.subtotal||0);if(!sub&&p.qty&&fp)sub=Number(p.qty)*Number(fp);return s+sub;},0)||Number(o.total_amount)||0;
        // buyer RMB account: prefer seller_profiles.rmb_account
        var buyerRmbAccount=pick(cfg.bank.rmbAccount,"");
        var buyerBankName=pick(cfg.bank.bankNameCN,cfg.bank.bankName,"");
        // delivery date: read from orders.delivery_date, NOT today
        // If unset → show blank underline so factory can fill by hand
        var _poDelRaw=pick(o.delivery_date,raw.deliveryDate,raw.expectedDelivery,"");
        var poDeliveryDate=_poDelRaw ? fmtD(_poDelRaw) : "______________";
        // order date: orders.order_date (the date the PO was placed), fallback created_at
        var _poOrderDateRaw=pick(o.order_date,"");
        var poOrderDate=_poOrderDateRaw ? fmtD(_poOrderDateRaw) : fmtD(o.created_at||"");
        // buyer seal: seller_profiles.seal_url — auto-stamped for configured groups
        var poBuyerSeal=pick(cfg.seal_url,"");
        html=wrap("Purchase Order — "+noPO,`
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
            .sig-box{border-top:1px solid #ccc;padding:12px 14px 80px;font-size:11px;color:#333;position:relative;min-height:110px;}
            .sig-seal{position:absolute;right:16px;bottom:8px;width:110px;height:110px;opacity:0.88;}
          </style>
          <div class="po-header">
            <span class="po-header-cn">采购合同</span>
            <span class="po-header-en">PURCHASE ORDER</span>
          </div>
          <div class="po-parties">
            <div class="po-party">
              <div class="po-party-title">买方开票资料 · Buyer</div>
              <div class="po-row"><span class="po-lbl">公司名称：</span><span class="po-val">${esc(cfg.nameCN)}</span></div>
              <div class="po-row"><span class="po-lbl">税号：</span><span class="po-val">${esc(buyerTaxNo)}</span></div>
              <div class="po-row"><span class="po-lbl">开户银行：</span><span class="po-val">${esc(buyerBankName)}</span></div>
              <div class="po-row"><span class="po-lbl">银行账户：</span><span class="po-val">${esc(buyerRmbAccount)}</span></div>
            </div>
            <div class="po-party">
              <div class="po-party-title">卖方账户信息 · Vendor</div>
              <div class="po-row"><span class="po-lbl">公司名称：</span><span class="po-val">${esc(factory)}</span></div>
              <div class="po-row"><span class="po-lbl">税号：</span><span class="po-val">${esc(vendorTaxNo)}</span></div>
              <div class="po-row"><span class="po-lbl">开户银行：</span><span class="po-val">${esc(vendorBank||raw.factoryBank||"")}</span></div>
              <div class="po-row"><span class="po-lbl">银行账户：</span><span class="po-val">${esc(vendorAccount||raw.factoryAccount||"")}</span></div>
            </div>
          </div>
          <div class="po-ref">
            <div class="po-ref-row">
              <span>单号 / Order No.: <strong>${esc(ordNo)}</strong></span>
              <span>合同号 / Contract No.: <strong>${esc(cno)}</strong></span>
              <span>下单日期 / Order Date: <strong>${poOrderDate}</strong></span>
            </div>
            <div class="po-ref-row">
              <span>期望交货日期 / Requested Delivery Date: <strong>${poDeliveryDate}</strong></span>
              <span>预计交货日期 / Estimated Delivery Date: <span class="fill-blank">（乙方填写 · Vendor to complete）</span></span>
            </div>
          </div>
          <table><thead><tr><th style="width:36px">行号</th><th>品名 / Item Description</th><th style="width:70px;text-align:center">数量 / Qty</th><th style="width:90px;text-align:right">单价 / Unit Price</th><th style="width:100px;text-align:right">金额 / Amount</th><th style="width:110px;text-align:center">条形码 / Barcode</th></tr></thead>
          <tbody>
            ${prods.length===0?`<tr><td>01</td><td colspan="5" style="color:#999;font-style:italic">— 产品明细将自动填入 —</td></tr>`:
              prods.map(function(p,i){
                var fp=pick(p.factoryPrice,p.unitPrice,p.price);
                var sub=Number(p.subtotalFactory||p.subtotal||0);if(!sub&&p.qty&&fp)sub=Number(p.qty)*Number(fp);
                var fullName=pick(p.productName,p.name,"-");
                return`<tr><td>${String(i+1).padStart(2,"0")}</td><td>${esc(fullName)}</td><td style="text-align:center">${esc(String(p.qty||"-"))}</td><td class="text-right">${fmtM(fp)}</td><td class="text-right">${fmtM(sub)}</td><td style="text-align:center;font-size:10px;color:#444;letter-spacing:0.5px">${esc(p.barcode||"")}</td></tr>`;
              }).join("")}
            <tr class="total-row"><td colspan="2" class="text-right" style="color:#555;font-size:11px">合计</td><td style="text-align:center">${fmtM(tqty,0)}</td><td></td><td class="text-right" style="font-size:14px">${fmtM(totPO)}</td><td></td></tr>
          </tbody></table>
          <div style="margin-top:10px;font-size:10.5px;line-height:1.65;color:#333;border:1px solid #ddd;padding:8px 14px;border-radius:4px;">
            <strong style="font-size:11px">备注：</strong>
            ${(cfg.termsPO||[]).map(function(t){var cnBody=(t.body||"").split("\n")[0];return`<div style="margin-top:6px"><strong>${esc(t.heading||"")}</strong><div style="color:#444;margin-top:1px">${esc(cnBody)}</div></div>`;}).join("")}
          </div>
          <div class="sig-grid">
            <div class="sig-box">
              <span>买方代表：</span><span style="font-weight:normal;font-size:9px;margin-left:4px">（签字 / 盖章）</span>
              ${poBuyerSeal?`<img src="${esc(poBuyerSeal)}" class="sig-seal" alt="seal"/>`:``}
            </div>
            <div class="sig-box">
              <span>卖方代表：</span><span style="font-weight:normal;font-size:9px;margin-left:4px">（签字 / 盖章）</span>
            </div>
          </div>
        `,ap);
      
  return { html, _xlsCapture, totRow };
}
