import OSS from 'ali-oss';
import { getPool } from './db.js';

const OSS_KEY    = 'data/shipping_plans.json';
const OSS_PUBLIC = `https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/${OSS_KEY}`;

// widget ID 映射（完整版，已从JDY表单数据结构确认）
const W = {
  shipmentNo:   '_widget_1762828544749',  // 出运编号 (sn)
  shippingLine: '_widget_1765450157283',  // 船公司
  pol:          '_widget_1764591553171',  // 起运港
  pod:          '_widget_1764591553172',  // 目的港
  containerQty: '_widget_1765450157285',  // 柜数量
  containerType:'_widget_1766895482504',  // 建议柜型
  customerEN:   '_widget_1766913567261',  // 客户公司（英文）
  customerCN:   '_widget_1766568840023',  // 客户公司名称
  forwarderCN:  '_widget_1764591553170',  // 货代公司（中文）
  forwarderEN:  '_widget_1765191742170',  // 货代公司（英文）
  truckingCN:   '_widget_1768645113405',  // 拖车公司（中文）
  customsCN:    '_widget_1768645113406',  // 报关行
  insuranceCN:  '_widget_1773730136760',  // 保险公司中文
  insuranceCost:'_widget_1773730136761',  // 保险销售价
  freightCost:  '_widget_1768299925392',  // 海运费（成本）
  freightSaleUSD:'_widget_1766566622260', // 海运费（销售）
  thcTotal:     '_widget_1768300192916',  // 港杂金额
  truckingCost: '_widget_1772454275249',  // 拖车总费用（成本）
  customsCost:  '_widget_1768641952534',  // 报关费用（成本）
  shipmentDate: '_widget_1764582236204',  // 出运日期
  blNo:         '_widget_1773399157196',  // BL单号
  etd:          '_widget_1771626741566',  // ETD（开船日）
  eta:          '_widget_1771626741567',  // ETA（预计到港日）
  vessel:       '_widget_1771626741568',  // 船名
  voyage:       '_widget_1771626741569',  // 航次 ← 原来漏掉了
  containerNo:  '_widget_1771626741552',  // 柜号
  cutoffDate:   '_widget_1771626741547',  // 截港日
  flowStatus:   '_widget_1764582236205',  // 状态
  contractNo:   '_widget_1768820368507',  // 合同号
  orderNos:     '_widget_1767084770362',  // 订单号集合
};

// tracking 字段：JDY同步时不覆盖这些，保留4portun写入的数据
const TRACKING_FIELDS = ['currentStatus', 'currentStatusCn', 'trackingUpdatedAt', 'atd', 'voyage'];

function get(d, k) {
  const v = d[W[k]];
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.value !== undefined) return v.value ?? '';
  return v;
}

function mapRecord(d) {
  return {
    _id:              d._id || '',
    shipmentNo:       String(get(d, 'shipmentNo') || ''),
    contractNo:       String(get(d, 'contractNo') || ''),
    orderNos:         String(get(d, 'orderNos')   || ''),
    customerCompanyEN:String(get(d, 'customerEN') || ''),
    customerCompany:  String(get(d, 'customerCN') || get(d, 'customerEN') || ''),
    shippingLine:     String(get(d, 'shippingLine') || ''),
    pol:              String(get(d, 'pol') || ''),
    pod:              String(get(d, 'pod') || ''),
    containerQty:     Number(get(d, 'containerQty'))  || 0,
    containerType:    String(get(d, 'containerType')  || ''),
    forwarderCN:      String(get(d, 'forwarderCN')    || ''),
    forwarderEN:      String(get(d, 'forwarderEN')    || ''),
    truckingCN:       String(get(d, 'truckingCN')     || ''),
    customsCN:        String(get(d, 'customsCN')      || ''),
    insuranceCN:      String(get(d, 'insuranceCN')    || ''),
    insuranceCost:    Number(get(d, 'insuranceCost'))  || 0,
    freightCost:      Number(get(d, 'freightCost'))    || 0,
    freightSaleUSD:   Number(get(d, 'freightSaleUSD')) || 0,
    portSurchargeTotal:Number(get(d, 'thcTotal'))      || 0,
    truckingCostTotal: Number(get(d, 'truckingCost'))  || 0,
    customsCostTotal:  Number(get(d, 'customsCost'))   || 0,
    shipmentDate:     String(get(d, 'shipmentDate') || '').slice(0, 10),
    blNo:             String(get(d, 'blNo')         || ''),
    etd:              String(get(d, 'etd')          || '').slice(0, 10),
    eta:              String(get(d, 'eta')          || '').slice(0, 19),
    vessel:           String(get(d, 'vessel')        || ''),
    voyage:           String(get(d, 'voyage')        || ''),  // ← 补上
    containerNo:      String(get(d, 'containerNo')   || ''),
    cutoffDate:       String(get(d, 'cutoffDate')    || '').slice(0, 10),
    flowStatus:       String(get(d, 'flowStatus')    || ''),
    status: ['流程结束（归档关闭）', '客户确认收货（签收/异常）', '流转完成']
              .includes(get(d, 'flowStatus')) ? 'completed' : 'in_progress',
    updatedAt: new Date().toISOString().slice(0, 10),
  };
}

