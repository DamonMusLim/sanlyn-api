// Deterministic document validation scaffold.
// Deep validation (customs-draft-verify and other skills) should run after
// these fail-closed checks in the orchestration layer.

var CUSTOMER_DOC_TYPES = { pi:1, sc:1, iv:1, pl:1 };
var FACTORY_BOUND_DOC_TYPES = { po:1, pi:1 };
var NO_MERGE_TYPES = { po:1, pi:1 };
var PURCHASE_PRICE_KEYS = { cost:1, purchase_price:1, purchasePrice:1, factory_price:1, factoryPrice:1, subtotalFactory:1, factory_subtotal:1 };
var CUSTOMER_PRICE_KEYS = { unitPrice:1, unit_price:1, price:1, customer_price:1, customerPrice:1, salePrice:1, subtotal:1, amount:1 };

function pick(){
  for(var i=0;i<arguments.length;i++){
    if(arguments[i]!==null&&arguments[i]!==undefined&&arguments[i]!=="") return arguments[i];
  }
  return "";
}

function norm(v){
  return String(v||"").trim().replace(/\s+/g," ").toUpperCase();
}

function rawOf(order){
  var raw=(order&&order.raw)||{};
  if(typeof raw==="string") try{raw=JSON.parse(raw);}catch(e){raw={};}
  return raw||{};
}

function add(checks, code, severity, message){
  checks.push({code:code,severity:severity,message:message});
}

// 一条定性: incoterm 决定海运费谁付。EXW/FOB/FCA/FAS=买方付; CFR/CNF/CIF/CPT/CIP/DAP/DPU/DDP=卖方付(含货价)。
function oceanFreightPayer(incoterm){
  var t=String(incoterm||"").toUpperCase().trim();
  if(["EXW","FOB","FCA","FAS"].indexOf(t)>=0) return "buyer";
  if(["CFR","CNF","CIF","CPT","CIP","DAP","DPU","DDP","DDU"].indexOf(t)>=0) return "seller";
  return "";
}
var FREIGHT_DOC_TYPES={debit:1,freight_invoice:1,freight_debit_note:1};
function validateFreightPayer(type, order, checks){
  if(!FREIGHT_DOC_TYPES[type]) return;
  var raw=rawOf(order);
  var incoterm=pick(order.incoterm, order.trade_terms, order.tradeTerms, raw.incoterm, raw.tradeTerms, order.freight_term);
  if(!incoterm){ add(checks,"FREIGHT_TERM_MISSING","warn","运费单据缺 incoterm，无法判定运费承担方"); return; }
  if(oceanFreightPayer(incoterm)==="seller"){
    add(checks,"FREIGHT_PAYER_MISMATCH","high","贸易条款 "+String(incoterm).toUpperCase()+" 为卖方承担运费(含货价)，不应单独向客户开运费发票");
  }
  // 买方付(EXW/FOB)+代运 的运费发票必须含港杂费;全0=可能漏录(只在像 shipping_plan 的对象上查,防误判)
  if(oceanFreightPayer(incoterm)==="buyer" && String(order.freight_model||raw.freight_model||"")==="sanlyn_arranged"){
    var _lc=[order.thc_fee,order.eir_fee,order.seal_fee,order.bkg_fee,order.doc_fee,order.tlx_fee,order.port_surcharge_total];
    if(!_lc.some(function(v){return Number(v||0)>0;})){
      add(checks,"FREIGHT_LOCALCHARGE_MISSING","warn",String(incoterm).toUpperCase()+"(买方付/代运)运费发票未录港杂费，可能不完整，待核");
    }
  }
}

function factoryKey(p){
  return pick(
    p.factory_company_id, p.factoryCompanyId,
    p.vendor_id, p.vendorId,
    p.factory_code, p.factoryCode,
    p.vendor_code, p.vendorCode,
    p.factory_name, p.factoryName, p.factory,
    p.vendor_name, p.vendorName, p.vendor,
    p.supplier_name, p.supplierName, p.supplier
  );
}

function hasAny(obj, keys){
  for(var k in keys){
    if(obj && obj[k]!==null && obj[k]!==undefined && obj[k]!=="") return true;
  }
  return false;
}

function validateCrossFactory(type, prods, checks){
  if(!FACTORY_BOUND_DOC_TYPES[type]) return;
  var seen={};
  (prods||[]).forEach(function(p){
    var k=String(factoryKey(p)||"").trim();
    if(k) seen[k]=1;
  });
  var keys=Object.keys(seen);
  if(keys.length>1){
    add(checks,"PO_CROSS_FACTORY","critical","PO/PI 行项目跨工厂，已阻断："+keys.join(", "));
  }
}

