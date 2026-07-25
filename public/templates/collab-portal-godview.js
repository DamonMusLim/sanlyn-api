(function(){
  let lastCtx = null;
  let linkMessage = null;
  let freightSaleEditing = false;
  const vendorDefs = {
    ocean: { label: '海运货代' },
    truck: { label: '车队' },
    customs: { label: '报关行' },
  };
  function money(n, currency){
    if(n == null || n === '') return '-';
    const num = Number(n);
    if(!Number.isFinite(num)) return '-';
    return (currency ? currency + ' ' : '') + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function num(n, suffix){
    const v = Number(n || 0);
    return v ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) + (suffix || '') : '-';
  }
  function labelLoading(v){
    if(v === true || v === 'done' || v === 'yes') return '<span class="badge badge-green">已装货</span>';
    if(v && typeof v === 'object') return '<span class="badge badge-blue">有装货记录</span>';
    return '<span class="badge badge-amber">待确认</span>';
  }
  function card(title, sub, body, icon, headerRight){
    return '<div class="step-card"><div class="step-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">'
      + '<div style="display:flex;align-items:center;gap:10px;min-width:0;">'
      + '<div class="step-num">' + icon + '</div><div><div class="step-title">' + title + '</div>'
      + '<div class="step-sub">' + sub + '</div></div></div>'
      + (headerRight ? '<div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;min-width:220px;">' + headerRight + '</div>' : '')
      + '</div>'
      + '<div class="step-body" style="max-height:none !important;opacity:1 !important;"><div class="section">' + body + '</div></div></div>';
  }
  function table(headers, rows){
    return '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:11px;">'
      + '<tr style="background:#f9fafb;color:#6b7280;">'
      + headers.map(h => '<th style="padding:7px 8px;text-align:left;border-bottom:1px solid #e5e7eb;white-space:nowrap;">' + h + '</th>').join('')
      + '</tr>' + rows.join('') + '</table></div>';
  }
  function safeFetch(url){
    return fetch(url).then(r => r.json().catch(() => ({})).then(d => ({ ok:r.ok, data:d })))
      .catch(e => ({ ok:false, data:{ error:e.message || '网络错误' } }));
  }
  function postJson(url, body){
    return fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) })
      .then(r => r.json().catch(() => ({})).then(d => ({ ok:r.ok, data:d })))
      .catch(e => ({ ok:false, data:{ error:e.message || '网络错误' } }));
  }
  function getContainers(s){
    return Array.isArray(s.containers_detail) ? s.containers_detail
      : Array.isArray(s.containers_live) ? s.containers_live
      : Array.isArray(s.containers) ? s.containers : [];
  }
  function vendorName(s, seg){
    if(seg === 'ocean') return s.forwarder_cn || s.forwarder || s.ocean_forwarder_cn || '未指派';
    if(seg === 'truck') return s.trucking_company_cn || s.trucking_company || '未指派';
    return s.customs_broker_cn || s.customs_broker || '未指派';
  }
  function assignedVendorName(s, seg){
    if(seg === 'ocean') return s.forwarder_cn || '';
    if(seg === 'truck') return s.trucking_company_cn || '';
    return s.customs_broker_cn || '';
  }
  function carrierPanel(s, esc, canEdit, invoiceData){
    const segs = ['ocean','truck','customs'];
    const parties = invoiceParties(invoiceData);
    const rows = segs.map(seg => '<div class="chip" style="align-items:flex-start;gap:8px;justify-content:space-between;">'
      + '<span><span>' + esc(vendorDefs[seg].label) + ' </span><b>' + esc(vendorName(s, seg)) + '</b></span>'
      + (seg === 'customs' ? '<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">' + invoiceControls(parties.customs, 'customs', false, true, '进项票 →') + '</span>' : '')
      + (canEdit ? '<button type="button" onclick="CollabPortalGodview.pickVendor(\'' + seg + '\')" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:800;cursor:pointer;">选择/更换</button>' : '')
      + '<div id="vendorPick-' + seg + '" style="flex-basis:100%;width:100%;"></div></div>');
    rows.push('<div class="chip"><span>工厂 </span><b>' + esc((Array.isArray(s.factory_names) ? s.factory_names.join(' / ') : '') || s.factory_cn || s.factory || '未指派') + '</b></div>');
    const msg = linkMessage ? '<div style="margin-top:10px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:8px;padding:8px 10px;font-size:12px;color:#1d4ed8;">'
      + '<b>' + esc(linkMessage.label) + '新子链：</b> <a href="' + esc(linkMessage.url) + '" target="_blank" style="color:#1a73e8;font-weight:800;word-break:break-all;">' + esc(linkMessage.url) + '</a></div>' : '';
    return '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">' + rows.join('') + '</div>' + msg;
  }
  function invoiceButton(seg, label){
    return '<button type="button" onclick="CollabPortalGodview.openInvoiceParty(\'' + seg + '\')" style="border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:6px;padding:5px 9px;font-size:11px;font-weight:800;cursor:pointer;white-space:nowrap;">' + label + '</button>';
  }
  function invoiceParties(invoiceData){
    return invoiceData && invoiceData.ok ? (invoiceData.parties || {}) : {};
  }
  function invoiceAmount(p){
    const cur = p.currency || 'CNY';
    if(cur === 'CNY' || cur === 'RMB') return '¥' + Number(p.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return money(p.amount || 0, cur);
  }
  function partyStatusBadge(p, isOut){
    const gray = t => '<span style="display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb;font-size:11px;font-weight:800;">' + t + '</span>';
    if(!p) return gray('读取中');
    if(p.assigned === false) return gray('工厂未指派');
    const done = isOut ? p.issued : p.received;
    if(done){
      return '<span class="badge badge-green">' + (isOut ? '✅销售票 ' : '✅进项票 ') + Number(p.count || 0) + '张·' + invoiceAmount(p) + '</span>';
    }
    if(isOut) return '<span style="display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;font-size:11px;font-weight:800;">⏳待开销售票</span>';
    return gray('⏳待收进项票');
  }
  function invoiceControls(p, seg, isOut, showAction, label){
    return partyStatusBadge(p || {}, isOut) + (showAction ? invoiceButton(seg, label) : '');
  }
  function headerTotalsChips(totals, type){
    if(!totals) return '';
    if(type === 'freight'){
      return Object.keys(totals).map(cur => {
        const t = totals[cur] || {};
        return '<div class="chip"><span>' + cur + ' 运费 </span><b>成本 ' + money(t.cost) + ' · 销售 ' + money(t.sales) + '</b></div>';
      }).join('');
    }
    return '<div class="chip"><span>货款 </span><b>采购 ' + money(totals.purchase) + ' · 销售 ' + money(totals.sales) + '</b></div>';
  }
  function truckingPriceHeader(pricing){
    if(!pricing || !pricing.ok) return '';
    const items = (Array.isArray(pricing.items) ? pricing.items : []).filter(i =>
      /拖车|车队|truck|trucking|trailer/i.test([i.cost_category, i.supplier].filter(Boolean).join(' '))
    );
    if(!items.length) return '';
    const totals = items.reduce((acc, i) => {
      const cur = i.currency || 'CNY';
      acc[cur] = acc[cur] || { cost:0, sales:0 };
      acc[cur].cost += Number(i.amount) || 0;
      acc[cur].sales += Number(i.sale_amount) || 0;
      return acc;
    }, {});
    return Object.keys(totals).map(cur => '<div class="chip"><span>' + cur + ' 拖车费 </span><b>成本 ' + money(totals[cur].cost) + ' · 销售 ' + money(totals[cur].sales) + '</b></div>').join('');
  }
  function loadingPanel(s, esc){
    const done = s.factory_loading_done && typeof s.factory_loading_done === 'object' ? s.factory_loading_done : {};
    const containers = getContainers(s);
    const doneRows = Object.keys(done).length ? Object.entries(done).map(([k,v]) =>
      '<tr><td style="padding:7px 8px;font-weight:700;">' + esc(k) + '</td><td style="padding:7px 8px;">' + labelLoading(v) + '</td></tr>').join('')
      : '<tr><td style="padding:7px 8px;color:#9ca3af;" colspan="2">暂无工厂装货确认</td></tr>';
    const cRows = containers.length ? containers.map((c,i) =>
      '<tr><td style="padding:7px 8px;font-weight:700;">' + esc(c.cntr || c.container_no || ('柜 ' + (c.seq || i + 1))) + '</td>'
      + '<td style="padding:7px 8px;">' + esc(c.seal_no || c.seal || '-') + '</td>'
      + '<td style="padding:7px 8px;">' + esc(c.plate || c.trailer_plate || '-') + '</td>'
      + '<td style="padding:7px 8px;">' + num(c.gw_kg || c.gross_weight_kg, ' kg') + '</td></tr>').join('')
      : '<tr><td style="padding:7px 8px;color:#9ca3af;" colspan="4">暂无柜明细</td></tr>';
    return '<div class="grid2"><div>' + table(['工厂','装货状态'], [doneRows])
      + '</div><div>' + table(['柜号','封号','车牌','毛重'], [cRows]) + '</div></div>';
  }
  function truckingLoadingPanel(s, esc){
    const containers = getContainers(s);
    const td = s.trucking_detail || {};
    const vehicles = Array.isArray(td.vehicles) ? td.vehicles : [];
    const rows = containers.length ? containers.map((c, i) => {
      const seq = c.seq || i + 1;
      const v = vehicles.find(x => String(x.cntr || '').toUpperCase() === String(c.cntr || c.container_no || '').toUpperCase())
        || vehicles.find(x => Number(x.seq) === Number(seq)) || {};
      const cntr = c.cntr || c.container_no || v.cntr || ('柜 ' + seq);
      const seal = c.seal_no || c.seal || v.seal_no || '-';
      const plate = c.plate || c.truck_plate || c.trailer_plate || v.plate || v.trailer_plate || '-';
      const gw = c.gw_kg || c.gross_weight_kg || c.vgm_weight_kg || v.weigh_kg;
      return '<tr><td style="padding:7px 8px;font-weight:700;">' + esc(cntr) + '</td>'
        + '<td style="padding:7px 8px;">' + esc(seal) + '</td>'
        + '<td style="padding:7px 8px;">' + esc(plate) + '</td>'
        + '<td style="padding:7px 8px;">' + num(gw, ' kg') + '</td></tr>';
    }) : ['<tr><td style="padding:7px 8px;color:#9ca3af;" colspan="4">暂无车队装货数据</td></tr>'];
    return table(['柜号','封号','车牌','毛重'], rows);
  }
  function freightPricingPanel(pricing, esc, canEdit){
    if(!pricing.ok) return '<div style="color:#b91c1c;font-size:12px;font-weight:700;">运费价格读取失败：' + esc(pricing.error || '无权访问') + '</div>';
    const items = Array.isArray(pricing.items) ? pricing.items : [];
    const canEditSale = canEdit && freightSaleEditing;
    const rows = items.length ? items.map(i => {
      const cur = i.currency || 'CNY';
      const profit = (Number(i.sale_amount) || 0) - (Number(i.amount) || 0);
      return '<tr><td style="padding:7px 8px;font-weight:700;">' + esc(i.cost_category || '-') + '</td>'
        + '<td style="padding:7px 8px;">' + esc(i.supplier || '-') + '</td>'
        + '<td style="padding:7px 8px;">' + money(i.amount, cur) + '</td>'
        + '<td style="padding:7px 8px;">' + (canEditSale ? '<input class="gv-sale-input" data-bill-id="' + esc(i.id) + '" type="number" min="0" step="0.01" value="' + esc(i.sale_amount == null ? '' : i.sale_amount) + '" style="width:110px;border:1px solid #d1d5db;border-radius:6px;padding:5px 7px;font-size:11px;font-family:inherit;">' : money(i.sale_amount, cur)) + '</td>'
        + '<td style="padding:7px 8px;font-weight:800;color:' + (profit >= 0 ? '#047857' : '#b91c1c') + ';">' + money(profit, cur) + '</td></tr>';
    }) : ['<tr><td style="padding:7px 8px;color:#9ca3af;" colspan="5">' + esc(pricing.note || '暂无运费价格明细') + '</td></tr>'];
    const actions = canEdit && items.length ? '<div style="margin:10px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
      + (freightSaleEditing
        ? '<button type="button" onclick="CollabPortalGodview.saveFreightPricing()" style="border:0;background:#1a73e8;color:#fff;border-radius:6px;padding:7px 12px;font-size:12px;font-weight:800;cursor:pointer;">保存销售价</button>'
          + '<button type="button" onclick="CollabPortalGodview.setFreightSaleEditing(false)" style="border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:6px;padding:7px 12px;font-size:12px;font-weight:800;cursor:pointer;">取消</button>'
        : '<button type="button" onclick="CollabPortalGodview.setFreightSaleEditing(true)" style="border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:6px;padding:7px 12px;font-size:12px;font-weight:800;cursor:pointer;">✏️ 编辑销售价</button>')
      + '<span id="gvPriceMsg" style="font-size:12px;color:#6b7280;"></span></div>' : '';
    return actions + table(['费用项','供应商','成本','销售价','毛利'], rows);
  }
  function orderPricingPanel(orderPricing, esc){
    if(!orderPricing.ok) return '<div style="color:#b91c1c;font-size:12px;font-weight:700;">订单价格读取失败：' + esc(orderPricing.error || '无权访问') + '</div>';
    const t = orderPricing.totals || {};
    const items = Array.isArray(orderPricing.items) ? orderPricing.items : [];
    const grouped = [];
    items.forEach(i => {
      const orderNo = i.order_no || '-';
      let group = grouped.find(g => g.orderNo === orderNo);
      if(!group){
        group = { orderNo, items: [] };
        grouped.push(group);
      }
      group.items.push(i);
    });
    const rows = grouped.length ? grouped.flatMap(group => [
      '<tr><td style="padding:8px;background:#f3f4f6;color:#111827;font-weight:900;border-top:1px solid #e5e7eb;" colspan="5">📄 订单 ' + esc(group.orderNo) + '</td></tr>',
      ...group.items.map(i => {
        const cur = i.currency || '';
        const product = [i.product_sku, i.product_name].filter(Boolean).join(' / ') || '-';
        return '<tr><td style="padding:7px 8px;">' + esc(product) + '</td>'
          + '<td style="padding:7px 8px;">' + num(i.quantity, ' ' + (i.unit || '')) + '</td>'
          + '<td style="padding:7px 8px;">' + money(i.purchase_total, cur) + '</td>'
          + '<td style="padding:7px 8px;">' + money(i.sales_total, cur) + '</td>'
          + '<td style="padding:7px 8px;font-weight:800;color:#047857;">' + money(i.gross_profit, cur) + '</td></tr>';
      })
    ]) : ['<tr><td style="padding:7px 8px;color:#9ca3af;" colspan="5">暂无订单价格明细</td></tr>'];
    return table(['SKU/品名','数量','采购价','销售价','毛利'], rows);
  }
  async function render(ctx){
    lastCtx = ctx;
    const s = ctx.sheet || {};
    const ps = ctx.portalScope || {};
    const esc = ctx.esc;
    const fmtD = ctx.fmtD;
    const $ = ctx.$;
    const canSeeOrderProfit = ps.field_profile === 'upstream_downstream';
    const canEditGodview = ps.field_profile === 'upstream_downstream';
    $('topBadge').textContent = s.shipment_no || '综合门户';
    $('bannerTitle').textContent = (s.shipment_no || '-') + ' - 综合视图' + (ps.company_label ? '（' + ps.company_label + '）' : '');
    $('bannerSub').textContent = '内部 godview · 三段承运方 / 工厂装货 / 成本销售毛利';
    $('chips').innerHTML = [
      s.pol || s.pod ? '<div class="chip"><span>航线 </span><b>' + esc(s.pol || '-') + ' -> ' + esc(s.pod || '-') + '</b></div>' : '',
      s.container_type ? '<div class="chip"><span>柜型 </span><b>' + esc(s.container_type) + (s.container_qty ? ' x ' + esc(s.container_qty) : '') + '</b></div>' : '',
      s.etd ? '<div class="chip"><span>ETD </span><b>' + esc(fmtD(s.etd)) + '</b></div>' : '',
      s.customer_name || s.customer_en ? '<div class="chip"><span>客户 </span><b>' + esc(s.customer_name || s.customer_en) + '</b></div>' : '',
    ].filter(Boolean).join('');
    $('segTabs').innerHTML = '<div class="seg-tab active">综合视图</div>';
    ['seg-ocean','seg-truck','seg-customs','billingCard'].forEach(id => { const el = $(id); if(el) el.classList.add('hidden'); });
    let root = $('godviewRoot');
    if(!root){
      root = document.createElement('div');
      root.id = 'godviewRoot';
      $('segTabs').parentNode.insertBefore(root, $('segTabs').nextSibling);
    }
    root.innerHTML = card('三段承运方', canEditGodview ? '可选择/更换承运方并生成子链' : '只展示已指派公司名', carrierPanel(s, esc, canEditGodview), '🏢')
      + card('工厂装货状态', '来自 booking_sheet.factory_loading_done / containers', loadingPanel(s, esc), '🏭')
      + card('车队装货', '自动读取同一柜明细/车队回填数据源', truckingLoadingPanel(s, esc), '🚛')
      + card('价格面板', '正在读取成本 / 销售价 / 毛利', '<div style="font-size:12px;color:#6b7280;">加载中...</div>', '💰');
    ctx.show('stateForm');
    const [invoiceRes, freightRes, orderRes] = await Promise.all([
      safeFetch(ctx.api + '/collab-party-invoices?token=' + encodeURIComponent(ctx.token)),
      safeFetch(ctx.api + '/collab-pricing?token=' + encodeURIComponent(ctx.token)),
      canSeeOrderProfit
        ? safeFetch(ctx.api + '/collab-order-pricing?token=' + encodeURIComponent(ctx.token))
        : Promise.resolve({ ok:true, data:{ ok:false, error:'shipping_booking 链不显示订单采购/销售毛利' } }),
    ]);
    const invoices = invoiceRes.data || {};
    const freight = freightRes.data || {};
    const order = orderRes.data || {};
    const parties = invoiceParties(invoices);
    root.innerHTML = card('三段承运方', canEditGodview ? '可选择/更换承运方并生成子链' : '只展示已指派公司名', carrierPanel(s, esc, canEditGodview, invoices), '🏢')
      + card('工厂装货状态', '来自 booking_sheet.factory_loading_done / containers', loadingPanel(s, esc), '🏭',
        invoiceControls(parties.factory, 'factory', false, parties.factory && parties.factory.assigned !== false, '进项票 →'))
      + card('车队装货', '自动读取同一柜明细/车队回填数据源', truckingLoadingPanel(s, esc), '🚛',
        truckingPriceHeader(freight) + invoiceControls(parties.truck, 'truck', false, true, '进项票 →'))
      + card('运费价格', 'freight_supplier_bills 成本 / 销售 / 毛利', freightPricingPanel(freight, esc, canEditGodview), '💰',
        headerTotalsChips(freight.totals, 'freight') + invoiceControls(parties.ocean, 'ocean', false, true, '进项票 →'))
      + card('订单价格', canSeeOrderProfit ? 'OLI 采购价 / 销售价 / 毛利' : '仅 upstream_downstream 可见', orderPricingPanel(order, esc), '📦',
        headerTotalsChips(order.totals, 'order') + invoiceControls(parties.customer, 'customer', true, true, '开销售票 →'));
  }
  function openInvoiceParty(seg){
    if(!lastCtx) return;
    window.open('/public/invoice-confirm-preview.html?token=' + encodeURIComponent(lastCtx.token) + '&party=' + encodeURIComponent(seg), '_blank', 'noopener');
  }
  async function refreshGodview(){
    if(!lastCtx) return;
    const res = await safeFetch(lastCtx.api + '/validate?token=' + encodeURIComponent(lastCtx.token));
    const d = res.data || {};
    if(res.ok && d.valid){
      await render({ ...lastCtx, data:d, sheet:d.booking_sheet || {}, portalScope:d.portal_scope || {} });
    } else {
      await render(lastCtx);
    }
  }
  async function pickVendor(segment){
    if(!lastCtx) return;
    const box = document.getElementById('vendorPick-' + segment);
    if(!box) return;
    box.innerHTML = '<span style="font-size:11px;color:#6b7280;">读取候选...</span>';
    const res = await safeFetch(lastCtx.api + '/collab-vendor-options?token=' + encodeURIComponent(lastCtx.token) + '&segment=' + encodeURIComponent(segment));
    const data = res.data || {};
    const options = Array.isArray(data.options) ? data.options : [];
    if(!res.ok || !data.ok){
      box.innerHTML = '<span style="font-size:11px;color:#b91c1c;">' + lastCtx.esc(data.error || '读取失败') + '</span>';
      return;
    }
    const currentName = assignedVendorName(lastCtx.sheet || {}, segment);
    box.innerHTML = '<select style="margin-top:8px;width:100%;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:12px;"><option value="">选择' + lastCtx.esc(vendorDefs[segment].label) + '</option>'
      + options.map(o => {
        const name = o.name_cn || o.name || ('#' + o.id);
        const selected = o.name_cn === currentName ? ' selected' : '';
        return '<option value="' + lastCtx.esc(o.id) + '"' + selected + '>' + lastCtx.esc(name) + '</option>';
      }).join('') + '</select>'
      + '<div class="vendorAssignMsg" style="font-size:11px;color:#6b7280;margin-top:5px;"></div>';
    const select = box.querySelector('select');
    select.onchange = async () => {
      if(!select.value) return;
      const msg = box.querySelector('.vendorAssignMsg');
      msg.textContent = '保存并发链中...';
      const r = await postJson(lastCtx.api + '/collab-assign-vendor', { token:lastCtx.token, segment, company_id:select.value });
      const out = r.data || {};
      if(!r.ok || !out.ok){
        msg.style.color = '#b91c1c';
        msg.textContent = out.error || '保存失败';
        return;
      }
      linkMessage = { label: vendorDefs[segment].label, url: out.link_url || '' };
      await refreshGodview();
    };
  }
  async function saveFreightPricing(){
    if(!lastCtx) return;
    const msg = document.getElementById('gvPriceMsg');
    const updates = Array.from(document.querySelectorAll('.gv-sale-input')).map(input => ({
      bill_id: input.getAttribute('data-bill-id'),
      sale_amount: input.value,
    })).filter(u => u.bill_id && u.sale_amount !== '');
    if(!updates.length){
      if(msg) msg.textContent = '没有可保存的销售价';
      return;
    }
    if(msg) msg.textContent = '保存中...';
    const res = await postJson(lastCtx.api + '/collab-pricing-submit', { token:lastCtx.token, updates });
    const data = res.data || {};
    if(!res.ok || !data.ok){
      if(msg){ msg.style.color = '#b91c1c'; msg.textContent = data.error || '保存失败'; }
      return;
    }
    freightSaleEditing = false;
    await refreshGodview();
  }
  async function setFreightSaleEditing(editing){
    freightSaleEditing = !!editing;
    await refreshGodview();
  }
  window.CollabPortalGodview = { render, pickVendor, saveFreightPricing, setFreightSaleEditing, openInvoiceParty };
})();
