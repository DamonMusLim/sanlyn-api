(function(){
  const API = "/api/db/booking-collab";
  let state = null;

  function injectStyle(){
    if(document.getElementById("collabTruckBlockStyle")) return;
    const style = document.createElement("style");
    style.id = "collabTruckBlockStyle";
    style.textContent = `.ctb input,.ctb select,.ctb textarea{background:var(--card,#fff);color:var(--ink,#111);border:1px solid var(--line,#c8cdd6)}.ctb input::placeholder,.ctb textarea::placeholder{color:var(--faint,#9ca3af)}.ctb input[type=file]{color:var(--sub,#6b7280)}/*__THEMED__*/
.ctb .card{background:var(--card,#fff);border-radius:10px;border:1px solid var(--line,#e0e4ea);overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:14px}
.ctb .section{padding:14px 16px;border-bottom:1px solid #f0f2f5}.ctb .section:last-child{border-bottom:none}
.ctb .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ctb .form-field{margin-bottom:10px}
.ctb .form-label{font-size:11px;font-weight:700;color:var(--ink,#374151);margin-bottom:4px;display:block}.ctb .form-label .req{color:var(--err,#dc2626)}
.ctb .form-input{width:100%;border:1.5px solid #c8cdd6;border-radius:6px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;background:var(--card,#fff);color:var(--ink,#111)}
.ctb .form-input:focus{border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,.12)}.ctb textarea.form-input{resize:vertical;min-height:60px}
.ctb .btn{padding:7px 16px;border-radius:7px;border:none;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}.ctb .btn-green{background:#059669;color:#fff}.ctb .btn-ghost{background:var(--row,#f3f4f6);color:var(--ink,#374151);border:1px solid var(--line,#e0e4ea)}.ctb .btn-sm{padding:5px 12px;font-size:11px}.ctb .btn:disabled{opacity:.5;cursor:not-allowed}
.ctb .badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:800}.ctb .badge-red{background:#fee2e2;color:var(--err,#b91c1c);border:1px solid #fca5a5}
.ctb .step-card{background:var(--card,#fff);border-radius:10px;border:1px solid var(--line,#e0e4ea);margin-bottom:14px;overflow:hidden;transition:border-color .2s}.ctb .step-card.required{border-color:#fbbf24}.ctb .step-card.done{border-color:#86efac}
.ctb .step-head{padding:12px 16px;display:flex;align-items:center;justify-content:space-between;background:var(--card,#fff);border-bottom:1px solid #f0f2f5;transition:background .15s;user-select:none}.ctb .step-card.done .step-head{cursor:pointer}.ctb .step-card.done .step-head:hover{background:var(--row,#f8fafc)}
.ctb .step-num{width:26px;height:26px;border-radius:50%;background:#1a1d23;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0}.ctb .step-num.done{background:#059669}
.ctb .step-title{font-size:13px;font-weight:800;color:var(--ink,#1a1d23)}.ctb .step-sub{font-size:11px;color:var(--sub,#6b7280);margin-top:1px}.ctb .step-summary{display:none;font-size:11px;font-weight:700;color:var(--ok,#059669);flex:1;margin:0 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ctb .step-card.done .step-summary{display:block}.ctb .step-card.done .step-title{font-size:12px;color:var(--sub,#6b7280);font-weight:600}.ctb .step-card.done .step-sub{display:none}
.ctb .chevron{font-size:12px;color:var(--faint,#9ca3af);transition:transform .25s;flex-shrink:0}.ctb .step-card.done .chevron{transform:rotate(0deg)}.ctb .step-card:not(.done) .chevron{transform:rotate(180deg)}.ctb .step-body{overflow:hidden;transition:max-height .3s ease,opacity .3s ease}.ctb .step-card.done .step-body{max-height:0!important;opacity:0}.ctb .step-card:not(.done) .step-body{max-height:2000px;opacity:1}
.ctb .ctn-group{border:1.5px solid #e0e4ea;border-radius:8px;margin-bottom:10px;overflow:hidden}.ctb .ctn-group-head{background:var(--row,#f8fafc);padding:7px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e0e4ea}.ctb .ctn-group-title{font-size:11px;font-weight:800;color:var(--ink,#374151)}
.ctb .chip{background:var(--card,#fff);border:1px solid var(--line,#e0e4ea);border-radius:8px;padding:8px 14px;font-size:12px}.ctb .chip b{color:var(--ink,#1a1d23)}.ctb .chip span{color:var(--sub,#6b7280)}.ctb .qty-btn{border:1px solid var(--line,#c8cdd6);background:var(--card,#fff);border-radius:5px;width:24px;height:24px;font-weight:800;cursor:pointer}.ctb .qty-in{width:42px;border:1px solid var(--line,#c8cdd6);border-radius:5px;padding:4px;text-align:center;font-weight:800}
.ctb .photo-grid{display:flex;flex-wrap:wrap;gap:6px;padding:8px;background:#fafafa;border:1px solid #eef2f7;border-radius:8px}.ctb .photo-cell{position:relative;width:58px;height:58px;border-radius:6px;overflow:hidden;border:1px solid var(--line,#e0e4ea);background:#f1f5f9;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:10px;color:var(--sub,#64748b);text-align:center}.ctb .photo-cell img{width:100%;height:100%;object-fit:cover}.ctb .photo-cell.add{border-style:dashed;border-color:#cbd5e1}.ctb .photo-cell .del-btn{position:absolute;top:1px;right:1px;width:16px;height:16px;background:#dc2626;color:#fff;border-radius:50%;font-size:11px;font-weight:800;line-height:16px}
.ctb .save-status{text-align:center;font-size:11px;color:var(--faint,#9ca3af);margin:8px 0 14px}@media(max-width:480px){.ctb .grid2,.ctb .veh-grid{grid-template-columns:1fr!important}}
`;
    document.head.appendChild(style);
  }
  function $(id){ return state.root.querySelector("#" + id); }
  function gv(id){ return ($(id)?.value || "").trim(); }
  function esc(v){ return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  function firstVal(objs, keys){ for(const o of objs){ if(!o) continue; for(const k of keys){ if(o[k] != null && String(o[k]).trim() !== "") return o[k]; } } return ""; }
  function dtLocal(v){
    if(!v) return "";
    const d = new Date(v);
    if(Number.isNaN(d.getTime())) return "";
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function itemText(item){ return item && firstVal([item],["description","product_name","cn_name","product_cn_name","chinese_name","goods_name","name"]); }
  function cargoDesc(s,d){
    const direct = firstVal([s,d],["cargo_description_cn","cargo_description","goods_description","product_name","品名","中文品名"]);
    if(direct) return direct;
    const orders = [...(Array.isArray(s.orders)?s.orders:[]), ...(Array.isArray(d.orders)?d.orders:[])], names = [];
    orders.forEach(o => (Array.isArray(o.items)?o.items:[]).forEach(it => { const v = itemText(it); if(v && !names.includes(v)) names.push(v); }));
    return names.join(" / ");
  }
  function normQty(v){ v = parseInt(v,10); return isNaN(v) || v < 1 ? 1 : Math.min(v,30); }
  function qtyChip(){ return `<div class="chip" style="display:flex;align-items:center;gap:6px;margin-bottom:14px"><span>柜型 × 柜量 </span><b>${esc(state.ctnType || "—")} ×</b><button class="qty-btn" onclick="CollabTruckBlock.setQty(CollabTruckBlock.ctnQty()-1)">−</button><input class="qty-in" id="ctn_qty" type="number" min="1" max="30" value="${state.ctnQty}" onchange="CollabTruckBlock.setQty(this.value)"><button class="qty-btn" onclick="CollabTruckBlock.setQty(CollabTruckBlock.ctnQty()+1)">＋</button></div>`; }
  function photoUrl(p){ return p.preview || p.url || (p.stored ? `${API}/file?token=${encodeURIComponent(state.token)}&type=upload&ref=${encodeURIComponent(p.stored)}` : ""); }
  function photoGrid(i,ps){ ps = ps || []; return ps.map((p,j)=>{ const u = photoUrl(p), img = (p.mime || "").startsWith("image"); return `<div class="photo-cell">${img && u ? `<img src="${esc(u)}" alt="">` : "📄<br>" + esc(p.filename || "文件")}<div class="del-btn" onclick="CollabTruckBlock.delPhoto(${i},${j})">×</div></div>`; }).join("") + `<div class="photo-cell add" onclick="CollabTruckBlock.pickPhoto(${i})"><div><div style="font-size:18px;">＋</div>照片/磅单</div></div>`; }
  function vehHtml(i,d={}){
    const addr = firstVal([d],["loading_address","factory_loading_address","pickup_address","loading_addr","address"]);
    const contact = firstVal([d],["loading_contact","factory_loading_contact","contact","factory_contact"]);
    const loadingTime = firstVal([d],["loading_time","load_time","装柜时间"]);
    return `<div class="ctn-group" id="veh_${i}"><div class="ctn-group-head"><div class="ctn-group-title">🚛 车 ${i+1}</div>${state.vehs.length > 1 ? `<span style="cursor:pointer;color:var(--err,#dc2626);font-size:11px;font-weight:700;" onclick="CollabTruckBlock.delVeh(${i})">× 删除</span>` : ""}</div>
    <div class="veh-grid" style="padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-field" style="margin:0;"><label class="form-label">车牌号 <span class="req">*</span></label><input class="form-input" id="plate_${i}" value="${esc(d.plate)}" placeholder="例：闽D12345"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">司机姓名</label><input class="form-input" id="driver_${i}" value="${esc(d.driver)}" placeholder="司机姓名"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">司机电话 <span class="req">*</span></label><input class="form-input" id="phone_${i}" type="tel" value="${esc(d.driver_phone)}" placeholder="手机号"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">提箱时间</label><input class="form-input" id="pickup_${i}" type="datetime-local" value="${esc(dtLocal(d.pickup_time))}"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">装柜预约时间(工厂/车队可改)</label><input class="form-input" id="loading_time_${i}" type="datetime-local" value="${esc(dtLocal(loadingTime))}"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">工厂提货地址</label><div style="font-size:10.5px;color:${addr ? "#64748b" : "#94a3b8"};margin-bottom:4px;">📍 ${esc(addr || "提货地址待补")}</div><input class="form-input" id="loadaddr_${i}" value="${esc(addr)}" placeholder="📍 提货地址待补"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">工厂联系人</label><div style="font-size:10.5px;color:${contact ? "#64748b" : "#94a3b8"};margin-bottom:4px;">厂内联系人：${esc(contact || "待补")}</div><input class="form-input" id="loadcontact_${i}" value="${esc(contact)}" placeholder="厂内联系人待补"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">柜号 Container No.</label><input class="form-input" id="cntr_${i}" value="${esc(d.cntr)}" placeholder="例：OOLU1234567" style="text-transform:uppercase;"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">封号 Seal No.</label><input class="form-input" id="seal_${i}" value="${esc(d.seal_no)}" placeholder="铅封号" style="text-transform:uppercase;"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">过磅重 kg</label><input class="form-input" id="weigh_${i}" type="number" min="0" step="1" value="${esc(d.weigh_kg)}" placeholder="装柜后磅重(kg)"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">挂车牌</label><input class="form-input" id="trailer_${i}" value="${esc(d.trailer_plate)}" placeholder="挂车/拖架牌(选填)"></div>
    </div><div style="padding:0 12px 12px;"><label class="form-label">装柜照 / 磅单（每车一组，传完即存）</label><div class="photo-grid">${photoGrid(i,d.photos)}</div><input type="file" id="photo_${i}" multiple accept="image/*,.pdf" style="display:none;" onchange="CollabTruckBlock.uploadVehPhoto(${i},this.files);this.value=''"></div></div>`;
  }
  function renderShell(){
    state.root.classList.add("ctb");
    state.root.innerHTML = `${qtyChip()}<div class="card"><div class="section" style="padding-bottom:4px;"><div class="step-title">装柜数据</div><div class="step-sub">供核对，可补录缺失项；VGM 按毛重自动计算</div></div><div class="section"><div class="grid2">
      <div class="form-field"><label class="form-label">总箱数</label><input class="form-input" id="cargo_cartons" type="number" min="0" step="1" placeholder="缺失可补录"></div>
      <div class="form-field"><label class="form-label">总 GW 毛重 kg</label><input class="form-input" id="cargo_gw" type="number" min="0" step="0.01" placeholder="缺失可补录"></div>
      <div class="form-field"><label class="form-label">总 CBM</label><input class="form-input" id="cargo_cbm" type="number" min="0" step="0.001" placeholder="缺失可补录"></div>
      <div class="form-field"><label class="form-label">VGM(t)</label><input class="form-input" id="cargo_vgm" readonly placeholder="按 GW 自动计算"></div>
    </div><div class="form-field" style="margin-bottom:0;"><label class="form-label">中文品名货描</label><textarea class="form-input" id="cargo_desc" rows="2" placeholder="缺失可补录"></textarea></div></div></div>
    <div class="step-card required" id="step1"><div class="step-head" onclick="CollabTruckBlock.toggleStep()"><div style="display:flex;align-items:center;gap:10px;min-width:0;"><div class="step-num" id="sn1">🚛</div><div style="min-width:0;"><div class="step-title">车辆 & 司机 / Vehicles</div><div class="step-sub">每辆车一层 · 装柜后回填柜号/封号/磅重 · 提交后收起，点击可展开修改</div></div></div><div style="display:flex;align-items:center;gap:8px;flex-shrink:0;"><div class="step-summary" id="sum1"></div><div class="badge badge-red" id="badge1">必填</div><span class="chevron">▼</span></div></div><div class="step-body"><div class="section"><div id="vehGroups"></div><div style="display:flex;gap:10px;align-items:center;margin-top:4px;"><button class="btn btn-ghost btn-sm" onclick="CollabTruckBlock.addVeh()">＋ 添加一辆车</button><button class="btn btn-green btn-sm" id="btnSubmit" onclick="CollabTruckBlock.save(true)" style="margin-left:auto;">🚛 提交车辆信息</button></div><textarea class="form-input" id="remarks" rows="2" placeholder="换车 / 进港预约 / 特殊情况说明…" style="margin-top:10px;"></textarea></div></div></div><div class="save-status" id="saveStatus">上传与提交即自动保存</div>`;
  }
  function renderCargo(){
    const s = state.sheet, d = state.data, td = state.td;
    $("cargo_cartons").value = firstVal([s,d,td],["total_cartons","cartons","package_count"]);
    $("cargo_gw").value = firstVal([s,d,td],["gross_weight_kg","total_gw_kg","gw_kg"]);
    const cbm = firstVal([s,d,td],["total_cbm","cbm"]);
    $("cargo_cbm").value = cbm !== "" && !isNaN(cbm) ? Math.round(Number(cbm)*1000)/1000 : cbm;
    $("cargo_desc").value = cargoDesc(s,d);
    calcVgm();
  }
  function calcVgm(){ const gw = parseFloat(gv("cargo_gw")); $("cargo_vgm").value = gw >= 0 ? ((gw/1000)+2.2).toFixed(3).replace(/\.?0+$/,"") : ""; }
  function cargoPayload(){ return { total_cartons:gv("cargo_cartons"), gross_weight_kg:gv("cargo_gw"), total_cbm:gv("cargo_cbm"), vgm_t:gv("cargo_vgm"), cargo_description_cn:gv("cargo_desc"), container_qty:state.ctnQty }; }
  function snap(){ state.vehs = state.vehs.map((v,i) => $("veh_"+i) ? { plate:gv("plate_"+i), driver:gv("driver_"+i), driver_phone:gv("phone_"+i), pickup_time:gv("pickup_"+i), loading_time:gv("loading_time_"+i), loading_address:gv("loadaddr_"+i), loading_contact:gv("loadcontact_"+i), cntr:gv("cntr_"+i).toUpperCase(), seal_no:gv("seal_"+i).toUpperCase(), weigh_kg:gv("weigh_"+i), trailer_plate:gv("trailer_"+i), photos:v.photos || [] } : v); }
  function renderVehs(){ $("vehGroups").innerHTML = state.vehs.map((v,i)=>vehHtml(i,v)).join(""); bindAutosave(); }
  function collapseVeh(summary){ $("step1").classList.add("done"); $("step1").classList.remove("required"); $("sn1").classList.add("done"); $("sum1").textContent = "✓ " + summary; $("badge1").style.display = "none"; state.onSubmitted && state.onSubmitted(summary); }
  function bindAutosave(){ state.root.querySelectorAll("input,textarea").forEach(el => el.addEventListener("input", () => { if(el.id === "cargo_gw") calcVgm(); scheduleSave(); })); }
  function scheduleSave(){ clearTimeout(state.timer); state.timer = setTimeout(() => save(false), 900); }
  function setStatus(msg){ const el = $("saveStatus"); if(el) el.textContent = msg; }
  function photoPayload(ps){ return (ps || []).map(p => ({ filename:p.filename, mime:p.mime, stored:p.stored, uploaded_at:p.uploaded_at })); }
  async function save(manual){
    snap();
    const vehicles = state.vehs.map(v => ({ ...v, photos:photoPayload(v.photos) }));
    if(!vehicles.length || vehicles.find(v => !v.plate || !v.driver_phone)){ if(manual) state.toast("每辆车的车牌号和司机电话都要填"); else setStatus("待填写必填项"); return; }
    const btn = $("btnSubmit"); if(btn) btn.disabled = true; setStatus("正在自动保存...");
    try{
      const r = await fetch(`${API}/trucking-submit`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ token:state.token, vehicles, remarks:gv("remarks"), cargo_summary:cargoPayload() }) });
      const d = await r.json();
      if(btn) btn.disabled = false;
      if(!r.ok || !d.ok){ if(manual) state.toast(d.error || "提交失败"); setStatus("保存失败"); return; }
      collapseVeh(vehicles.length + " 辆车已提交 · " + vehicles.map(v=>v.plate).filter(Boolean).join(" / "));
      setStatus("已自动保存 ✓");
      if(Array.isArray(d.cb_warnings) && d.cb_warnings.length){ state.toast("已提交，但有柜号需要核对"); } else if(manual){ state.toast("✓ 已提交，可继续上传装柜照片"); }
    }catch(e){ if(btn) btn.disabled = false; if(manual) state.toast("网络错误，请重试"); setStatus("保存失败"); }
  }
  function mount(el, opts){
    injectStyle();
    const s = opts.sheet || {}, td = s.trucking_detail || {};
    state = { root:el, token:opts.token || "", sheet:s, data:opts.data || {}, td, toast:opts.toast || function(){}, onSubmitted:opts.onSubmitted, ctnType:s.container_type || "", ctnQty:normQty(firstVal([td.cargo_summary || {},td,s,opts.data],["container_qty"]) || 1), vehs:[] };
    renderShell(); renderCargo();
    const saved = Array.isArray(td.vehicles) ? td.vehicles : (td.plate ? [{ plate:td.plate, driver:td.driver, driver_phone:td.driver_phone, pickup_time:td.pickup_time, loading_time:td.loading_time }] : []);
    state.vehs = saved.length ? saved.map(v => ({ plate:v.plate || "", driver:v.driver || v.driver_name || "", driver_phone:v.driver_phone || "", pickup_time:v.pickup_time || "", loading_time:firstVal([v],["loading_time","load_time","装柜时间"]), loading_address:firstVal([v],["loading_address","factory_loading_address","pickup_address","loading_addr","address"]), loading_contact:firstVal([v],["loading_contact","factory_loading_contact","contact","factory_contact"]), cntr:v.cntr || v.container_no || "", seal_no:v.seal_no || "", weigh_kg:v.weigh_kg || "", trailer_plate:v.trailer_plate || "", photos:Array.isArray(v.photos)?v.photos:[] })) : [];
    while(state.vehs.length < state.ctnQty) state.vehs.push({ photos:[] });
    if(state.vehs.length > state.ctnQty) state.vehs.length = state.ctnQty;
    renderVehs();
    if(td.remarks) $("remarks").value = td.remarks;
    if(saved.length && td.source === "trucking_booking_link") collapseVeh(state.vehs.length + " 辆车已提交 · " + state.vehs.map(v=>v.plate).filter(Boolean).join(" / "));
  }
  window.CollabTruckBlock = {
    mount, ctnQty:()=>state.ctnQty, toggleStep(){ const c = $("step1"); if(c.classList.contains("done")){ c.classList.remove("done"); $("sn1").classList.remove("done"); } },
    setQty(v){ snap(); const cargo = cargoPayload(), remarks = gv("remarks"); state.ctnQty = normQty(v); if($("ctn_qty")) $("ctn_qty").value = state.ctnQty; while(state.vehs.length < state.ctnQty) state.vehs.push({ photos:[] }); if(state.vehs.length > state.ctnQty) state.vehs.length = state.ctnQty; renderShell(); renderCargo(); $("cargo_cartons").value = cargo.total_cartons; $("cargo_gw").value = cargo.gross_weight_kg; $("cargo_cbm").value = cargo.total_cbm; $("cargo_desc").value = cargo.cargo_description_cn; calcVgm(); $("remarks").value = remarks; renderVehs(); scheduleSave(); },
    addVeh(){ this.setQty(state.ctnQty + 1); }, delVeh(i){ snap(); state.vehs.splice(i,1); this.setQty(state.vehs.length); },
    delPhoto(i,j){ snap(); state.vehs[i].photos.splice(j,1); renderVehs(); scheduleSave(); }, pickPhoto(i){ $("photo_"+i).click(); },
    async uploadVehPhoto(i,files){ snap(); let ok = 0; for(const f of files){ if(f.size > 8*1024*1024){ state.toast(f.name + " 超过 8MB"); continue; } const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); }); try{ const r = await fetch(`${API}/upload`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ token:state.token, filename:`[车${i+1}]` + f.name, mime:f.type, data_base64:b64 }) }); const d = await r.json(); if(!r.ok || !d.ok){ state.toast(f.name + " 上传失败"); continue; } (state.vehs[i].photos = state.vehs[i].photos || []).push({ filename:f.name, mime:f.type, stored:d.file && d.file.stored, uploaded_at:d.file && d.file.uploaded_at, preview:b64 }); ok++; }catch(e){ state.toast(f.name + " 网络错误"); } } if(ok){ renderVehs(); state.toast("✓ 车 " + (i+1) + " 已上传 " + ok + " 份"); save(false); } },
    save
  };
})();