function validateMerge(type, order, prods, checks){
  if(!NO_MERGE_TYPES[type]) return;
  var raw=rawOf(order);
  var merged=pick(order&&order.ids, order&&order.merged_ids, order&&order.merged_order_ids, raw.ids, raw.merged_ids, raw.merged_order_ids);
  var groups={};
  (prods||[]).forEach(function(p){
    var g=pick(p._groupKey,p.order_no,p.contract_no,p.customer_po);
    if(g) groups[g]=1;
  });
  if((Array.isArray(merged)&&merged.length>1) || (typeof merged==="string"&&merged.split(",").filter(Boolean).length>1) || Object.keys(groups).length>1){
    add(checks,"MERGE_NOT_ALLOWED","critical","PI/PO 不允许出现多订单合并痕迹");
  }
}

function validateCurrency(type, order, checks){
  var raw=rawOf(order);
  var docCurrency=pick(order&&order.document_currency, order&&order.doc_currency, raw.documentCurrency, raw.docCurrency, raw.currency);
  var orderCurrency=pick(order&&order.currency, raw.orderCurrency);
  if(!orderCurrency || !docCurrency){
    add(checks,"CURRENCY_MISMATCH","high","单据币种或订单币种缺失");
    return;
  }
  if(norm(docCurrency)!==norm(orderCurrency)){
    add(checks,"CURRENCY_MISMATCH","high","单据币种与订单币种不一致："+docCurrency+" / "+orderCurrency);
  }
}

function validateHeader(order, checks){
  var raw=rawOf(order);
  var buyerDoc=pick(raw.buyer, raw.buyerName, raw.customer, raw.customer_name, raw.company_name);
  var buyerDb=pick(order&&order.customer, order&&order.customer_name, order&&order.company_name_en, order&&order.company_name_cn);
  var vendorDoc=pick(raw.vendor, raw.vendorName, raw.factory, raw.factoryName, raw.supplier);
  var vendorDb=pick(order&&order.vendor, order&&order.vendor_name, order&&order.factory, order&&order.factory_name);
  if(buyerDoc && buyerDb && norm(buyerDoc)!==norm(buyerDb)){
    add(checks,"HEADER_MISMATCH","high","买方抬头与订单真值不一致");
  }
  if(vendorDoc && vendorDb && norm(vendorDoc)!==norm(vendorDb)){
    add(checks,"HEADER_MISMATCH","high","vendor 抬头与订单真值不一致");
  }
}

function validateAmountDirection(type, prods, checks){
  if(!CUSTOMER_DOC_TYPES[type]) return;
  (prods||[]).forEach(function(p,i){
    if(hasAny(p,PURCHASE_PRICE_KEYS) && !hasAny(p,CUSTOMER_PRICE_KEYS)){
      add(checks,"AMOUNT_DIRECTION","high","客户单据第 "+(i+1)+" 行使用采购侧价格字段");
    }
  });
}

function validateRequired(type, order, prods, checks){
  var raw=rawOf(order);
  var missing=[];
  if(!pick(order&&order.contract_no, order&&order.order_no, raw.contractNo, raw.orderNo)) missing.push("contract_no/order_no");
  if(CUSTOMER_DOC_TYPES[type] && !pick(order&&order.customer, order&&order.customer_name, raw.customer, raw.buyer)) missing.push("buyer");
  if(!pick(order&&order.currency, raw.currency)) missing.push("currency");
  if(!prods || !prods.length) missing.push("line_items");
  if(missing.length) add(checks,"MISSING_REQUIRED","warn","必填字段缺失："+missing.join(", "));
}

export function validateDocument(pool, opts){
  opts=opts||{};
  var type=String(opts.type||"").toLowerCase();
  var order=opts.order||{};
  var prods=Array.isArray(opts.prods)?opts.prods:[];
  var checks=[];

  validateCrossFactory(type, prods, checks);
  validateMerge(type, order, prods, checks);
  validateCurrency(type, order, checks);
  validateHeader(order, checks);
  validateAmountDirection(type, prods, checks);
  validateRequired(type, order, prods, checks);
  validateFreightPayer(type, order, checks);

  var hasFail=checks.some(function(c){return c.severity==="critical"||c.severity==="high";});
  var hasWarn=checks.some(function(c){return c.severity==="warn";});
  return {status:hasFail?"fail":(hasWarn?"warn":"pass"),checks:checks};
}

export default validateDocument;
