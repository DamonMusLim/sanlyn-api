// 自动修复报关申报金额 — 硬规则: 申报金额 ≤ 客户销售价(否则退税出问题,以报关单为主)。
// 逻辑: 申报单价(declare_amount_per_box) > 客户单价(unit_price) 时封顶到客户单价(退税允许的最高值)。
// POST {bl_no} 或 {order_no} [, dry:true 只看不改]
// 返回 {fixed:[{order_no,sku,old,new}], before:{Σ申报,Σ客户}, after:{...}, ok:bool}
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
    // 找订单
    var oq = blNo
      ? await pool.query("SELECT id,order_no FROM orders WHERE bl_no=$1",[blNo])
      : await pool.query("SELECT id,order_no FROM orders WHERE order_no=$1 OR contract_no=$1",[orderNo]);
    if(!oq.rows.length) return res.status(404).json({error:"no orders"});
    var oids=oq.rows.map(function(r){return r.id;});
    var onoById={}; oq.rows.forEach(function(r){onoById[r.id]=r.order_no;});
    // 取行
    var li=await pool.query("SELECT id,order_id,sku,declaration_name,qty_ctn,declare_amount_per_box,unit_price,subtotal FROM order_line_items WHERE order_id=ANY($1)",[oids]);
    var sumDecl=0, sumCust=0; var fixed=[];
    li.rows.forEach(function(r){
      var q=Number(r.qty_ctn)||0, dpb=Number(r.declare_amount_per_box)||0, up=Number(r.unit_price)||0, st=Number(r.subtotal)||0;
      sumDecl += q*dpb;
      sumCust += (st>0?st:q*up);
    });
    var before={declared:Math.round(sumDecl*100)/100, customer:Math.round(sumCust*100)/100};
    // 封顶: 申报单价 > 客户单价 → = 客户单价
    var toFix=li.rows.filter(function(r){return Number(r.unit_price)>0 && Number(r.declare_amount_per_box)>Number(r.unit_price);});
    for(var i=0;i<toFix.length;i++){var r=toFix[i];
      fixed.push({order_no:onoById[r.order_id], sku:r.sku, decl_name:r.declaration_name, old_unit:Number(r.declare_amount_per_box), new_unit:Number(r.unit_price), qty:Number(r.qty_ctn)});
      if(!dry) await pool.query("UPDATE order_line_items SET declare_amount_per_box=$1 WHERE id=$2",[r.unit_price, r.id]);
    }
    // 复算after
    var li2 = dry ? li.rows.map(function(r){var c={...r}; if(Number(r.unit_price)>0&&Number(r.declare_amount_per_box)>Number(r.unit_price))c.declare_amount_per_box=r.unit_price; return c;}) : (await pool.query("SELECT qty_ctn,declare_amount_per_box,unit_price,subtotal FROM order_line_items WHERE order_id=ANY($1)",[oids])).rows;
    var aDecl=0,aCust=0; li2.forEach(function(r){var q=Number(r.qty_ctn)||0;aDecl+=q*Number(r.declare_amount_per_box||0);aCust+=(Number(r.subtotal)>0?Number(r.subtotal):q*Number(r.unit_price||0));});
    var after={declared:Math.round(aDecl*100)/100, customer:Math.round(aCust*100)/100};
    return res.status(200).json({ok:after.declared<=after.customer, dry:dry, fixed_count:fixed.length, fixed:fixed, before:before, after:after});
  }catch(e){ return res.status(500).json({error:String(e&&e.message||e)}); }
}
