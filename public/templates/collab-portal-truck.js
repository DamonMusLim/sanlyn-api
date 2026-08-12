var _qfIdx = 0, _cntrZone = null, _autoSaveTimer = null;

const _upClean = fn => String(fn||'').replace(/^(\[[^\]]*\]|_[^_]+_)+/, '') || String(fn||'');
const _upInSeg = (fn, seg) => { fn=String(fn||''); return fn.startsWith('['+seg+']') || fn.startsWith('_'+seg+'_') || fn.startsWith('_'+seg+'__'); };
function renderFiles(){
  // 海运段：不再另列一份文件清单，直接把「已上传」状态渲进上传框本身（Damon：不要重复，上传后按钮变已上传、可更换）
  if ($('uzSO') || $('uzBL')) renderUploadZones();
  ['truck','customs'].forEach(seg=>{
    const el = $('fl_'+seg); if(!el) return;
    const fu = window._fileURL || (()=>'#');
    el.innerHTML = uploads.filter(u=>_upInSeg(u.filename, seg)).map(u=>{
      const url = fu('upload', u.stored);
      return `<div class="file-row" style="padding:5px 10px;margin-bottom:5px;gap:8px;">
        <span style="font-size:12px;">📄</span>
        <span style="flex:1;font-weight:700;font-size:11px;min-width:0;overflow-wrap:anywhere;">${esc(_upClean(u.filename))}</span>
        <a class="doc-btn" style="background:var(--goodbg);color:var(--good);border-color:color-mix(in srgb,var(--good) 40%,var(--line));padding:3px 8px;font-size:10px;" href="${esc(url)}" target="_blank">✓ 已上传·预览</a>
        <a class="doc-btn" style="padding:3px 8px;font-size:10px;" href="${esc(url)}" target="_blank" download>⬇ 下载</a></div>`;
    }).join('');
  });
}
// 海运上传区：SO / BL 各一块。未传=虚线上传框；已传=绿框「已上传」+文件(预览/下载)+「点击更换/再传」
function renderUploadZones(){
  const soZone = $('uzSO'), blZone = $('uzBL'); if(!soZone && !blZone) return;
  const fu = window._fileURL || (()=>'#');
  const isSO = fn => /SO舱单|入货|排载|配舱|舱单|订舱确认|manifest|放箱|(^|[^A-Z])S\/?O([^A-Z]|$)/i.test(_upClean(fn)) || /SO舱单/.test(String(fn||''));
  const ocean = uploads.filter(u=>_upInSeg(u.filename,'ocean'));
  const soFiles = ocean.filter(u=>isSO(u.filename));
  const blFiles = ocean.filter(u=>!soFiles.includes(u));
  const fileRow = u => { const url=fu('upload',u.stored); return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--line);">
      <span>📄</span><span style="flex:1;font-weight:700;font-size:11px;overflow-wrap:anywhere;color:var(--ink);">${esc(_upClean(u.filename))}</span>
      <a class="doc-btn" style="background:var(--goodbg);color:var(--good);border-color:color-mix(in srgb,var(--good) 40%,var(--line));padding:3px 8px;font-size:10px;" href="${esc(url)}" target="_blank">✓ 已上传·预览</a>
      <a class="doc-btn" style="padding:3px 8px;font-size:10px;" href="${esc(url)}" target="_blank" download>⬇ 下载</a></div>`; };
  const zone = (label, files, pick) => files.length
    ? `<div style="border:1.5px solid color-mix(in srgb,var(--good) 45%,var(--line));background:var(--goodbg);border-radius:10px;overflow:hidden;">
         <div style="padding:8px 12px;display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:800;color:var(--good);">
           <span>✓ ${esc(label)} 已上传</span>
           <span onclick="${pick}" style="cursor:pointer;color:var(--accent);">↻ 点击更换 / 再传</span></div>
         ${files.map(fileRow).join('')}</div>`
    : `<div class="up-zone" onclick="${pick}" style="border-color:var(--accent);color:var(--accent);font-weight:700;">＋ 上传 ${esc(label)}</div>`;
  if (soZone) soZone.innerHTML = zone('SO 订舱确认', soFiles, 'pickFileSO()');
  if (blZone) blZone.innerHTML = zone('提单 B/L / BL草稿（≤8MB 可多次）', blFiles, "pickFile('ocean')");
}

function pickFile(zone){ upZone = zone; $('fileInput').click(); }
$('fileInput').addEventListener('change', async e=>{
  for(const f of e.target.files){
    if(f.size > 8*1024*1024){ toast(f.name+' 超过 8MB'); continue; }
    const b64 = await new Promise(res=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(f); });
    try{
      const r = await fetch(`${API}/upload`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token,filename:'['+upZone+']'+(typeof _cntrZone==='string'&&_cntrZone?('['+_cntrZone+']'):'')+f.name,mime:f.type,data_base64:b64})});
      const d = await r.json();
      if(!r.ok||!d.ok){ toast(f.name+' 上传失败: '+(d.error||'')); continue; }
      uploads.push(d.file); renderFiles(); toast('✓ '+f.name+' 已上传');
      if(upZone==='customs' && window._billingToken) setTimeout(()=>toast('别忘了确认本票报关费 → 上方按钮'), 1600);
    }catch(err){ toast(f.name+' 网络错误'); }
  }
  e.target.value='';
});

function entryFor(d){
  const sP = window._sheetP || {}; const fe = sP.factory_entry || {};
  const keys = Object.keys(fe);
  if(!keys.length) return null;
  const ords = (d.cargo||[]).map(x=>x.order_no).filter(Boolean);
  const facs = (Array.isArray(sP.orders)?sP.orders:[]).filter(o=>ords.includes(o.order_no)).map(o=>o.factory||'');
  for(const k of keys){ if(facs.some(f=>f.includes(k)||k.includes(f))) return fe[k]; }
  return fe['default'] || (keys.length===1 ? fe[keys[0]] : null);
}
function cargoLine(cg){
  if(!Array.isArray(cg)||!cg.length) return '<span style="color:var(--warn);">待工厂确认</span>';
  return cg.map(x=>{
    const parts=[x.name||x.order_no||'—'];
    if(x.cartons) parts.push(x.cartons+'箱');
    if(x.gw_kg) parts.push(Number(x.gw_kg).toLocaleString()+'kg');
    return esc(parts.join(' '));
  }).join(' ＋ ');
}
function quickText(i){
  const d = vehs[i]||{};
  const L=[];
  L.push(d.loading_address||'提货地见托书');
  if(gv('plate_'+i)) L.push('车号：'+gv('plate_'+i));
  if(d.trailer_plate) L.push('挂号：'+d.trailer_plate);
  if(gv('phone_'+i)) L.push('手机：'+gv('phone_'+i));
  if(gv('driver_'+i)) L.push('姓名：'+gv('driver_'+i));
  if(d.driver_id_no) L.push('证号：'+maskId(d.driver_id_no));
  if(d.cntr) L.push('箱号：'+d.cntr);
  if(d.seal_no) L.push('封号：'+d.seal_no);
  if(d.tare_kg) L.push('箱皮重：'+d.tare_kg+'kg');
  return L.join('\n');
}
function copyQuick(i){
  navigator.clipboard.writeText(quickText(i)).then(()=>toast('✓ 车'+(i+1)+' 派车信息已复制，微信直接粘贴'))
    .catch(()=>{ prompt('手动复制：', quickText(i)); });
}
function infoCell(label, val){
  return `<div style="font-size:11px;"><span style="color:var(--ink3);">${label}</span> <span style="font-weight:700;color:var(--ink);">${esc(val||'—')}</span></div>`;
}
function vehHtml(i, d={}){
  return `<div class="ctn-group"><div class="ctn-group-head">
    <div class="ctn-group-title" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">🚛 车 ${i+1}${((d.cargo||[]).reduce((s,x)=>s+(Number(x.gw_kg)||0),0)>25000)?`<span style="background:var(--badbg);color:var(--bad);border:1px solid color-mix(in srgb,var(--bad) 40%,var(--line));border-radius:4px;padding:1px 7px;font-size:10px;font-weight:800;">⚠️超重柜>25T·订舱需备注</span>`:''}
      <span style="color:var(--ink3);font-weight:400;font-size:10px;">箱号</span>
      <input id="cntr_${i}" value="${esc(d.cntr)}" placeholder="点击填写" style="border:none;border-bottom:1.5px dashed var(--ink3);background:transparent;font-size:12px;font-weight:800;color:var(--ink);width:118px;outline:none;font-family:monospace;text-transform:uppercase;">
      <span style="color:var(--ink3);font-weight:400;font-size:10px;">封号</span>
      <input id="seal_${i}" value="${esc(d.seal_no)}" placeholder="点击填写" style="border:none;border-bottom:1.5px dashed var(--ink3);background:transparent;font-size:12px;font-weight:800;color:var(--ink);width:108px;outline:none;font-family:monospace;text-transform:uppercase;">
    </div>
    <div style="display:flex;gap:10px;align-items:center;">
      <span style="cursor:pointer;color:#fff;background:var(--accent);font-size:14px;font-weight:800;padding:6px 14px;border-radius:8px;box-shadow:0 1px 2px rgba(26,115,232,.3);" onclick="openQuickFill(${i})">📋 快捷填写</span>
      <span style="cursor:pointer;color:var(--ink3);font-size:11px;" onclick="copyQuick(${i})" title="复制派车信息文本">复制</span>
      ${vehs.length>1?`<span style="cursor:pointer;color:var(--bad);font-size:11px;font-weight:700;" onclick="delVeh(${i})">× 删除</span>`:''}
    </div></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 12px;background:var(--surface2);border-radius:8px;margin:8px 12px 0;padding:10px 12px;">
      <div style="grid-column:1/-1;font-size:11px;"><span style="color:var(--ink3);">提货地</span> <span style="font-weight:700;color:var(--ink);">${esc(d.loading_address||'—')}</span></div>
      ${infoCell('挂号', d.trailer_plate)}
      ${infoCell('证号', maskId(d.driver_id_no))}
      ${infoCell('箱皮重', d.tare_kg?d.tare_kg+'kg':'')}
      ${(c2=>{const t=String(c2||'');const ph=(t.match(/1\d{10}/)||[''])[0];const nm=t.replace(ph,'').replace(/[:：\s]+$/,'').trim();
        return infoCell('工厂联系人', nm) + (ph?`<div style="font-size:11px;"><span style="color:var(--ink3);">工厂电话</span> <a href="tel:${ph}" style="font-weight:700;color:var(--accent);">${ph}</a></div>`:infoCell('工厂电话',''));})(d.loading_contact)}
      <div style="grid-column:1/-1;font-size:11px;"><span style="color:var(--ink3);">货品</span> <span style="font-weight:700;color:var(--ink);">${cargoLine(d.cargo)}</span></div>
      ${(()=>{const er=entryFor(d);if(!er)return '';
        const qr=(Array.isArray((window._sheetP||{}).collab_uploads)?window._sheetP.collab_uploads:[]).find(u=>/入厂|二维码|考试/.test(u.filename||''));
        return `<div style="grid-column:1/-1;font-size:11px;background:var(--surface)beb;border:1px solid color-mix(in srgb,var(--warn) 40%,var(--line));border-radius:6px;padding:6px 10px;">
          <span style="color:var(--warn);font-weight:800;">🏭 入厂要求</span>
          ${er.note?` <span style="color:var(--warn);">${esc(er.note)}</span>`:''}
          ${er.contact||er.phone?` · 厂内对接 <b>${esc(er.contact||'')}</b>${er.phone?` <a href="tel:${esc(er.phone)}" style="color:var(--accent);font-weight:700;">${esc(er.phone)}</a>`:''}`:''}
          ${er.exam_url?` · <a href="${esc(er.exam_url)}" target="_blank" style="color:var(--accent);font-weight:700;">📝 入厂考试/扫码 ↗</a>`:''}
          ${qr&&window._fileURL?` · <a href="${window._fileURL('upload', qr.stored)}" target="_blank" style="color:var(--accent);font-weight:700;">🔲 二维码图片</a>`:''}
        </div>`;})()}
    </div>
    <div style="padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-field" style="margin:0;"><label class="form-label">车牌号 *</label>
        <input class="form-input" id="plate_${i}" value="${esc(d.plate)}" placeholder="例：闽D12345"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">司机姓名</label>
        <input class="form-input" id="driver_${i}" value="${esc(d.driver)}"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">司机电话 *</label>
        <input class="form-input" id="phone_${i}" type="tel" value="${esc(d.driver_phone)}"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">提箱时间</label>
        <input class="form-input" id="pickup_${i}" type="datetime-local" value="${esc(d.pickup_time)}"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">装柜时间 <span style="font-weight:400;color:var(--ink3);">(工厂已选则跟随，不合适打工厂电话)</span></label>
        <input class="form-input" id="loadtime_${i}" type="datetime-local" value="${esc(d.loading_time)}"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">过磅重(kg) <span style="font-weight:400;color:var(--ink3);">(磅单整车重-车重，对不上会预警)</span></label>
        <input class="form-input" id="weigh_${i}" type="number" step="0.01" value="${esc(d.weigh_kg||'')}" placeholder="磅单读数"></div>
    </div>
    <div class="up-zone" style="margin:0 12px 12px;" onclick="pickFileCntr('${esc(d.cntr||('车'+(i+1)))}')">📷 本柜 装柜照 / 磅单 / EIR</div>
  </div>`;
}
function openQuickFill(i){ _qfIdx = i; $('qfText').value=''; $('qfModal').style.display='block'; $('qfText').focus(); }
function parseQuickFill(){
  const t = $('qfText').value || '';
  const pick = (re) => { const m = t.match(re); return m ? m[1].trim() : ''; };
  const got = {
    plate: pick(/车号[:：\s]*([^\s\n]+)/),
    trailer: pick(/挂号?[:：\s]*([^\s\n]+)/),
    phone: pick(/(?:手机|电话)[:：\s]*(1\d{10})/),
    name: pick(/姓名[:：\s]*([^\s\n]+)/),
    idno: pick(/证号[:：\s]*(\d{15,17}[\dXx])/),
    cntr: pick(/箱号[:：\s]*([A-Z]{4}\d{7})/i),
    seal: pick(/封号[:：\s]*([^\s\n]+)/),
    tare: pick(/箱?皮重[:：\s]*([\d.]+)/),
  };
  if(!got.plate && !got.phone){ toast('没解析出车号/电话，请检查格式'); return; }
  const i = _qfIdx;
  if(got.plate) { const el=$('plate_'+i); if(el) el.value=got.plate; }
  if(got.name)  { const el=$('driver_'+i); if(el) el.value=got.name; }
  if(got.phone) { const el=$('phone_'+i); if(el) el.value=got.phone; }
  snapV();
  const v = vehs[i]||{};
  if(got.trailer) v.trailer_plate=got.trailer;
  if(got.idno) v.driver_id_no=got.idno;
  if(got.seal && !v.seal_no) v.seal_no=got.seal;
  if(got.tare && !v.tare_kg) v.tare_kg=Number(got.tare);
  if(got.cntr && v.cntr && got.cntr.toUpperCase()!==String(v.cntr).toUpperCase()){
    toast('⚠️ 粘贴箱号 '+got.cntr+' 与本柜 '+v.cntr+' 不符，请核对！'); }
  else if(got.cntr && !v.cntr) v.cntr=got.cntr.toUpperCase();
  vehs[i]=v; renderVehs();
  $('qfModal').style.display='none';
  toast('✓ 已解析填入，确认后提交');
}
function pickFileCntr(cntr){ _cntrZone = cntr; pickFile('truck'); }
function pickFileSO(){ _cntrZone = 'SO舱单'; pickFile('ocean'); }
function snapV(){ vehs = vehs.map((v,i)=>$('plate_'+i)!==null?{...v,plate:gv('plate_'+i),driver:gv('driver_'+i),driver_phone:gv('phone_'+i),pickup_time:gv('pickup_'+i),loading_time:gv('loadtime_'+i)||v.loading_time||'',cntr:(gv('cntr_'+i)||'').toUpperCase()||v.cntr||'',seal_no:(gv('seal_'+i)||'').toUpperCase()||v.seal_no||'',weigh_kg:gv('weigh_'+i)||v.weigh_kg||''}:v); }
function renderVehs(){ $('vehGroups').innerHTML = vehs.map((v,i)=>vehHtml(i,v)).join(''); }
function addVeh(){ vehs.push({}); renderVehs(); }
function delVeh(i){ snapV(); vehs.splice(i,1); if(!vehs.length) vehs.push({}); renderVehs(); }
function setSaveStatus(txt, color){ const el=$('vehSaveStatus'); if(el){ el.textContent=txt; el.style.color=color||'var(--ink3)'; } }
async function saveVeh(opts){
  const silent = opts && opts.silent;
  snapV();
  const vehicles = vehs.filter(v=>v.plate||v.driver_phone);
  if(!vehicles.length){ if(!silent) toast('至少一辆车需填车牌和司机电话'); return; }
  setSaveStatus('保存中…','var(--warn)');
  try{
    const r = await fetch(`${API}/trucking-submit`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token,vehicles,remarks:''})});
    const d = await r.json();
    if(!r.ok||!d.ok){ setSaveStatus('保存失败，请重试','var(--bad)'); if(!silent) toast(d.error||'保存失败'); return; }
    setSaveStatus('已自动保存 ✓','var(--good)');
    if(!silent) toast('✓ 车辆信息已保存');
  }catch(e){ setSaveStatus('网络错误，未保存','var(--bad)'); if(!silent) toast('网络错误'); }
}
function autoSaveVeh(){ clearTimeout(_autoSaveTimer); _autoSaveTimer=setTimeout(()=>saveVeh({silent:true}), 600); }
