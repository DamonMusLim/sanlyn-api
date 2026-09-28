(function(global){
"use strict";
function esc(value){
  return String(value==null?"":value).replace(/[&<>"']/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function blank(value){return value==null||String(value).trim()===""}
var UNSET_VALUE_PLACEHOLDERS={
  declaration_amount:true,
  fee_amount:true,fee_exchange_rate:true,fee_tax_rate:true,fee_tax_amount:true,fee_total_price:true,
  bill_amount:true,invoice_bill_amount:true,invoice_amount:true,amount_ex_tax:true,invoice_tax_rate:true,invoice_total_tax:true,
  payment_amount:true,paid_amount:true,pending_amount:true,settlement_amount:true
};
function zeroLike(value){return /^[+-]?0+(\.0+)?$/.test(String(value==null?"":value).trim())}
function unsetValue(row,value){
  if(!row)return true;
  return blank(value)||!!(UNSET_VALUE_PLACEHOLDERS[row.placeholder]&&zeroLike(value));
}
function fieldRate(row){
  if(!row||row.fill_rate==null||Number(row.fill_rate)<=0)return "未接入";
  return Math.round(Number(row.fill_rate)*1000)/10+"%";
}
function reason(row,key){
  if(!row)return key?"缺占位符 {{"+key+"}} 的映射字段":"缺映射字段";
  if(row.state==="ready")return "缺当前记录 "+row.source_table+"."+row.source_column+" 值";
  return row.reason||("缺字段 "+row.source_table+"."+row.source_column);
}
function label(row){return row&&UNSET_VALUE_PLACEHOLDERS[row.placeholder]&&row.state!=="not_connected"?"未设置":"未接入"}
function missingText(row,key){
  if(!row)return "未接入 · "+reason(row,key)+"；当前填充率 未接入";
  return label(row)+" · "+reason(row,key)+"；当前填充率 "+fieldRate(row);
}
function missingBrief(row,key){
  if(!row)return "未接入("+reason(row,key)+"；当前填充率 未接入)";
  return label(row)+"("+reason(row,key)+"；当前填充率 "+fieldRate(row)+")";
}
function renderText(templateText, values, mappings){
  var byKey={};
  (mappings||[]).forEach(function(row){byKey[row.placeholder]=row});
  return esc(templateText||"").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,function(_m,key){
    var row=byKey[key];
    var value=values&&values[key];
    if(!unsetValue(row,value))return esc(value);
    return '<span class="hgj-missing" title="'+esc(missingText(row,key))+'">'+esc(missingBrief(row,key))+'</span>';
  });
}
function renderPlain(templateText, values, mappings){
  var byKey={};
  (mappings||[]).forEach(function(row){byKey[row.placeholder]=row});
  return String(templateText||"").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,function(_m,key){
    var row=byKey[key];
    var value=values&&values[key];
    if(!unsetValue(row,value))return String(value);
    return missingBrief(row,key);
  });
}
function missingInText(templateText, values, mappings){
  var byKey={}, seen={}, out=[];
  (mappings||[]).forEach(function(row){byKey[row.placeholder]=row});
  String(templateText||"").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,function(_m,key){
    var row=byKey[key];
    var value=values&&values[key];
    if(!unsetValue(row,value)||seen[key])return _m;
    seen[key]=true;
    out.push({placeholder:key,status:label(row),reason:reason(row,key),fill_rate:row?row.fill_rate:null});
    return _m;
  });
  return out;
}
function groups(mappings){
  var order=[], map={};
  (mappings||[]).forEach(function(row){
    var key=row.group||"other";
    if(!map[key]){map[key]=[];order.push(key)}
    map[key].push(row);
  });
  return order.map(function(key){return {key:key, rows:map[key]}});
}
global.HgjTemplateRenderer={esc:esc,isUnsetValue:unsetValue,fieldRate:fieldRate,missingText:missingText,missingBrief:missingBrief,renderText:renderText,renderPlain:renderPlain,missingInText:missingInText,groups:groups};
})(window);
