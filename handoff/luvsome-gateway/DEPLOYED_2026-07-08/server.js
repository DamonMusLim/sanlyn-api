// LuvSome Retail Gateway — 阶段1 (Odoo 侧接口)
// 原则：
//  1. 小程序/无人店前台只调本网关，绝不直连 Odoo。
//  2. 对顾客屏蔽成本价(standard_price)等敏感字段 —— 字段隔离在本层做。
//  3. 红线：写操作(建单/扣库存)默认禁用，ODOO_WRITE_ENABLED=true 才放开。
//  4. 微信支付/小程序登录/企微发券 等待资质到位后在后续阶段接入(此版不含)。

import express from 'express';
import { searchRead, call, config } from './odoo.js';
import adminRouter from './admin.js';
import yudaoRouter from './yudao/index.js';
import { loadTree, DEFAULT_TREE } from './admin-decorate.js';

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

// mount(): Vercel风格handler挂载到Express路由，照抄sanlyn-api server.js的写法
function mount(route, handlerModule) {
  app.all(route, async (req, res) => {
    try {
      const mod = await handlerModule();
      const handler = mod.default || mod;
      await handler(req, res);
    } catch (err) {
      console.error(`[${route}] Error:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });
}
// 芋道小程序前端适配层（yudao-mall-uniapp 调 /app-api/*）
app.use('/app-api', yudaoRouter);

// ── 公开只读：H5 消费装修配置（无鉴权，剔除 is_show=false）──
app.get('/api/decorate/home', (req, res) => {
  try {
    const tree = loadTree();
    const filter = (list) => (list || []).filter((c) => c.is_show !== false);
    res.set('Cache-Control', 'no-cache');
    res.json({
      version: tree.version || 1,
      sort_result: filter(tree.sort_result),
      no_sort_result: filter(tree.no_sort_result),
    });
  } catch {
    const t = DEFAULT_TREE;
    res.json({ version: t.version, sort_result: t.sort_result, no_sort_result: t.no_sort_result });
  }
});

const PORT = process.env.PORT || 8093;
const WRITE_ENABLED = process.env.ODOO_WRITE_ENABLED === 'true';
const API_KEY = process.env.GATEWAY_API_KEY || '';

// 简单 API Key 鉴权(设了才校验；前台调用带 x-api-key)
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (API_KEY && req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// 水单OCR审核闭环(2026-07-08接线)：复用sanlyn-api的slip-core.js共用模板，
// 前台上传走这层x-api-key鉴权 + 内部还有ADMIN_TOKEN保护process_pending/confirm等运营操作
mount('/api/pet-slip/upload', () => import('./db/pet-slip-upload.js'));

// 顾客可见的商品字段(白名单) —— 不含 standard_price(成本)
function toPublicProduct(p) {
  return {
    id: p.id,
    name: p.name,
    code: p.default_code || null,
    barcode: p.barcode || null,
    price: p.list_price,
    in_stock: p.qty_available,
    category: Array.isArray(p.categ_id) ? p.categ_id[1] : null,
    oversized: !!p.x_is_oversized,
    shipping_restriction: p.x_shipping_restriction || 'none',
    is_vet_drug: !!p.x_is_veterinary_drug,
    fulfillment: p.x_fulfillment_default_type || 'self_stock',
    // 商品图：经网关代理 Odoo image_512，前台绝不直连 8069
    image_url: `/api/products/${p.id}/image`,
  };
}

const PRODUCT_FIELDS = [
  'name', 'default_code', 'barcode', 'list_price', 'qty_available', 'categ_id',
  'x_is_oversized', 'x_shipping_restriction', 'x_is_veterinary_drug', 'x_fulfillment_default_type',
];

// 健康检查
app.get('/api/health', async (req, res) => {
  res.json({ status: 'ok', service: 'luvsome-gateway', version: '0.1.0', write_enabled: WRITE_ENABLED, odoo: config });
});

// 分类
app.get('/api/categories', async (req, res, next) => {
  try {
    const cats = await searchRead('product.category', [], ['name', 'complete_name', 'parent_id']);
    res.json({ categories: cats });
  } catch (e) { next(e); }
});

// 商品列表(顾客视角，可售 + 屏蔽成本)
app.get('/api/products', async (req, res, next) => {
  try {
    const domain = [['sale_ok', '=', true]];
    if (req.query.category) domain.push(['categ_id', '=', Number(req.query.category)]);
    if (req.query.q) {
      const q = String(req.query.q).trim();
      domain.push('|', '|', ['name', 'ilike', q], ['barcode', '=', q], ['default_code', '=', q]);
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await searchRead('product.template', domain, PRODUCT_FIELDS, { limit });
    res.json({ count: rows.length, products: rows.map(toPublicProduct) });
  } catch (e) { next(e); }
});

// 商品图片(代理 Odoo image_512，带缓存头；无图返回 404 由前端落占位)
app.get('/api/products/:id/image', async (req, res, next) => {
  try {
    const rows = await searchRead('product.template', [['id', '=', Number(req.params.id)]], ['image_512'], { limit: 1 });
    if (!rows.length || !rows[0].image_512) return res.status(404).json({ error: 'no image' });
    const buf = Buffer.from(rows[0].image_512, 'base64');
    const mime = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) { next(e); }
});

// 单个商品
app.get('/api/products/:id', async (req, res, next) => {
  try {
    const rows = await searchRead('product.template', [['id', '=', Number(req.params.id)]], PRODUCT_FIELDS, { limit: 1 });
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ product: toPublicProduct(rows[0]) });
  } catch (e) { next(e); }
});

// 建订单(红线：默认禁用，资质/授权到位再开)
app.post('/api/orders', async (req, res, next) => {
  if (!WRITE_ENABLED) {
    return res.status(503).json({ error: 'writes_disabled', message: 'ODOO_WRITE_ENABLED=false：写操作未授权，本阶段只读' });
  }
  try {
    const { lines, contact } = req.body || {};
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines required' });
    const phone = (contact && contact.phone) || '';
    // 会员：按手机号找/建（线上线下共用同一会员）
    let partnerId;
    if (phone) {
      const f = await searchRead('res.partner', [['phone', '=', phone]], ['id'], { limit: 1 });
      partnerId = f.length ? f[0].id : await call('res.partner', 'create', [{ name: '会员' + phone.slice(-4), phone }]);
    } else {
      const a = await searchRead('res.partner', [['name', '=', '门店散客']], ['id'], { limit: 1 });
      partnerId = a.length ? a[0].id : await call('res.partner', 'create', [{ name: '门店散客' }]);
    }
    // 商品模板 id → 变体 id
    const tmplIds = lines.map((l) => Number(l.product_id));
    const variants = await searchRead('product.product', [['product_tmpl_id', 'in', tmplIds]], ['id', 'product_tmpl_id']);
    const t2v = {};
    for (const v of variants) t2v[Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id] = v.id;
    const orderLines = [];
    for (const l of lines) {
      const vid = t2v[Number(l.product_id)];
      if (vid) orderLines.push([0, 0, { product_id: vid, product_uom_qty: Number(l.qty) || 1 }]);
    }
    if (!orderLines.length) return res.status(400).json({ error: 'no_valid_products' });
    const note = '【H5自助买单】' + ((contact && contact.note) || '') + (phone ? ' 取货:' + phone : '');
    const orderId = await call('sale.order', 'create', [{ partner_id: partnerId, order_line: orderLines, note }]);
    // 确认订单 + 自助取货立即出库扣库存（共用库存实时反映）
    try {
      await call('sale.order', 'action_confirm', [[orderId]]);
      const pickings = await searchRead('stock.picking', [['sale_id', '=', orderId], ['state', 'not in', ['done', 'cancel']]], ['id'], { limit: 5 });
      for (const p of pickings) {
        try {
          await call('stock.picking', 'action_assign', [[p.id]]);
          const moves = await searchRead('stock.move', [['picking_id', '=', p.id]], ['id', 'product_uom_qty']);
          for (const m of moves) await call('stock.move', 'write', [[m.id], { quantity: m.product_uom_qty, picked: true }]);
          await call('stock.picking', 'button_validate', [[p.id]], { context: { skip_backorder: true, skip_sms: true } });
        } catch (pe) { /* 库存不足等：保持确认，不阻断下单 */ }
      }
    } catch (ce) { /* 确认失败也不阻断：订单已建，可后台处理 */ }
    const o = await searchRead('sale.order', [['id', '=', orderId]], ['name', 'amount_total'], { limit: 1 });
    res.json({ ok: true, order_id: orderId, order_no: o[0] && o[0].name, amount: o[0] && o[0].amount_total, pay: '到店扫码付' });
  } catch (e) { next(e); }
});

// ── 服务/预约（洗护美容）──
const SLOTS = ['09:00', '10:30', '13:00', '14:30', '16:00'];
const SLOT_CAPACITY = 2;

// 服务项目列表
app.get('/api/services', async (req, res, next) => {
  try {
    const rows = await searchRead('product.template', [['type', '=', 'service'], ['sale_ok', '=', true], ['list_price', '>', 0]],
      ['id', 'name', 'list_price'], { limit: 50 });
    res.json({ services: rows.map((r) => ({ id: r.id, name: r.name, price: r.list_price })) });
  } catch (e) { next(e); }
});

// 某天某服务的可约时段
app.get('/api/slots', async (req, res, next) => {
  try {
    const date = req.query.date;
    const service = Number(req.query.service);
    if (!date || !service) return res.status(400).json({ error: 'date & service required' });
    const booked = await searchRead('retail.appointment',
      [['appoint_date', '=', date], ['service_id', '=', service], ['state', 'in', ['confirmed', 'done']]],
      ['slot'], { limit: 200 });
    const used = {};
    for (const b of booked) used[b.slot] = (used[b.slot] || 0) + 1;
    res.json({ slots: SLOTS.map((s) => ({ slot: s, available: Math.max(0, SLOT_CAPACITY - (used[s] || 0)) })) });
  } catch (e) { next(e); }
});

// 创建预约
app.post('/api/appointments', async (req, res, next) => {
  if (!WRITE_ENABLED) return res.status(503).json({ error: 'writes_disabled' });
  try {
    const { service_id, date, slot, phone, pet_name, note } = req.body || {};
    if (!service_id || !date || !slot || !phone) return res.status(400).json({ error: 'service_id,date,slot,phone required' });
    // 会员
    const f = await searchRead('res.partner', [['phone', '=', phone]], ['id'], { limit: 1 });
    const partnerId = f.length ? f[0].id : await call('res.partner', 'create', [{ name: '会员' + String(phone).slice(-4), phone }]);
    // 宠物(可选)
    let petId = null;
    if (pet_name) petId = await call('retail.pet', 'create', [{ name: pet_name, owner_id: partnerId }]);
    const vals = { partner_id: partnerId, service_id: Number(service_id), appoint_date: date, slot, phone, note: note || '' };
    if (petId) vals.pet_id = petId;
    let apptId;
    try {
      apptId = await call('retail.appointment', 'create', [vals]);
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('约满')) return res.status(409).json({ error: 'slot_full', message: '该时段已约满，请换个时间' });
      throw e;
    }
    const a = await searchRead('retail.appointment', [['id', '=', apptId]], ['name', 'verify_code', 'service_name', 'price_snapshot'], { limit: 1 });
    res.json({ ok: true, appoint_no: a[0] && a[0].name, verify_code: a[0] && a[0].verify_code, service: a[0] && a[0].service_name, price: a[0] && a[0].price_snapshot, date, slot });
  } catch (e) { next(e); }
});

// 我的预约
app.get('/api/appointments', async (req, res, next) => {
  try {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const rows = await searchRead('retail.appointment', [['phone', '=', phone]],
      ['name', 'service_name', 'price_snapshot', 'appoint_date', 'slot', 'state', 'verify_code'], { limit: 50 });
    res.json({ appointments: rows });
  } catch (e) { next(e); }
});


// ── kiosk 无人店专用(只读、公开、仅必要字段) ──
app.get('/api/member/by-phone', async (req, res, next) => {
  try {
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const rows = await searchRead('res.partner', [['phone', '=', phone]], ['name', 'sale_order_count'], { limit: 1 });
    if (!rows.length) return res.json({ found: false });
    res.json({ found: true, name: rows[0].name, orders: rows[0].sale_order_count || 0 });
  } catch (e) { next(e); }
});
app.get('/api/appointments/today', async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await searchRead('retail.appointment', [['appoint_date', '=', today]], ['service_name', 'slot'], { limit: 50, order: 'slot' });
    res.json({ appointments: rows.map((a) => ({ time: a.slot, type: a.service_name })) });
  } catch (e) { next(e); }
});


// ── kiosk 站位端点（待真实资源接入即替换）──
app.post('/api/pay/micropay', (req, res) => {
  res.json({ ok: false, stub: true, pending: 'merchant_id', message: '待申请微信/支付宝商户号；现金/被扫占位' });
});
app.get('/api/takeout/pending', async (req, res) => {
  try {
    const fs = await import('node:fs');
    const p = '/opt/luvsome-gateway/data/takeout.json';   // 美团桥写这里即真
    if (fs.existsSync(p)) return res.json({ takeout: JSON.parse(fs.readFileSync(p, 'utf8')) });
  } catch (e) { /* ignore */ }
  res.json({ takeout: [] });
});

// 错误兜底
app.use((err, req, res, next) => {
  console.error('[gateway error]', err.message);
  res.status(500).json({ error: 'internal', message: err.message });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`LuvSome Gateway 监听 127.0.0.1:${PORT} | write_enabled=${WRITE_ENABLED} | odoo=${config.ODOO_URL}/${config.ODOO_DB}`);
});
