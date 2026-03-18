import OSS from 'ali-oss';
const OSS_KEY='data/shipping_plans.json';
const OSS_PUBLIC=`https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/${OSS_KEY}`;
const W={shipmentNo:'_widget_1762828544749',shippingLine:'_widget_1765450157283',pol:'_widget_1764591553171',pod:'_widget_1764591553172',containerQty:'_widget_1765450157285',containerType:'_widget_1766895482504',customerEN:'_widget_1766913567261',customerCN:'_widget_1766568840023',forwarderCN:'_widget_1764591553170',forwarderEN:'_widget_1765191742170',truckingCN:'_widget_1768645113405',customsCN:'_widget_1768645113406',insuranceCN:'_widget_1773730136760',insuranceCost:'_widget_1773730136761',freightCost:'_widget_1768299925392',freightSaleUSD:'_widget_1766566622260',thcTotal:'_widget_1768300192916',truckingCost:'_widget_1772454275249',customsCost:'_widget_1768641952534',shipmentDate:'_widget_1764582236204',blNo:'_widget_1773399157196',etd:'_widget_1771626741566',eta:'_widget_1771626741567',vessel:'_widget_1771626741568',containerNo:'_widget_1771626741552',flowStatus:'_widget_1764582236205',contractNo:'_widget_1768820368507',orderNos:'_widget_1767084770362'};
function get(d,k){const v=d[W[k]];if(v===null||v===undefined)return '';if(typeof v==='object'&&v.value!==undefined)return v.value;return v;}
function mapRecord(d){return{_id:d._id||'',shipmentNo:String(get(d,'shipmentNo')||''),contractNo:String(get(d,'contractNo')||''),orderNos:String(get(d,'orderNos')||''),customerCompanyEN:String(get(d,'customerEN')||''),customerCompany:String(get(d,'customerCN')||get(d,'customerEN')||''),shippingLine:String(get(d,'shippingLine')||''),pol:String(get(d,'pol')||''),pod:String(get(d,'pod')||''),containerQty:Number(get(d,'containerQty'))||0,containerType:String(get(d,'containerType')||''),forwarderCN:String(get(d,'forwarderCN')||''),forwarderEN:String(get(d,'forwarderEN')||''),truckingCN:String(get(d,'truckingCN')||''),customsCN:String(get(d,'customsCN')||''),insuranceCN:String(get(d,'insuranceCN')||''),insuranceCost:Number(get(d,'insuranceCost'))||0,freightCost:Number(get(d,'freightCost'))||0,freightSaleUSD:Number(get(d,'freightSaleUSD'))||0,portSurchargeTotal:Number(get(d,'thcTotal'))||0,truckingCostTotal:Number(get(d,'truckingCost'))||0,customsCostTotal:Number(get(d,'customsCost'))||0,shipmentDate:String(get(d,'shipmentDate')||'').slice(0,10),blNo:String(get(d,'blNo')||''),etd:String(get(d,'etd')||'').slice(0,10),eta:String(get(d,'eta')||'').slice(0,19),vessel:String(get(d,'vessel')||''),containerNo:String(get(d,'containerNo')||''),flowStatus:String(get(d,'flowStatus')||''),status:['流程结束（归档关闭）','客户确认收货（签收/异常）','流转完成'].includes(get(d,'flowStatus'))?'completed':'in_progress',updatedAt:new Date().toISOString().slice(0,10)};}
function getOSSClient(){return new OSS({region:process.env.OSS_REGION,accessKeyId:process.env.OSS_ACCESS_KEY_ID,accessKeySecret:process.env.OSS_ACCESS_KEY_SECRET,bucket:process.env.OSS_BUCKET});}
const TRACKING=['currentStatus','currentStatusCn','trackingUpdatedAt','atd','voyage'];
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(200).end();
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
    const op=body.op||'data_update';
    const data=body.data?.data||body.data||{};
    if(op==='data_remove')return res.status(200).json({ok:true,action:'skip_delete'});
    const rec=mapRecord(data);
    if(!rec.shipmentNo&&!rec._id)return res.status(400).json({error:'Missing shipmentNo'});
    const r=await fetch(`${OSS_PUBLIC}?t=${Date.now()}`);
    if(!r.ok)throw new Error('OSS read failed: '+r.status);
    const parsed=await r.json();
    const list=Array.isArray(parsed)?parsed:[];
    const idx=list.findIndex(p=>(rec._id&&p._id===rec._id)||(rec.shipmentNo&&p.shipmentNo===rec.shipmentNo));
    if(idx>=0){const ex=list[idx];const m={...ex,...rec};TRACKING.forEach(f=>{if(ex[f])m[f]=ex[f];});if(!ex.eta&&rec.eta)m.eta=rec.eta;list[idx]=m;}
    else{list.unshift(rec);}
    const client=getOSSClient();
    await client.put(OSS_KEY,Buffer.from(JSON.stringify(list,null,2),'utf-8'),{mime:'application/json'});
    return res.status(200).json({ok:true,action:idx>=0?'updated':'created',shipmentNo:rec.shipmentNo});
  }catch(err){console.error('[jdy-plans-sync]',err);return res.status(500).json({error:err.message});}
}

