var tabLabels={ocean:"海运运价",charges:"港杂费",truck:"拖车报价",customs:"报关报价",insurance:"货运保险"};
var manualSteps={ocean:"运价维护",charges:"费用模板",truck:"报价核对",customs:"出运引用",insurance:"账单复核"};
var manualOrder=["ocean","charges","truck","customs","insurance"];
var manualPaths={ocean:"价格 / 运价管理 / 海运运价 / 运价维护",charges:"价格 / 运价管理 / 港杂费 / 费用模板",truck:"价格 / 运价管理 / 拖车报价 / 报价核对",customs:"价格 / 运价管理 / 报关报价 / 出运引用",insurance:"价格 / 运价管理 / 货运保险 / 账单复核"};
var manualLimits={ocean:"只读展示真实价表、出运票和账单；成本/客户价未设置就显示未设置。",charges:"只读展示官方港杂、货代套餐、本地费；金额未接入不兜底。",truck:"只读展示 service_rates 与旧表；轻重档和费率未设置不推算。",customs:"只读展示报关行报价；基础费、含品名数、超品名加收未设置不生成费用。",insurance:"只读核对保额、费率、保费和保单号；缺字段只显示未接入或未设置。"};
var manualFlows={ocean:["录入航线基础字段","维护箱型成本和客户价","按有效期筛选","引用出运票/账单核对"],charges:["维护官方费目","维护货代套餐","展开套餐明细","按港口/船司核对"],truck:["筛选工厂与港口","读取轻重档报价","核对有效期","旧表只读待并入"],customs:["选择口岸和报关行","读取计费规则","核对币种和备注","出运引用前人工确认"],insurance:["读取投保资料","核对费率和保额","检查保费/保单号","账单复核不自动写入"]};
var manualTargets={ocean:"维护航线、箱型价格、有效期，并对照出运票和账单只读核对。",charges:"维护港杂费目、货代套餐和本地费模板，金额缺失显示未设置。",truck:"维护工厂到港口拖车报价，轻重档、币种、单位来自 service_rates。",customs:"维护口岸报关报价规则，基础费和超品名加收必须来自真实字段。",insurance:"核对投保资料、保额、费率、保费和保单号，不写入账单事实。"};
var manualOwners={ocean:"货代价表 / 出运票 / 运费账单",charges:"官方港杂 / 货代套餐 / 本地费",truck:"service_rates / trucking_rates",customs:"customs_rates",insurance:"insurance_policies / shipping_plans"};
var manualOps={
  ocean:[["维护航线","POL / POD / 船公司 / 货代 / 有效期"],["维护箱型价","20GP / 40HQ 成本和客户价；未设置留空"],["核对引用","出运票与账单只读比对"]],
  charges:[["维护官方港杂","船司 / 港口 / 箱型 / 费目"],["维护套餐","货代实报套餐与明细展开"],["维护本地费","本地费真实字段，金额未设置不兜底"]],
  truck:[["筛选报价","工厂 / 港口 / 箱型 / 轻重档"],["核对费率","service_rates 当前报价"],["旧表待并入","旧 trucking_rates 只读展示"]],
  customs:[["维护口岸","报关行 / 口岸"],["维护计费规则","基础费 / 含品名数 / 超品名加收"],["出运引用","未设置费用不推算"]],
  insurance:[["核对投保资料","被保险人 / 投保人 / 发票金额"],["核对保额","保额按真实字段校验"],["账单复核","保费和保单号缺失显示未设置"]]
};
function renderDashboard(){
  var s=tabFieldStats(),keys=activeKeys(),warn=s.rows?businessWarnCount():"未接入";
  $("mRows").textContent=s.rows?String(s.rows):"未接入";
  $("mRowsBasis").textContent=s.rows?"真实记录":"缺 "+missingSummary(keys)+"；当前填充率 "+s.rate;
  $("mRate").textContent=s.rate;
  $("mRateBasis").textContent=s.missing?"缺 "+missingSummary(keys)+"；未接入项不可忽略":"按真实字段 coverage";
  $("mActive").textContent=s.rows?($("active").checked?"只看有效":"全部"):"未接入";
  $("mActive").nextElementSibling.textContent=s.rows?"按真实有效期过滤":"缺 "+missingSummary(keys)+"；当前填充率 "+s.rate;
  $("mWarn").textContent=warnText(warn);
  $("mWarnBasis").textContent=s.rows?"只统计真实业务预警":"未接入不可忽略；当前填充率 "+s.rate;
  $("manualTitle").textContent=tabLabels[state.tab]+" / "+manualSteps[state.tab];
  $("manualToolbarModule").textContent=tabLabels[state.tab];
  $("manualCode").textContent="RATE-"+state.tab;
  $("manualVersion").textContent=VERSION;
  $("manualGenerated").textContent=($("stamp").textContent.split("生成时间 ")[1]||"--");
  $("manualState").textContent=accessSummary(s,keys);
  $("manualRows").textContent=s.rows?String(s.rows):"未接入";
  $("manualFill").textContent=s.rate;
  $("manualGap").textContent=missingSummary(keys);
  $("manualWarn").textContent=warnText(warn);
  renderManual(s);
  renderCoverage();
}
function renderManual(s){
  var keys=activeKeys(),source=keys.map(function(k){var c=cov(k);return (c&&c.table)||k;}).join(" / ");
  $("manualPath").textContent=manualPaths[state.tab]||("价格 / 运价管理 / "+tabLabels[state.tab]);
  $("manualBasis").textContent=accessSummary(s,keys);
  $("manualLimit").textContent=manualLimits[state.tab]||"只读展示；未设置不编造；未接入不提供忽略。";
  $("manualFlow").innerHTML=(manualFlows[state.tab]||[]).map(function(x,i){return '<div><b>'+esc("步骤 "+(i+1))+'</b><span>'+esc(x)+'</span></div>';}).join("");
  $("manualSource").textContent=source||"未接入";
  $("manualNeed").textContent=needSummary(s,keys);
  $("manualForm").innerHTML=manualFormHtml([["业务对象",tabLabels[state.tab]],["维护范围",manualOwners[state.tab]||"未接入"],["数据状态",s.rows?(s.missing?"部分接入 "+s.rows:"真实记录 "+s.rows):"未接入"],["缺字段",missingSummary(keys)],["填充率",s.rate],["业务预警",warnText(s.rows?businessWarnCount():"未接入")]]);
  renderManualRegister(s,keys,source);
  $("manualOps").innerHTML=(manualOps[state.tab]||[]).map(function(op,i){
    var label=s.rows?(s.missing>0?"缺字段不可忽略":"已接入"):"未接入";
    return '<div class="manual-op"><b>'+esc((i+1)+" "+op[0])+'</b><span>'+esc(op[1])+'</span><span class="state '+(s.rows?"":"na")+'">'+esc(label)+'</span></div>';
  }).join("");
  renderManualKv(s,keys,source);
  renderManualLedger(s,keys,source);
  renderManualChecks(keys);
  $("manualStrip").innerHTML=manualOrder.map(function(key,i){
    return '<button type="button" data-step-tab="'+attr(key)+'" class="'+(key===state.tab?"on":"")+'">'+esc((i+1)+" "+manualSteps[key])+'</button>';
  }).join("");
  document.querySelectorAll("#manualMenu [data-step]").forEach(function(x){x.classList.toggle("on",x.dataset.step===state.tab);});
}
function sourceLabel(key){
  var c=cov(key);
  return ((c&&c.table)||key)+" / "+key;
}
function stateClass(connected,hasGap){return !connected||hasGap?"state-miss":"state-ready";}
function missingLabel(text){return text==="真实记录"?"可读取真实记录":(text||"coverage 未返回");}
function sourceMissingDetail(key){
  var gap=fieldGapSummary(key),miss=missingLabel(covMissing(key));
  if(gap)return gap;
  return miss||((required[key]||[]).join(" / "))||"coverage 未返回";
}
function sourceRestriction(key){
  var rows=(state.data[key]||[]).length,rate=covRate(key),miss=sourceMissingDetail(key);
  if(!rows)return "未接入条目不提供忽略；需先补字段或接入数据源。";
  if(rate==="未接入")return "有记录但 coverage 未接入；只读展示，不提供忽略。";
  if(sourceHasGap(key))return "有真实记录但缺 "+miss+"；未接入类条目不提供忽略。";
  return "只读查询；真实业务预警只计数，需人工复核。";
}
function sourceHasGap(key){
  var rows=fieldRows(key);
  return rows.some(function(f){return f.state!=="ready"||!f.total||f.filled<f.total;});
}
function rowStateText(key){
  var rows=(state.data[key]||[]).length,rate=covRate(key),miss=sourceMissingDetail(key);
  if(rows)return "真实记录 "+rows+"；当前填充率 "+rate;
  return "未接入：缺 "+miss+"；当前填充率 "+rate;
}
function renderManualChecks(keys){
  $("manualChecks").innerHTML=keys.map(function(key){
    var rows=(state.data[key]||[]).length,rate=covRate(key),gap=sourceHasGap(key),label=!rows?"未接入":(gap?"部分接入":"已接入");
    return "<tr><td><span class=\""+stateClass(!!rows,gap)+"\">"+esc(label)+"</span><br>"+esc(sourceLabel(key))+"</td><td>"+esc(sourceMissingDetail(key))+"</td><td>"+esc(rate)+"</td><td>"+esc(sourceRestriction(key))+"</td></tr>";
  }).join("")||'<tr><td colspan="4">未接入：缺 activeKeys；当前填充率 未接入。</td></tr>';
}
function renderManualLedger(s,keys,source){
  var missing=missingSummary(keys),status=s.rows?(s.missing?"部分接入：缺 "+missing+"；当前填充率 "+s.rate:"已接入：真实记录 "+s.rows+"；当前填充率 "+s.rate):"未接入：缺 "+missing+"；当前填充率 "+s.rate;
  $("manualLedger").innerHTML=(manualOps[state.tab]||[]).map(function(op,i){
    var fieldText=(keys.map(function(k){return (required[k]||[]).join(" / ");}).filter(Boolean).join(" / "))||"未接入";
    var cls=s.rows&&!s.missing?"state-ready":"state-miss";
    return "<tr><td>"+esc((i+1)+" "+op[0])+"</td><td>"+esc(fieldText)+"</td><td>"+esc(source||"未接入")+"</td><td><span class=\""+cls+"\">"+esc(status)+"</span><br>"+esc(op[1])+"</td></tr>";
  }).join("")||'<tr><td colspan="4">未接入：缺操作配置；当前填充率 未接入。</td></tr>';
}
function filterSummary(){
  var p=[];
  [["pol","起运港"],["pod","目的港"],["carrier","船公司"]].forEach(function(x){var el=$(x[0]);if(el&&el.value.trim())p.push(x[1]+"="+el.value.trim());});
  p.push($("active").checked?"只看有效":"全部记录");
  return p.join(" / ");
}
function fieldGapSummary(key){
  var gaps=fieldRows(key).filter(function(f){return f.state!=="ready"||!f.total||f.filled<f.total;});
  return gaps.map(function(f){return f.table+"."+f.name;}).join(" / ");
}
function missingSummary(keys){
  var gaps=keys.map(fieldGapSummary).filter(Boolean).join(" / ");
  if(gaps)return gaps;
  return keys.map(covMissing).filter(function(x){return x&&x!=="真实记录";}).join(" / ")||"可读取真实字段";
}
function registerCell(k,v){return "<th>"+esc(k)+"</th><td>"+esc(v)+"</td>";}
function renderManualRegister(s,keys,source){
  var missing=missingSummary(keys),readonly="运价可写（新增/改价/作废）；不写费用事实";
  var real=s.rows?"真实记录 "+s.rows:"未接入：缺 "+missing;
  var fields=(keys.map(function(k){return (required[k]||[]).map(function(f){return k+"."+f;}).join(" / ");}).filter(Boolean).join(" / "))||"未接入";
  $("manualRegister").innerHTML=[
    "<tr>"+registerCell("制单模块",tabLabels[state.tab])+registerCell("业务口径",real+"；当前填充率 "+s.rate)+"</tr>",
    "<tr>"+registerCell("数据来源",source||"未接入")+registerCell("真实字段",fields)+"</tr>",
    "<tr>"+registerCell("缺口登记",missing)+registerCell("不可操作",readonly+"；未接入不可忽略")+"</tr>"
  ].join("");
}
function accessSummary(s,keys){return s.rows?(s.missing?"部分接入：缺 "+missingSummary(keys)+"；当前填充率 "+s.rate:"真实记录 "+s.rows+"；当前填充率 "+s.rate):"未接入：缺 "+missingSummary(keys)+"；当前填充率 "+s.rate;}
function needSummary(s,keys){return s.rows?(s.missing?"缺 "+missingSummary(keys)+"；未接入项不可忽略；当前填充率 "+s.rate:"已接入真实字段；当前填充率 "+s.rate):"缺 "+missingSummary(keys)+"；当前填充率 "+s.rate;}
function manualKvRow(name,main,sub){
  return '<tr><th>'+esc(name)+'</th><td><span class="manual-kv-main">'+esc(main)+'</span><span class="manual-kv-sub">'+esc(sub)+'</span></td></tr>';
}
function renderManualKv(s,keys,source){
  var missing=missingSummary(keys);
  var fields=keys.map(function(k){return (required[k]||[]).map(function(f){return k+"."+f;}).join(" / ");}).filter(Boolean).join(" / ");
  var ready=s.rows?"当前模块真实记录 "+s.rows+"；字段填充率 "+s.rate:"未接入：缺 "+missing+"；当前填充率 "+s.rate;
  var rowsBySource=keys.map(rowStateText).join(" / ");
  $("manualKv").innerHTML=[
    manualKvRow("功能说明",manualTargets[state.tab]||tabLabels[state.tab],manualLimits[state.tab]||"只读展示；未设置不编造。"),
    manualKvRow("数据来源",source||"未接入",rowsBySource||ready),
    manualKvRow("必填字段",fields||"未接入","缺字段："+missing+"；未设置值按未设置展示，不反推。"),
    manualKvRow("操作控制","只读查询、筛选、导出 CSV、打开工作台标签","未接入条目不提供忽略；真实业务预警只计数不自动处理。")
  ].join("");
}
