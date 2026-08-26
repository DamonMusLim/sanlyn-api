(function(){
  "use strict";
  var labels={DRY:"干货",REEFER:"冷藏/冷冻",OOG:"超限/特种柜",DANGEROUS:"危险品",BREAK_BULK:"件杂/散杂"};
  var aliases=[
    ["DANGEROUS",["danger","dangerous","dg","haz","hazard","危险","危品","冷藏危险"]],
    ["REEFER",["reefer","rf","refrigerated","冷藏","冷冻","冻品","冷链"]],
    ["OOG",["oog","out of gauge","超限","框架","开顶","特种柜"]],
    ["BREAK_BULK",["break bulk","breakbulk","bb","bulk","件杂","散杂","散货"]],
    ["DRY",["dry","general","normal","普通","普货","干货","非危险"]]
  ];
  function normalize(value){
    var raw=String(value==null?"":value).trim();
    if(!raw)return {code:null,label:null,raw:null,state:"not_connected"};
    var upper=raw.toUpperCase().replace(/[-\s]+/g,"_");
    if(labels[upper])return {code:upper,label:labels[upper],raw:raw,state:"ready"};
    var text=raw.toLowerCase(), hit=null;
    aliases.some(function(pair){return pair[1].some(function(x){if(text.indexOf(x.toLowerCase())!==-1){hit=pair[0];return true}return false})});
    return hit?{code:hit,label:labels[hit],raw:raw,state:"ready"}:{code:null,label:null,raw:raw,state:"unmapped"};
  }
  window.SanlynCargoType={labels:labels,normalize:normalize};
})();
