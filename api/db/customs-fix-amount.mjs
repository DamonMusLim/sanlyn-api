// 自动修复报关申报金额 — 硬规则: 申报金额 ≤ 客户销售价(否则退税出问题,以报关单为主)。
// 逻辑: 申报单价 declare_amount_per_box > 客户每箱单价 时封顶到客户每箱单价。
//   客户每箱单价 = subtotal/qty_ctn(有小计优先,含尾数/让价) 否则 unit_price;向下取整到分,保证 申报 ≤ 客户。
// [2026-07-10 修] ①BL 在 shipping_plans.order_nos, orders.bl_no 多为空 → 按 bl_no 先查 plan 拿 order_nos;
//   ②封顶基准改用 subtotal/qty(治"申报价四舍五入进位"5.28→5.30 的小数点问题,以前基准用 unit_price 治不掉尾数);
//   ③unit_price=0 也用 subtotal/qty 封顶;两者都无参照 → 记 skipped 不猜。
// POST {bl_no} 或 {order_no} [, dry:true 只看不改]
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function readBody(req){return new Promise(function(res,rej){if(req.body!==undefined){if(typeof req.body==="string"){try{res(req.body?JSON.parse(req.body):{});}catch(e){rej(e);}return;}res(req.body||{});return;}var c=[];req.on("data",function(x){c.push(x);});req.on("end",function(){var r=Buffer.concat(c).toString("utf8");if(!r){res({});return;}try{res(JSON.parse(r));}catch(e){rej(e);}});req.on("error",rej);});}

export default async function handler(req, res){
  setCors(req, res, "POST, OPTIONS");
  if(req.method==="OPTIONS") return res.status(204).end();
  if(!requireAuth(req,res)) return;
  if(req.method!=="POST") return res.status(405).json({error:"POST only"});
  var pool=getPool();
  try{
    var b=await readBody(req);
    var blNo=b.bl_no||null, orderNo=b.order_no||null, dry=!!b.dry;
    if(!blNo && !orderNo) return res.status(400).json({error:"need bl_no or order_no"});
    // 找订单: BL 在 shipping_plans.order_nos(orders.bl_no 多为空)
    var oq;
    if(blNo){
      var sp=await pool.query("SELECT id,order_nos FROM shipping_plans WHERE bl_no=$1",[blNo]);
      var onos=[], planIds=[]; sp.rows.forEach(function(r){ planIds.push(r.id); if(Array.isArray(r.order_nos)) onos=onos.concat(r.order_nos); });
      // 一票多柜: 部分订单不在 shipping_plans.order_nos, 再从 container_bookings 补齐(合并报关视图就是靠它拿全部柜/单)
      var cb=await pool.query("SELECT DISTINCT order_no, contract_no FROM container_bookings WHERE btrim(bl_no)=btrim($1)"+(planIds.length?" OR shipping_plan_id=ANY($2)":""), planIds.length?[blNo,planIds]:[blNo]);
      cb.rows.forEach(function(r){ if(r.order_no) onos.push(r.order_no); if(r.contract_no) onos.push(r.contract_no); });
      onos=Array.from(new Set(onos.filter(Boolean)));
      oq = onos.length
        ? await pool.query("SELECT id,order_no FROM orders WHERE bl_no=$1 OR order_no=ANY($2) OR contract_no=ANY($2)",[blNo,onos])
        : await pool.query("SELECT id,order_no FROM orders WHERE bl_no=$1",[blNo]);
    } else {
      oq = await pool.query("SELECT id,order_no FROM orders WHERE order_no=$1 OR contract_no=$1",[orderNo]);
    }
    if(!oq.rows.length) return res.status(404).json({error:"no orders"});
    var oids=oq.rows.map(function(r){return r.id;});
    var onoById={}; oq.rows.forEach(function(r){onoById[r.id]=r.order_no;});
    var li=await pool.query("SELECT id,order_id,sku,declaration_name,qty_ctn,declare_amount_per_box,unit_price,subtotal FROM order_line_items WHERE order_id=ANY($1)",[oids]);
    // 客户每箱单价(封顶天花板): subtotal/qty 优先(含尾数),否则 unit_price;向下取整到分,保证 申报 ≤ 客户
    function custUnit(r){var q=Number(r.qty_ctn)||0,up=Number(r.unit_price)||0,st=Number(r.subtotal)||0;var cu=(st>0&&q>0)?st/q:up;return cu>0?Math.floor(cu*100)/100:0;}
    var sumDecl=0,sumCust=0,fixed=[],skipped=[];
    li.rows.forEach(function(r){var q=Number(r.qty_ctn)||0,dpb=Number(r.declare_amount_per_box)||0,up=Number(r.unit_price)||0,st=Number(r.subtotal)||0;sumDecl+=q*dpb;sumCust+=(st>0?st:q*up);});
    var before={declared:Math.round(sumDecl*100)/100, customer:Math.round(sumCust*100)/100};
    var toFix=li.rows.filter(function(r){var cu=custUnit(r);return cu>0 && Number(r.declare_amount_per_box)>cu;});
    for(var i=0;i<toFix.length;i++){var r=toFix[i];var cu=custUnit(r);
      fixed.push({order_no:onoById[r.order_id], sku:r.sku, decl_name:r.declaration_name, old_unit:Number(r.declare_amount_per_box), new_unit:cu, qty:Number(r.qty_ctn)});
      if(!dry) await pool.query("UPDATE order_line_items SET declare_amount_per_box=$1 WHERE id=$2",[cu, r.id]);
    }
    // 无客户价参照(subtotal 与 unit_price 都无)但申报>0 → 记 skipped 不猜(留人工核源头售价)
    li.rows.forEach(function(r){if(custUnit(r)<=0 && Number(r.declare_amount_per_box)>0) skipped.push({order_no:onoById[r.order_id],sku:r.sku,decl_name:r.declaration_name,declare_amount_per_box:Number(r.declare_amount_per_box)});});
    var li2 = dry ? li.rows.map(function(r){var c={...r};var cu=custUnit(r);if(cu>0&&Number(r.declare_amount_per_box)>cu)c.declare_amount_per_box=cu;return c;}) : (await pool.query("SELECT qty_ctn,declare_amount_per_box,unit_price,subtotal FROM order_line_items WHERE order_id=ANY($1)",[oids])).rows;
    var aDecl=0,aCust=0; li2.forEach(function(r){var q=Number(r.qty_ctn)||0;aDecl+=q*Number(r.declare_amount_per_box||0);aCust+=(Number(r.subtotal)>0?Number(r.subtotal):q*Number(r.unit_price||0));});
    var after={declared:Math.round(aDecl*100)/100, customer:Math.round(aCust*100)/100};
    return res.status(200).json({ok:after.declared<=after.customer, dry:dry, fixed_count:fixed.length, fixed:fixed, skipped:skipped, before:before, after:after});
  }catch(e){ return res.status(500).json({error:String(e&&e.message||e)}); }
}
