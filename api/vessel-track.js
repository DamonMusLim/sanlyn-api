const AUTH_URL='https://prod-api.4portun.com/openapi/auth/token';
const BASE_URL='https://prod-api.4portun.com/openapi/gateway/api/v2';
let _cachedToken=null,_tokenExpiry=0;
async function getToken(){
  if(_cachedToken&&Date.now()<_tokenExpiry)return _cachedToken;
  const res=await fetch(AUTH_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appId:process.env.PORTUN_APP_ID,secret:process.env.PORTUN_SECRET})});
  const data=await res.json();
  if(!data.data)throw new Error('Auth failed: '+JSON.stringify(data));
  _cachedToken=data.data;_tokenExpiry=Date.now()+23*60*60*1000;
  return _cachedToken;
}
const EVENT_LABELS={LOBD:{label:'已装船',icon:'📦'},DLPT:{label:'已离港',icon:'🚢'},TSBA:{label:'中转抵港',icon:'⚓'},TSDC:{label:'中转卸货',icon:'🔄'},TSLB:{label:'中转装船',icon:'📦'},TSDP:{label:'中转离港',icon:'🚢'},BDAR:{label:'抵达目的港',icon:'🏁'},DSCH:{label:'已卸货',icon:'✅'},PCAB:{label:'可提货',icon:'🟢'},RCVE:{label:'已还空',icon:'🔵'},GATE_IN:{label:'进场',icon:'🔵'},GATE_OUT:{label:'出场',icon:'🔵'}};
function normalizeEvent(e){const meta=EVENT_LABELS[e.eventCode]||{label:e.descriptionCn||e.eventCode||'-',icon:'📍'};return{code:e.eventCode,label:meta.label,icon:meta.icon,location:e.eventPlace||e.portCode||'',time:e.eventTime||'',isActual:e.isEsti==='N',vessel:e.vessel||'',voyage:e.voyage||''};}
export default async function handler(req,res){
  const origin=req.headers.origin||'';
  const allowed=['https://ai.sanlynos.com','http://localhost:5173','http://localhost:3000'];
  if(allowed.includes(origin))res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.status(200).end();
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const{blNo,ctnrNo,carrierCode}=req.query;
  if(!blNo)return res.status(400).json({error:'blNo required'});
  if(!ctnrNo)return res.status(400).json({error:'ctnrNo required'});
  if(!carrierCode)return res.status(400).json({error:'carrierCode required'});
  try{
    const token=await getToken();
    const headers={'Content-Type':'application/json','appId':process.env.PORTUN_APP_ID,'Authorization':'Bearer '+token};
    const subRes=await fetch(BASE_URL+'/subscribeOceanTracking',{method:'POST',headers,body:JSON.stringify({billNo:blNo.trim(),containerNo:ctnrNo.trim(),carrierCode:carrierCode.trim()})});
    const subData=await subRes.json();
    if(subData.code!==200)return res.status(400).json({error:subData.message,code:subData.code});
    const subscriptionId=subData.data?.subscriptionId;
    if(!subscriptionId)return res.status(500).json({error:'No subscriptionId'});
    const trackRes=await fetch(BASE_URL+'/getOceanTracking',{method:'POST',headers,body:JSON.stringify({billNo:blNo.trim(),subscriptionId})});
    const raw=await trackRes.json();
    if(raw.code!==200)return res.status(404).json({error:raw.message,code:raw.code});
    // DEBUG: return raw data to diagnose
    if(req.query.debug==='1')return res.status(200).json({raw});
    const d=raw.data;
    const container=d.containers?.[0];
    const events=(container?.status||[]).map(normalizeEvent);
    const actualEvents=events.filter(e=>e.isActual);
    const lastRoute=d.routes?.[d.routes.length-1];
    const firstRoute=d.routes?.[0];
    res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({blNo:blNo.trim(),ctnrNo:ctnrNo.trim(),carrierCode:carrierCode.trim(),carrierName:d.carrier?.carrierNameCn||d.carrier?.carrierName||'',pol:firstRoute?.polName||'',pod:lastRoute?.podName||'',etd:firstRoute?.polEtd||'',atd:firstRoute?.polAtd||'',eta:lastRoute?.podEta||'',ata:lastRoute?.podAta||'',vessel:d.firstVessel?.vessel||'',voyage:d.firstVessel?.voyage||'',currentStatus:{code:container?.currentStatusCode||'',time:container?.currentStatusTime||'',desc:container?.descriptionCn||container?.description||''},events,latestEvent:actualEvents.length>0?actualEvents[actualEvents.length-1]:null,routes:d.routes||[],subscriptionId});
  }catch(err){
    console.error('[vessel-track]',err.message);
    return res.status(500).json({error:'Failed',detail:err.message});
  }
}