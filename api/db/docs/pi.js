export async function renderPi(ctx){
  let { pool, raw, order, ordNo, cno, curr, cfg, cust, caddr, ctel, date, pol, pod, inco, prods, tot, html, _xlsCapture, totRow, audience, ap, esc, pick, fmtM, wrap, docHdr, buyerBlock, productRows, termsCard, bankCard, sigBlock, loadDocColConfig, buildColsFromConfig, resolveUnitPrice, mkTotRow } = ctx;
  function firstCompanyText(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(firstCompanyText).filter(Boolean).join("\n");
    if (typeof v === "object") return v.en || v.full_en || v.full || v.cn || v.address || v.text || v.value || Object.keys(v).map(function(k) { return firstCompanyText(v[k]); }).filter(Boolean)[0] || "";
    return String(v || "");
  }
  var customerCompanyId = parseInt((order&&order.customer_company_id)||raw.customer_company_id||0, 10);
  if (customerCompanyId > 0) {
    try {
      var _cr = await pool.query("SELECT name_cn, name_en, address, contact_phone FROM companies WHERE id=$1 LIMIT 1", [customerCompanyId]);
      if (_cr.rows.length) {
        var _co = _cr.rows[0];
        cust = _co.name_en || _co.name_cn || cust;
        caddr = firstCompanyText(_co.address) || caddr;
        ctel = _co.contact_phone || ctel;
      }
    } catch(e) {}
  }

        var noPI=cno.replace(/[^A-Z0-9-]/gi,"").slice(0,20);
        var _piNameFn=function(p){
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productNameEN, p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          };
        var _piFnMap={
          sku:{fn:function(p){return p.sku||p.code||p.item_code||p.product_code||"-";},defaultAlign:"center",defaultWidth:"70px"},
          name:{fn:_piNameFn,defaultAlign:""},
          qty:{defaultAlign:"center",defaultWidth:"70px"},
          unit:{fn:function(p){return p.unit||p.unitOfMeasure||"CTN";},defaultAlign:"center",defaultWidth:"50px"},
          price:{fn:function(p){return fmtM(resolveUnitPrice(p));},defaultAlign:"right",defaultWidth:"95px"},
          amt:{fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},defaultAlign:"right",defaultWidth:"110px"},
        };
        var _fbColsPI=[
          {k:"name",al:"",fn:_piNameFn,lbl:"Description &amp; Size"},
          {k:"qty",al:"center",w:"70px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:_piFnMap.price.fn,lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"110px",fn:_piFnMap.amt.fn,lbl:"Amount ("+curr+")"},
        ];
        var colsPI=buildColsFromConfig(await loadDocColConfig(pool,"pi"),_piFnMap,_fbColsPI);
        totRow=mkTotRow(colsPI.length+1);
        var _fsNoPI = (raw.fs_no || raw.internal_no || (ordNo||noPI)) + "-PI";
        html=wrap((ordNo||noPI)+"_PI",`
          ${docHdr(cfg,"形式发票","PROFORMA INVOICE")}
          ${buyerBlock(cust,caddr,ctel,noPI,"PI No.",ordNo,date,curr)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsPI.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsPI,curr)}${totRow}</tbody></table>
          <div class="footer-block"><div class="details-grid">${termsCard(cfg.terms.sc)}${bankCard(cfg.bank,curr)}</div>${sigBlock()}</div>`,ap,{docNo:_fsNoPI,date:date});
        _xlsCapture={sheetName:"Proforma Invoice",docNo:(ordNo||noPI)+"_PI",buyer:cust,date:date,cno:cno,curr:curr,pol:pol,pod:pod,incoterm:inco,poNo:ordNo,seller:{nameEN:cfg.nameEN,address:cfg.address,tel:cfg.tel,email:cfg.email},terms:cfg.terms.iv,bank:cfg.bank,
          headers:["NO.","Description & Size","QTY","Unit Price ("+curr+")","Amount ("+curr+")"],
          colKeys:[
            {k:"name",fn:function(p){
            // Audience-aware product name (2026-05-18):
            //   customs → bl_description / declarationName / hsName (short, HS-friendly)
            //   customer → productName / name (full marketing name with brand+flavor+spec)
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          }},
            {k:"qty"},
            {k:"price",fn:function(p){return parseFloat(String(fmtM(resolveUnitPrice(p))).replace(/,/g,""))||0;}},
            {k:"amt",fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return parseFloat(String(fmtM(s)).replace(/,/g,""))||0;}}
          ],
          rows:prods,totals:["","TOTAL","","",parseFloat(String(fmtM(tot)).replace(/,/g,""))||0]};
      
  return { html, _xlsCapture, totRow };
}
