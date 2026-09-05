(function(global){
"use strict";
function esc(value){
  return String(value==null?"":value).replace(/[&<>"']/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function blank(value){return value==null||String(value).trim()===""}
function fieldRate(row){
  if(!row||row.fill_rate==null)return "未接入";
  return Math.round(Number(row.fill_rate)*1000)/10+"%";
}
function missingText(row){
  if(!row)return "未接入 · 缺映射；当前填充率 未接入";
  return "未接入 · "+(row.reason||("缺字段 "+row.source_table+"."+row.source_column))+"；当前填充率 "+fieldRate(row);
}
function renderText(templateText, values, mappings){
  var byKey={};
  (mappings||[]).forEach(function(row){byKey[row.placeholder]=row});
  return String(templateText||"").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,function(_m,key){
    var value=values&&values[key];
    if(!blank(value))return esc(value);
    return '<span class="hgj-missing" title="'+esc(missingText(byKey[key]))+'">'+esc("未接入")+'</span>';
  });
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
global.HgjTemplateRenderer={esc:esc,fieldRate:fieldRate,missingText:missingText,renderText:renderText,groups:groups};
})(window);