function getOSSClient() {
  return new OSS({
    region:          process.env.OSS_REGION,
    accessKeyId:     process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket:          process.env.OSS_BUCKET,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET')     return res.status(200).json({ ok: true, service: 'jdy-plans-sync v2' });
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const op   = body.op || 'data_update';
    const data = body.data?.data || body.data || {};

    if (op === 'data_remove') return res.status(200).json({ ok: true, action: 'skip_delete' });

    const rec = mapRecord(data);
    if (!rec.shipmentNo && !rec._id) return res.status(400).json({ error: 'Missing shipmentNo' });

    // ── 1. OSS 读取现有数据 ──────────────────────────────────
    const r = await fetch(`${OSS_PUBLIC}?t=${Date.now()}`);
    if (!r.ok) throw new Error('OSS read failed: ' + r.status);
    const parsed = await r.json();
    const list   = Array.isArray(parsed) ? parsed : [];

    // ── 2. upsert OSS 列表（保留 tracking 字段） ────────────
    const idx = list.findIndex(p =>
      (rec._id       && p._id       === rec._id) ||
      (rec.blNo      && p.blNo      === rec.blNo) ||
      (rec.shipmentNo && p.shipmentNo === rec.shipmentNo)
    );

    let action = 'created';
    if (idx >= 0) {
      const ex = list[idx];
      const merged = { ...ex, ...rec };
      // 保留 tracking 字段，JDY数据不覆盖
      TRACKING_FIELDS.forEach(f => { if (ex[f]) merged[f] = ex[f]; });
      // eta 有值时不覆盖（tracking写入的比JDY准）
      if (ex.eta && ex.eta.length > 0) merged.eta = ex.eta;
      list[idx] = merged;
      action = 'updated';
    } else {
      list.unshift(rec);
    }

    // ── 3. 写回 OSS ──────────────────────────────────────────
    const client = getOSSClient();
    await client.put(
      OSS_KEY,
      Buffer.from(JSON.stringify(list, null, 2), 'utf-8'),
      { mime: 'application/json' }
    );

    // ── 4. RDS upsert（保留 tracking 字段） ─────────────────
    try {
      const pool = getPool();

      // 先查现有 tracking 数据
      let existingTracking = {};
      if (rec.blNo || rec._id) {
        const q = rec.blNo
          ? await pool.query('SELECT current_status,current_status_cn,tracking_updated_at,atd,voyage FROM shipping_plans WHERE bl_no=$1 LIMIT 1', [rec.blNo])
          : await pool.query('SELECT current_status,current_status_cn,tracking_updated_at,atd,voyage FROM shipping_plans WHERE _id=$1 LIMIT 1', [rec._id]);
        existingTracking = q.rows[0] || {};
      }

      await pool.query(`
        INSERT INTO shipping_plans (
          _id, shipment_no, bl_no, contract_no, vessel, voyage,
          etd, eta, atd, container_no, container_type,
          pol, pod, cutoff_date,
          forwarder_cn, customs_cn, trucking_cn,
          customer, company_code,
          freight_cost, freight_sale_usd, port_surcharge_total,
          trucking_cost_total, customs_cost_total,
          flow_status, status,
          current_status, current_status_cn, tracking_updated_at,
          raw, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,$11,
          $12,$13,$14,
          $15,$16,$17,
          $18,$19,
          $20,$21,$22,
          $23,$24,
          $25,$26,
          $27,$28,$29,
          $30::jsonb, NOW()
        )
        ON CONFLICT (_id) DO UPDATE SET
          shipment_no         = EXCLUDED.shipment_no,
          bl_no               = EXCLUDED.bl_no,
          contract_no         = EXCLUDED.contract_no,
          container_no        = EXCLUDED.container_no,
          container_type      = EXCLUDED.container_type,
          pol                 = EXCLUDED.pol,
          pod                 = EXCLUDED.pod,
          cutoff_date         = EXCLUDED.cutoff_date,
          etd                 = EXCLUDED.etd,
          forwarder_cn        = EXCLUDED.forwarder_cn,
          customs_cn          = EXCLUDED.customs_cn,
          trucking_cn         = EXCLUDED.trucking_cn,
          customer            = EXCLUDED.customer,
          company_code        = EXCLUDED.company_code,
          freight_cost        = EXCLUDED.freight_cost,
          freight_sale_usd    = EXCLUDED.freight_sale_usd,
          port_surcharge_total= EXCLUDED.port_surcharge_total,
          trucking_cost_total = EXCLUDED.trucking_cost_total,
          customs_cost_total  = EXCLUDED.customs_cost_total,
          flow_status         = EXCLUDED.flow_status,
          status              = EXCLUDED.status,
          raw                 = EXCLUDED.raw,
          updated_at          = NOW(),
          -- tracking 字段：只在没有值时才更新，有值就保留（4portun写入的数据优先）
          vessel              = COALESCE(shipping_plans.vessel,              EXCLUDED.vessel),
          voyage              = COALESCE(shipping_plans.voyage,              EXCLUDED.voyage),
          eta                 = COALESCE(shipping_plans.eta,                 EXCLUDED.eta),
          atd                 = COALESCE(shipping_plans.atd,                 EXCLUDED.atd),
          current_status      = COALESCE(shipping_plans.current_status,      EXCLUDED.current_status),
          current_status_cn   = COALESCE(shipping_plans.current_status_cn,   EXCLUDED.current_status_cn),
          tracking_updated_at = COALESCE(shipping_plans.tracking_updated_at, EXCLUDED.tracking_updated_at)
      `, [
        rec._id         || rec.shipmentNo,  // $1  _id
        rec.shipmentNo  || null,            // $2  shipment_no
        rec.blNo        || null,            // $3  bl_no
        rec.contractNo  || null,            // $4  contract_no
        rec.vessel      || null,            // $5  vessel（tracking字段，COALESCE保护）
        existingTracking.voyage || rec.voyage || null,  // $6  voyage
        rec.etd         || null,            // $7  etd
        existingTracking.eta || rec.eta || null,        // $8  eta
        existingTracking.atd || null,       // $9  atd
        rec.containerNo || null,            // $10 container_no
        rec.containerType|| null,           // $11 container_type
        rec.pol         || null,            // $12 pol
        rec.pod         || null,            // $13 pod
        rec.cutoffDate  || null,            // $14 cutoff_date
        rec.forwarderCN || null,            // $15 forwarder_cn
        rec.customsCN   || null,            // $16 customs_cn
        rec.truckingCN  || null,            // $17 trucking_cn
        rec.customerCompanyEN || rec.customerCompany || null,  // $18 customer
        null,                               // $19 company_code（海运计划没有直接字段，后续可从订单关联）
        rec.freightCost      || null,       // $20 freight_cost
        rec.freightSaleUSD   || null,       // $21 freight_sale_usd
        rec.portSurchargeTotal|| null,      // $22 port_surcharge_total
        rec.truckingCostTotal || null,      // $23 trucking_cost_total
        rec.customsCostTotal  || null,      // $24 customs_cost_total
        rec.flowStatus  || null,            // $25 flow_status
        rec.status      || null,            // $26 status
        existingTracking.current_status    || 'Booking',  // $27 current_status
        existingTracking.current_status_cn || '订舱',     // $28 current_status_cn
        existingTracking.tracking_updated_at || null,     // $29 tracking_updated_at
        JSON.stringify(rec),                // $30 raw
      ]);

      console.log(`[jdy-plans-sync] RDS upsert ok: ${rec._id} bl=${rec.blNo}`);
    } catch (rdsErr) {
      // RDS失败不影响OSS成功的返回，只记录日志
      console.error('[jdy-plans-sync RDS]', rdsErr.message);
    }

    return res.status(200).json({ ok: true, action, shipmentNo: rec.shipmentNo, blNo: rec.blNo });

  } catch (err) {
    console.error('[jdy-plans-sync]', err);
    return res.status(500).json({ error: err.message });
  }
}
