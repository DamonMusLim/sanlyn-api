(function(global){
"use strict";
function esc(value){
  return String(value==null?"":value).replace(/[&<>"']/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function blank(value){return value==null||String(value).trim()===""}
function fieldRate(row){
  var n=Number(row&&row.fill_rate);
  if(!row||row.fill_rate==null||row.total_count==null||Number(row.total_count)===0||!Number.isFinite(n))return "未接入";
  return Math.round(n*1000)/10+"%";
}
function optsOf(opts){
  opts=opts||{};
  if(opts.tableHits)return opts;
  if(opts.table_hits)return {tableHits:opts.table_hits};
  return opts;
}
function hasSourceRow(row, opts){
  opts=optsOf(opts);
  return !row||!opts||!opts.tableHits||opts.tableHits[row.source_table]===true;
}
function lacksRecordKey(row, opts){
  opts=optsOf(opts);
  return !!row&&!!opts&&!!opts.tableHits&&opts.tableHits[row.source_table]==null;
}
function missingText(row, opts, key){
  if(!row)return "未接入 · 缺占位符 "+(key||"未知")+" 的映射字段；当前填充率 未接入";
  var source=row.source_table&&row.source_column?row.source_table+"."+row.source_column:"占位符 "+row.placeholder;
  if(row.state==="ready"&&lacksRecordKey(row,opts))return "未接入 · 缺 record_key 参数，无法匹配当前记录；当前填充率 "+fieldRate(row);
  if(row.state==="ready"&&!hasSourceRow(row,opts))return "未接入 · 缺当前记录 "+row.source_table+" 可匹配记录；当前填充率 "+fieldRate(row);
  if(row.state==="ready")return "未接入 · 缺当前记录 "+source+" 已填值；当前填充率 "+fieldRate(row);
  return "未接入 · "+(row.reason||("缺字段 "+source))+"；当前填充率 "+fieldRate(row);
}
function missingBrief(row, opts, key){
  if(!row)return "未接入(缺占位符 "+(key||"未知")+" 的映射字段；当前填充率 未接入)";
  var source=row.source_table&&row.source_column?row.source_table+"."+row.source_column:"占位符 "+row.placeholder;
  if(row.state==="ready"&&lacksRecordKey(row,opts))return "未接入(缺 record_key 参数，无法匹配当前记录；当前填充率 "+fieldRate(row)+")";
  if(row.state==="ready"&&!hasSourceRow(row,opts))return "未接入(缺当前记录 "+row.source_table+" 可匹配记录；当前填充率 "+fieldRate(row)+")";
  if(row.state==="ready")return "未接入(缺当前记录 "+source+" 已填值；当前填充率 "+fieldRate(row)+")";
  return "未接入("+(row.reason||("缺字段 "+source))+"；当前填充率 "+fieldRate(row)+")";
}
function isUnsetField(row){
  return !!row&&row.value_policy==="unset_when_blank";
}
function canShowUnset(row, opts){
  opts=optsOf(opts);
  return !!row&&isUnsetField(row)&&row.state==="ready"&&!!opts&&!!opts.tableHits&&opts.tableHits[row.source_table]===true;
}
function missingHtml(row, opts, key){
  return '<span class="hgj-missing" title="'+esc(missingText(row,opts,key))+'">'+esc(missingBrief(row,opts,key))+'</span>';
}
function appendBreaks(target, text){
  String(text==null?"":text).split("\n").forEach(function(part, idx){
    if(idx)target.appendChild(document.createElement("br"));
    target.appendChild(document.createTextNode(part));
  });
}
function appendMissing(target, row, opts, key){
  var span=document.createElement("span");
  span.className="hgj-missing";
  span.title=missingText(row,opts,key);
  span.textContent=missingBrief(row,opts,key);
  target.appendChild(span);
}
function valueText(row, value, opts){
  if(!blank(value))return String(value);
  if(canShowUnset(row,opts))return "未设置";
  return missingText(row,opts,row&&row.placeholder);
}
function renderText(templateText, values, mappings, opts){
  var source=String(templateText||""), byKey={}, re=/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, out="", last=0;
  (mappings||[]).forEach(function(row){byKey[row.placeholder]=row});
  source.replace(re,function(m,key,idx){
    var value=values&&values[key], row=byKey[key];
    out+=esc(source.slice(last,idx));
    last=idx+m.length;
    if(!blank(value)){out+=esc(value);return m}
    if(canShowUnset(row,opts)){out+=esc("未设置");return m}
    out+=missingHtml(row,opts,key);
    return m;
  });
  out+=esc(source.slice(last));
  return out;
}
function renderInto(target, templateText, values, mappings, opts){
  var source=String(templateText||""), byKey={}, re=/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, last=0;
  if(!target)return;
  target.textContent="";
  (mappings||[]).forEach(function(row){byKey[row.placeholder]=row});
  source.replace(re,function(m,key,idx){
    var value=values&&values[key], row=byKey[key];
    appendBreaks(target,source.slice(last,idx));
    last=idx+m.length;
    if(!blank(value)){appendBreaks(target,String(value));return m}
    if(canShowUnset(row,opts)){appendBreaks(target,"未设置");return m}
    appendMissing(target,row,opts,key);
    return m;
  });
  appendBreaks(target,source.slice(last));
}
function renderPlain(templateText, values, mappings, opts){
  var source=String(templateText||""), byKey={};
  (mappings||[]).forEach(function(row){byKey[row.placeholder]=row});
  return source.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,function(m,key){
    var value=values&&values[key], row=byKey[key];
    if(!blank(value))return String(value);
    if(canShowUnset(row,opts))return "未设置";
    return missingBrief(row,opts,key);
  });
}
function missingInText(templateText, values, mappings, opts){
  var byKey={}, seen={}, out=[];
  (mappings||[]).forEach(function(row){byKey[row.placeholder]=row});
  String(templateText||"").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,function(_m,key){
    var value=values&&values[key], row=byKey[key];
    if(!blank(value)||canShowUnset(row,opts)||seen[key])return _m;
    seen[key]=true;
    out.push({
      placeholder:key,
      source_table:row?row.source_table:"",
      source_column:row?row.source_column:"",
      reason:row?missingText(row,opts).replace(/^未接入 · /,"").replace(/；当前填充率 .*$/,""):"缺占位符 "+key+" 的映射字段",
      total_count:row?row.total_count:null,
      filled_count:row?row.filled_count:null,
      fill_rate:row?row.fill_rate:null
    });
    return _m;
  });
  return out;
}
function placeholders(templateText){
  var seen={}, out=[];
  String(templateText||"").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,function(_m,key){
    if(!seen[key]){seen[key]=true;out.push(key)}
    return _m;
  });
  return out;
}
function render(templateText, values, mappings, opts){
  return {
    html:renderText(templateText,values,mappings,opts),
    plain:renderPlain(templateText,values,mappings,opts),
    missing:missingInText(templateText,values,mappings,opts),
    placeholders:placeholders(templateText)
  };
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
global.HgjTemplateRenderer={esc:esc,fieldRate:fieldRate,canShowUnset:canShowUnset,missingText:missingText,missingBrief:missingBrief,valueText:valueText,render:render,renderText:renderText,renderInto:renderInto,renderPlain:renderPlain,missingInText:missingInText,placeholders:placeholders,groups:groups};
})(window);
