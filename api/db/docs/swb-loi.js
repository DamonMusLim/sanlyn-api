// SEA WAYBILL 海运单保函 (SWB LOI) — 按 Damon 认可样本 LOI-PETSOME/ENRICH (OOCL 表格 OCHLCSU 08/21)。
// 数据驱动：出货人=issuing_company(cfg3) / 收货人=order.customer / 致=carrier.loi_recipient / 章=出货人公章。
// documents.js 以 type=swb_loi 调用，并在 ctx 里备好 consignee/consAddr/carrierTo/formRef。
export async function renderSwbLoi(ctx){
  let { sp, spraw, cfg3, consignee, consAddr, carrierTo, formRef, vessel, voyage, polSp, podSp, html, _xlsCapture, totRow, ap, esc, pick, fmtD } = ctx;

  const blNo   = pick(sp.bl_no, spraw.blNo, spraw.bl_no, "");
  const vsv    = [pick(vessel, sp.vessel, ""), pick(voyage, sp.voyage, "")].filter(Boolean).join(" ");
  const podFnd = [pick(polSp, sp.pol, ""), pick(podSp, sp.pod, "")].filter(Boolean).join(" / ");
  const shipperName = pick(ctx.shipperName, cfg3.nameEN, cfg3.nameCN, "");   // 出货人=issuing_company（非货代 cfg3）
  const shipperAddr = pick(ctx.shipperAddrEn, ctx.shipperAddr, cfg3.address, "");   // 抬头用英文地址(address_en)
  const signer = pick(ctx.signerName, "");   // 授权签字人（手写体签名）
  const to = pick(carrierTo, sp.shipping_line, "___________________________");
  const cnee = pick(consignee, "[CONSIGNEE]");
  const dateStr = (function(){ try{ const d=new Date(); return d.getFullYear()+" "+(d.getMonth()+1)+"/"+d.getDate(); }catch(e){ return ""; } })();

  const CSS = `<style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Arial','Helvetica','PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7;color:#000;padding:44px;background:#f0f0f0;}
    .page{max-width:820px;margin:auto;background:#fff;padding:48px 54px;position:relative;}
    .co{text-align:center;} .co h1{font-size:16px;font-weight:800;letter-spacing:.5px;} .co p{font-size:12px;margin-top:2px;}
    .to{margin:22px 0 6px;font-size:13px;}
    .title{text-align:center;font-size:20px;font-weight:800;letter-spacing:2px;margin:14px 0 20px;}
    .lead{font-size:13px;margin-bottom:12px;}
    .kv{width:100%;font-size:13px;margin-bottom:18px;border-collapse:collapse;}
    .kv td{padding:4px 0;vertical-align:top;} .kv .k{font-weight:800;width:130px;white-space:nowrap;} .kv .addr{color:#222;padding-left:130px;}
    .clauses{font-size:13px;text-align:justify;}
    .clauses p{margin:9px 0;} .clauses .n{padding-left:0;}
    .sig{margin-top:40px;font-size:13px;position:relative;min-height:150px;}
    .sig .row{margin-bottom:26px;}
    .stamp{position:absolute;right:30px;bottom:6px;width:150px;height:150px;}
    .stamp img{width:100%;height:100%;object-fit:contain;}
    .stamp.ph{border:1px dashed #bbb;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:11px;text-align:center;line-height:1.5;}
    .sign-hw{font-family:'Snell Roundhand','Brush Script MT','Segoe Script',cursive;font-style:italic;font-size:28px;color:#16305c;margin:0 0 2px 6px;}
    .foot{border-top:1px solid #000;margin-top:34px;padding-top:6px;font-size:11px;}
    .foot .ref{color:#666;font-size:10px;}
    @media print{body{background:#fff;padding:0;}.page{max-width:100%;box-shadow:none;}}
  </style>`;

  const _rot = (typeof ctx.sealRotDeg === 'number') ? ctx.sealRotDeg : 0;   // 印章随机倾斜(DAS ±10°)
  const _jit = (Math.random() * 10 - 5);                                     // 上下抖动
  const stampBox = ctx.stampUrl
    ? `<div class="stamp" style="transform:rotate(${_rot.toFixed(1)}deg) translateY(${_jit.toFixed(1)}px);"><img src="${esc(ctx.stampUrl)}" alt="seal"></div>`
    : `<div class="stamp ph">此处加盖公章<br>(Company Stamp)</div>`;

  html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><title>海运单保函 SEA WAYBILL LOI — ${esc(blNo)}</title>${CSS}${ap?'<script>window.onload=function(){window.print()}<\/script>':""}</head><body><div class="page">
    <div class="co"><h1>${esc(shipperName)}</h1><p>${esc(shipperAddr)}</p></div>
    <div class="to">致 (To)：${esc(to)}</div>
    <div class="title">SEA WAYBILL 海运单保函</div>
    <div class="lead">就以下所述货物：</div>
    <table class="kv">
      <tr><td class="k">VSL/VOY:</td><td>${esc(vsv)||"&nbsp;"}</td></tr>
      <tr><td class="k">B/L NO:</td><td>${esc(blNo)||"&nbsp;"}</td></tr>
      <tr><td class="k">POD/FND:</td><td>${esc(podFnd)||"&nbsp;"}</td></tr>
      <tr><td class="k">SHIPPER:</td><td>${esc(shipperName)}</td></tr>
      <tr><td class="k">CNEE:</td><td><b>${esc(cnee)}</b></td></tr>
      ${consAddr?`<tr><td></td><td class="addr" style="padding-left:0;">${esc(consAddr)}</td></tr>`:""}
    </table>
    <div class="clauses">
      <p>我司在此向贵司申请，要求就该货物签发海运单，并同意贵司仅凭相关身份证证明即可将该货物放给海运单上记载的收货人，因此产生的一切风险、责任和损失将由我司承担，包括但不限于：</p>
      <p class="n">我司赔偿并承担贵司以及贵公司雇员或代理因此承担的一切责任和遭受的一切损失。</p>
      <p class="n">如贵公司因此被卷入诉讼、仲裁或者其他司法程序，我司负责提供充分、及时的法律费用，其中包括律师费、司法费用、差旅费以及其他相关费用。</p>
      <p class="n">如贵公司的船舶或者其他财产因此遭受扣押、滞留、查封、冻结或类似行为，或者受到此种威胁，我司保证及时为贵公司提供所需的担保金或者其他形式的有效担保，以保障贵公司的权益不受损害；此外，不论前述扣押、滞留等。</p>
      <p class="n">我司在收到贵公司的损失及费用清单后30天内，保证偿清贵司所有损失和费用。</p>
      <p class="n">本保函应根据中国有关法律进行解释，任何与本保函有关的纠纷均应提交中华人民共和国有管辖权的海事法院解决。</p>
    </div>
    <div class="sig">
      <div class="row">发货人签字 (公司盖章)${ctx.sigDataUri?`<img src="${esc(ctx.sigDataUri)}" alt="sig" style="height:44px;vertical-align:middle;margin-left:4px;">`:(signer?`<span class="sign-hw">${esc(signer)}</span>`:"")}</div>
      <div class="row">货运代理人盖章 (FORWARDER'S STAMP)</div>
      <div class="row">日期 (DATE)　${esc(dateStr)}</div>
      ${stampBox}
    </div>
    <div class="foot">${formRef?`<span class="ref">${esc(formRef)}</span>`:"&nbsp;"}</div>
  </div></body></html>`;

  return { html, _xlsCapture, totRow };
}
