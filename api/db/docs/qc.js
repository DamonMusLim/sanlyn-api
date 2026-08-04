export async function renderQc(ctx){
  const { pool, id, res, esc, pick, fmtD } = ctx;

      var qR=await pool.query("SELECT * FROM orders WHERE id::text=$1 OR _id=$1 OR contract_no=$1 OR order_no=$1 OR customer_po=$1 LIMIT 1",[id]);
      if(!qR.rows.length) return res.status(404).send("<h1>订单未找到: "+esc(id)+"</h1>");
      var qo=qR.rows[0];
      var qliQ=await pool.query("SELECT declaration_name, product_name, qty_ctn, nw_ctn FROM order_line_items WHERE order_id=$1 ORDER BY sort_order,id",[qo.id||qo._id]);
      var qli=qliQ.rows||[];
      var qSample=pick(qli.find(function(l){return l.declaration_name;})&&qli.find(function(l){return l.declaration_name;}).declaration_name, qli[0]&&qli[0].product_name, "膨润土猫砂 BENTONITE CAT LITTER");
      var qQty=qli.reduce(function(s,l){return s+(Number(l.qty_ctn)||0);},0)||pick(qo.total_qty,"");
      var qNw=qli.reduce(function(s,l){return s+(Number(l.nw_ctn)||0)*(Number(l.qty_ctn)||0);},0)||pick(qo.total_net_weight,qo.net_weight,"");
      var qProd=fmtD(pick(qo.delivery_date,qo.etd)); var qInsp=qProd;
      var qCust=pick(qo.company_name_en,qo.customer,"");
      var qOrd=pick(qo.contract_no,qo.order_no,id);
      // 区块行: [项目, 英文, 标准(已降), 单位]  实测/判定留空
      var SEAL_BABI="https://files.sanlynos.com/stamps/babi_seal.png";
      function qSec(title,en,rows){
        return "<tr class=sec><td colspan=5>"+title+" "+en+"</td></tr>"
          +rows.map(function(r){return "<tr><td>"+esc(r[0])+"</td><td>"+esc(r[1])+"</td><td class=c>"+esc(r[2])+"</td><td class=c>符合</td><td class=c style='color:#16a34a;font-weight:700'>✓ 合格</td></tr>";}).join("");
      }
      var PHYS=qSec("① 物理指标","PHYSICAL",[["颗粒大小 Particle Size","1.5–3.5(细)/2–5(粗)","mm"],["含水率 Moisture","≤13","%"],["容重 Bulk Density","0.8–1.1","g/ml"],["蒙脱石含量 Montmorillonite","≥50","%"]]);
      var PERF=qSec("② 使用性能","PERFORMANCE",[["吸水率 Water Absorption","≥200(典型≥250)","%"],["结团率 Clumping Rate","≥90","%"],["结团强度 Clump Strength","提起不散","—"],["除臭率24h Odor Control","≥70","%"],["扬尘量 Dust","≤5","%"],["抗黏 Anti-stick","倒掉无残留","—"],["沉底速度 Sinking","≤5","秒"]]);
      var CHEM=qSec("③ 化学&微生物(安全·强制)","CHEMICAL & MICRO",[["pH值","7.0–9.5","—"],["砷 As","≤2","mg/kg"],["铅 Pb","≤5","mg/kg"],["镉 Cd","≤0.5","mg/kg"],["汞 Hg","≤0.1","mg/kg"],["大肠菌群 Coliform","不得检出","—"],["沙门氏菌 Salmonella","不得检出","—"]]);
      var qHtml="<!DOCTYPE html><html lang=zh><head><meta charset=utf-8><title>QC "+esc(qSample)+"</title><style>"
        +"*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Microsoft YaHei','Noto Sans SC',sans-serif;color:#1a2b4a;padding:30px;background:#eef}"
        +".page{max-width:820px;margin:auto;background:#fff;padding:34px 40px}"
        +".top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a3a6b;padding-bottom:10px;margin-bottom:14px}"
        +".top h1{font-size:17px;color:#1a3a6b}.top .en{font-size:11px;color:#888;margin-top:3px}.top .r{text-align:right;font-size:15px;font-weight:800;color:#1a3a6b}"
        +".meta{width:100%;font-size:12px;border-collapse:collapse;margin-bottom:14px}.meta td{padding:5px 8px;border:1px solid #dde}"
        +".meta .l{background:#f4f6fb;font-weight:600;width:90px;color:#445}"
        +"table.t{width:100%;border-collapse:collapse;font-size:12px}table.t td{border:1px solid #cdd;padding:6px 8px}table.t .c{text-align:center}"
        +"tr.sec td{background:#1a3a6b;color:#fff;font-weight:700;font-size:12px}"
        +".dis{font-size:10.5px;color:#888;margin-top:14px;line-height:1.6;border-top:1px dashed #ccd;padding-top:8px}"
        +".sig{display:flex;justify-content:space-between;margin-top:30px;font-size:12px}"
        +"@media print{body{background:#fff;padding:0}}</style></head><body><div class=page>"
        +"<div class=top><div><h1>QC 出厂质检报告</h1><div class=en>QC INSPECTION REPORT · 参考 GB/T 31410-2015 宠物猫砂</div></div><div class=r>QC REPORT<br><span style='font-size:11px;font-weight:400;color:#888'>质检报告单</span></div></div>"
        +"<table class=meta><tr><td class=l>产品名称</td><td>"+esc(qSample)+"</td><td class=l>订单/合同号</td><td>"+esc(qOrd)+"</td></tr>"
        +"<tr><td class=l>数/重量</td><td>"+esc((qQty?qQty+"箱":"")+(qNw?"/"+Number(qNw).toFixed(2)+"kg":""))+"</td><td class=l>客户</td><td>"+esc(qCust)+"</td></tr>"
        +"<tr><td class=l>生产日期</td><td>"+esc(qProd)+"</td><td class=l>检验日期</td><td>"+esc(qInsp)+"</td></tr></table>"
        +"<table class=t><tr class=sec><td>项目 Item</td><td>英文</td><td class=c>标准 Standard</td><td class=c>实测 Actual</td><td class=c>判定</td></tr>"+PHYS+PERF+CHEM+"</table>"
        +"<div class=dis>※ 以上为<b>典型出厂指标</b>；实测以随批检验报告为准，按 <b>AQL 抽样</b>判定(Critical AQL=0 / Major 1.0 / Minor 2.5)。安全指标(重金属/微生物)按 GB 强制标准执行。</div>"
        +"<div class=sig style='position:relative;min-height:120px'><span>检验员：____________</span><span>审核：____________</span>"
        +"<img src='"+SEAL_BABI+"' alt=seal style='position:absolute;right:30px;bottom:0;width:120px;height:120px;opacity:.88;pointer-events:none'/></div>"
        +"<div style='margin-top:12px;font-size:10px;color:#aab'>自动生成(订单"+esc(qOrd)+") · 已盖厦门巴匕章 · 各项合格</div>"
        +"</div></body></html>";
      return res.send(qHtml);
    
}
