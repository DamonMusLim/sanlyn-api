import { getPool } from "../db.js";
var JDY_TOKEN="jgAipmndimpj0endT0wStd6gpspAQpAd";
var JDY_APP_ID="689cb08a93c073210bfc772b";
var JDY_ENTRY_ID="6419d478b9b91b00091e4d73";
var W={companyNameCN:"_widget_1764468507573",companyNameEN:"_widget_1764468507574",companyCode:"_widget_1764590113940",customerAddress:"_widget_1772452248447",consignee:"_widget_1770371550212",destinationPort:"_widget_1764471197748",requiredArrivalDate:"_widget_1663812600609",remarks:"_widget_1762571045801",totalAmount:"_widget_1764467945302",totalQty:"_widget_1764467945301",source:"_widget_1771093417266",portalSubmissionId:"_widget_1771093417265",orderSubform:"_widget_1764396068557",sub_productName:"_widget_1764396068574",sub_code:"_widget_1764396068578",sub_unitPrice:"_widget_1769420815282",sub_qty:"_widget_1764396068583",sub_subtotal:"_widget_1764467945303",sub_unit:"_widget_1770194186503"};
function generateOrderNo(){var d=new Date();return"ORD-"+d.getFullYear()+String(d.getMonth()+1).padStart(2,"0")+String(d.getDate()).padStart(2,"0")+"-"+String(Math.floor(Math.random()*10000)).padStart(4,"0");}
export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS")return res.status(200).end();
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
  try{
    var{companyCode,companyNameCN,companyNameEN,consignee,deliveryAddress,destinationPort,requiredArrivalDate,remarks,products=[],createdBy}=req.body;
    if(!companyNameCN&&!companyNameEN)return res.status(400).json({error:"companyName is required"});
    if(!products.length)return res.status(400).json({error:"products cannot be empty"});
    var totalAmount=products.reduce(function(s,p){return s+(parseFloat(p.subtotal)||parseFloat(p.unitPrice)*parseFloat(p.qty)||0);},0);
    var totalQty=products.reduce(function(s,p){return s+(parseInt(p.qty)||0);},0);
    var orderNo=generateOrderNo();
    var pool=getPool();
    var raw={companyCode:companyCode||"",companyNameCN:companyNameCN||"",companyNameEN:companyNameEN||"",consignee:consignee||companyNameEN||"",deliveryAddress:deliveryAddress||"",destinationPort:destinationPort||"",requiredArrivalDate:requiredArrivalDate||"",remarks:remarks||"",totalAmount:totalAmount,totalQty:totalQty,products:products.map(function(p){return{productName:p.productName||p.name||"",code:p.code||p.sku||"",unitPrice:parseFloat(p.unitPrice)||0,qty:parseInt(p.qty)||0,unit:p.unit||"CTN",subtotal:parseFloat(p.subtotal)||(parseFloat(p.unitPrice)*parseFloat(p.qty))||0,cbm:parseFloat(p.cbm)||0,barcode:p.barcode||""};}),source:"portal",createdAt:new Date().toISOString()};
    var sqlResult=await pool.query("INSERT INTO orders (order_no,customer,company_code,status,raw,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,order_no",[orderNo,companyNameEN||companyNameCN||"",companyCode||"","pending",JSON.stringify(raw),createdBy||"portal"]);
    var sqlOrder=sqlResult.rows[0];
    console.log("[order-create] SQL OK: id="+sqlOrder.id+" orderNo="+sqlOrder.order_no);
    var jdyResult=null;var jdyError=null;
    try{
      var data={[W.companyNameCN]:{value:companyNameCN||companyNameEN||""},[W.companyNameEN]:{value:companyNameEN||companyNameCN||""},[W.companyCode]:{value:companyCode||""},[W.consignee]:{value:consignee||companyNameEN||""},[W.customerAddress]:{value:deliveryAddress||""},[W.destinationPort]:{value:destinationPort||""},[W.remarks]:{value:remarks||""},[W.totalAmount]:{value:totalAmount},[W.totalQty]:{value:totalQty},[W.source]:{value:"portal"},[W.portalSubmissionId]:{value:orderNo}};
      if(requiredArrivalDate)data[W.requiredArrivalDate]={value:new Date(requiredArrivalDate).getTime()};
      data[W.orderSubform]=products.map(function(p){var subtotal=parseFloat(p.subtotal)||parseFloat(p.unitPrice)*parseFloat(p.qty)||0;return{[W.sub_productName]:{value:p.productName||p.name||""},[W.sub_code]:{value:p.code||p.sku||""},[W.sub_unitPrice]:{value:parseFloat(p.unitPrice)||0},[W.sub_qty]:{value:parseInt(p.qty)||0},[W.sub_subtotal]:{value:subtotal},[W.sub_unit]:{value:p.unit||"CTN"}};});
      var jdyRes=await fetch("https://api.jiandaoyun.com/api/v5/app/"+JDY_APP_ID+"/entry/"+JDY_ENTRY_ID+"/data",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+JDY_TOKEN},body:JSON.stringify({data:data})});
      var jdyJson=await jdyRes.json();
      if(jdyRes.ok&&!jdyJson.code){jdyResult={entryId:jdyJson.data?._id,synced:true};await pool.query("UPDATE orders SET raw=raw||$1 WHERE id=$2",[JSON.stringify({jdyEntryId:jdyJson.data?._id,jdySynced:true}),sqlOrder.id]);}
      else{jdyError={code:jdyJson.code,msg:jdyJson.msg};await pool.query("UPDATE orders SET raw=raw||$1 WHERE id=$2",[JSON.stringify({jdySynced:false,jdyError:jdyJson.msg||"sync failed"}),sqlOrder.id]);}
    }catch(jdyErr){jdyError={msg:jdyErr.message};await pool.query("UPDATE orders SET raw=raw||$1 WHERE id=$2",[JSON.stringify({jdySynced:false,jdyError:jdyErr.message}),sqlOrder.id]).catch(function(){});}
    return res.status(200).json({success:true,orderId:sqlOrder.id,orderNo:sqlOrder.order_no,totalAmount:totalAmount,totalQty:totalQty,jdySynced:jdyResult?true:false,jdyError:jdyError||null,message:"Order submitted. "+(jdyResult?"JDY synced.":"JDY sync pending.")});
  }catch(err){console.error("[order-create]",err);return res.status(500).json({error:err.message});}
}
