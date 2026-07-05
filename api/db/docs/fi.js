export async function renderFi(ctx){
  const { pool, id, res, esc, pick, fmtD } = ctx;

  try{
      var fiR=await pool.query("SELECT * FROM orders WHERE id::text=$1 OR _id=$1 OR contract_no=$1 OR order_no=$1 OR customer_po=$1 LIMIT 1",[id]);
      if(!fiR.rows.length) return res.status(404).send("<h1>订单未找到: "+esc(id)+"</h1>");
      var fo=fiR.rows[0];
      var liQ=await pool.query("SELECT declaration_name, product_name, factory_name, qty_ctn, nw_ctn FROM order_line_items WHERE order_id=$1 ORDER BY sort_order,id",[fo.id||fo._id]);
      var fiLines=liQ.rows||[];
      var factory=pick(fiLines.find(function(l){return l.factory_name;})&&fiLines.find(function(l){return l.factory_name;}).factory_name, fo.factory, "____________________");
      var sampleName=pick(fiLines.find(function(l){return l.declaration_name;})&&fiLines.find(function(l){return l.declaration_name;}).declaration_name, fiLines[0]&&fiLines[0].product_name, "____________");
      // 箱数+NW 与装箱单(PL)同源: Σ(qty_ctn), Σ(nw_ctn × qty_ctn) — 不用可能 stale 的 orders 快照
      var qtyCtn=fiLines.reduce(function(s,l){return s+(Number(l.qty_ctn)||0);},0);
      var nwKg=fiLines.reduce(function(s,l){return s+(Number(l.nw_ctn)||0)*(Number(l.qty_ctn)||0);},0);
      if(!qtyCtn) qtyCtn=pick(fo.total_qty,fo.total_ctn,"");          // 行项目缺则回退订单
      if(!nwKg) nwKg=pick(fo.total_net_weight,fo.net_weight,"");
      var qtyWeight=(qtyCtn?qtyCtn+"箱":"")+(qtyCtn&&nwKg?"/":"")+(nwKg?Math.round(Number(nwKg))+"kg":"");
      // 生产日期 = 确认交货期(delivery_date); 检验日期 = 同日
      var prodDate=fmtD(pick(fo.delivery_date,fo.etd));
      var inspDate=prodDate;
      // 检测项目+技术要求 按品类(豆腐猫砂/猫砂)。结果留空=工厂实测填。
      var isLitter=/猫砂|豆腐|膨润/.test(String(sampleName));
      var ITEMS=isLitter?[
        ["1","水分","%","≤12"],["2","结团性","CM","≤5"],["3","吸水率","%","≥66"],
        ["4","结团强度","%","≥75"],["5","硬度","N","≥35"]
      ]:[["1","","","　"],["2","","","　"],["3","","","　"],["4","","","　"],["5","","","　"]];
      var rows=ITEMS.map(function(it){
        return "<tr><td>"+it[0]+"</td><td>"+esc(it[1])+"</td><td>"+esc(it[2])+"</td><td>"+esc(it[3])+"</td><td>&nbsp;</td><td>&nbsp;</td></tr>";
      }).join("");
      var fiHtml="<!DOCTYPE html><html lang=zh><head><meta charset=utf-8><title>厂检单 "+esc(sampleName)+"</title><style>"
        +"*{box-sizing:border-box;margin:0;padding:0}body{font-family:'SimSun','Noto Serif SC',serif;color:#000;padding:36px;background:#f0f0f0}"
        +".page{max-width:760px;margin:auto;background:#fff;padding:42px 48px;min-height:1000px}"
        +".co{text-align:center;font-size:18px;font-weight:900;margin-bottom:6px}"
        +".ti{text-align:center;font-size:22px;font-weight:700;margin:10px 0 22px;letter-spacing:2px}"
        +".meta{width:100%;font-size:13px;margin-bottom:16px}.meta td{padding:6px 4px}"
        +"table.t{width:100%;border-collapse:collapse;font-size:13px}table.t td,table.t th{border:1px solid #000;padding:7px 6px;text-align:center}"
        +"table.t th{background:#f2f2f2;font-weight:700}"
        +".note{font-size:12px;margin:18px 0 30px}.sig{display:flex;justify-content:space-between;font-size:13px;margin-top:40px}"
        +"@media print{body{background:#fff;padding:0}.page{box-shadow:none}}</style></head><body><div class=page>"
        +"<div class=co>"+esc(factory)+"</div>"
        +"<div class=ti>"+esc(sampleName)+" 检验报告</div>"
        +"<table class=meta><tr><td>样品名称："+esc(sampleName)+"</td><td>抽样地点：仓库</td></tr>"
        +"<tr><td>生产日期："+esc(prodDate||"____________")+"</td><td>数/重量："+esc(qtyWeight||"____________")+"</td></tr>"
        +"<tr><td>生产批号：____________</td><td>检验日期："+esc(inspDate||"____________")+"</td></tr></table>"
        +"<table class=t><tr><th>序号</th><th>检验项目</th><th>计量单位</th><th>技术要求</th><th>检验结果</th><th>单项评价</th></tr>"+rows+"</table>"
        +"<div class=note>样品检测，所检项目均符合出厂标准，符合双方合同约定和我方要求。</div>"
        +"<div class=sig style='position:relative;min-height:120px'><span>检测人员：____________</span><span>复检人员：____________</span>"
        +"<img src='https://files.sanlynos.com/stamps/zhongsha_seal.png' alt=seal onerror=\"this.style.display='none'\" style='position:absolute;right:60px;bottom:-10px;width:120px;height:120px;opacity:.88;pointer-events:none'/></div>"
        +"<div style='margin-top:14px;font-size:10px;color:#999'>※ 表头自动带入(订单"+esc(pick(fo.order_no,fo.contract_no))+"); 检验结果/日期/批号由工厂实测填写</div>"
        +"</div></body></html>";
      return res.send(fiHtml);
  }catch(err){
    return res.status(500).send("<h1>Error: "+esc(err.message)+"</h1>");
  }
    
}
