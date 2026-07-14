'use strict';

const MAIN_COST_NAMES = [
  '海运费', 'THC', '单证费', '订舱费', '设备交接费', 'VGM', '封签费', '电放费',
  '舱单费', '拖车费', '提箱费', '报关费', '港杂费', '场站费', '操作费', '驳船费',
  '安保费', '转关费', '打单费', '码头费', '套柜费', '信息费', '燃油附加费',
  'EDI费', '其他'
];

const ALIASES = {
  铅封费: '封签费',
  码头安保费: '安保费',
  设备交接单: '设备交接费',
  舱单信息费: '舱单费',
  土地燃油附加费: '燃油附加费'
};

const CONTAINS_RULES = [
  [/海运|海费|oceanfreight|freight/i, '海运费'],
  [/驳船|barge/i, '驳船费'],
  [/THC|码头操作/i, 'THC'],
  [/单证|文件|doc/i, '单证费'],
  [/订舱|booking/i, '订舱费'],
  [/设备交接|EIR/i, '设备交接费'],
  [/VGM/i, 'VGM'],
  [/封签|铅封|seal/i, '封签费'],
  [/电放|telex/i, '电放费'],
  [/舱单|manifest/i, '舱单费'],
  [/拖车|拖卡|truck/i, '拖车费'],
  [/提箱|提柜/i, '提箱费'],
  [/报关|customs/i, '报关费'],
  [/港杂|港建|港务/i, '港杂费'],
  [/场站|CFS|堆场/i, '场站费'],
  [/操作|handling/i, '操作费'],
  [/安保|security/i, '安保费'],
  [/转关/i, '转关费'],
  [/打单/i, '打单费'],
  [/码头/i, '码头费'],
  [/套柜/i, '套柜费'],
  [/信息/i, '信息费'],
  [/燃油|BAF|fuel/i, '燃油附加费'],
  [/EDI/i, 'EDI费']
];

const BL_PREFIXES = [
  'EGLV', 'COAU', 'OOLU', 'COSCO', 'MEDU', 'MSCU', 'MSC', 'ONEY', 'HLCU',
  'YMLU', 'CMDU', 'MAEU', 'CMAU', 'WHLU', 'SITG', 'ZIMU'
];

function normalizeBlNo(raw) {
  const original = String(raw || '').trim();
  let value = original.replace(/^提单号[:：]?\s*/i, '').trim().toUpperCase();
  value = value.replace(/\s+/g, '');

  let prefix = '';
  for (const item of BL_PREFIXES) {
    if (value.startsWith(item)) {
      prefix = item;
      value = value.slice(item.length);
      break;
    }
  }

  const isBookingNo = /^17[A-Z0-9]{6,}V$/i.test(value);
  return {
    bl_raw: original,
    bl_no: value,
    stripped_prefix: prefix,
    is_booking_no: isBookingNo
  };
}

function normalizeCurrency(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return '';
  if (text === 'RMB' || text === 'CNY' || text === '人民币' || text === '￥' || text === '¥') {
    return 'CNY';
  }
  if (text === 'USD' || text === 'US$' || text === '$' || text === '美金' || text === '美元') {
    return 'USD';
  }
  return text;
}

function normalizeCostName(nameRaw) {
  const raw = String(nameRaw || '').trim();
  const compact = raw.replace(/\s+/g, '');
  const alias = ALIASES[compact] || ALIASES[raw];
  if (alias) return alias;
  if (MAIN_COST_NAMES.includes(compact)) return compact;
  if (/^THC$/i.test(compact)) return 'THC';
  if (/^VGM$/i.test(compact)) return 'VGM';
  if (/^EDI费?$/i.test(compact)) return 'EDI费';

  for (const rule of CONTAINS_RULES) {
    if (rule[0].test(raw)) return rule[1];
  }
  return '其他';
}

function normalizeInvoiceType(value, category) {
  const text = String(value || '').trim();
  if (category === '报关费') return '6%专票';
  if (!text) return '';
  if (/6/.test(text)) return '6%专票';
  if (/9/.test(text)) return '9%专票';
  if (/0|普票|免税/.test(text)) return '0%普票';
  return text;
}

function normalizeCostLine(line) {
  const category = normalizeCostName(line.name_raw);
  const currency = normalizeCurrency(line.currency) || (category === '驳船费' ? 'USD' : 'CNY');
  const normalized = Object.assign({}, line, {
    name_raw: String(line.name_raw || '').trim(),
    currency,
    invoice_type: normalizeInvoiceType(line.invoice_type, category),
    cost_category: category,
    category_group: category === '驳船费' || category === '海运费' ? '海运费类' : '本地费类'
  });

  if (category === '驳船费') normalized.display_currency = 'USD';
  if (!MAIN_COST_NAMES.includes(normalized.cost_category)) normalized.cost_category = '其他';
  return normalized;
}

function normalizeBill(bill) {
  const bl = normalizeBlNo(bill.bl_raw || bill.bl_no);
  return Object.assign({}, bill, {
    bl_no: bl.bl_no,
    is_booking_no: bl.is_booking_no,
    cost_lines: (bill.cost_lines || []).map(normalizeCostLine)
  });
}

function normalizeParsed(parsed) {
  return Object.assign({}, parsed, {
    bills: (parsed.bills || []).map(normalizeBill)
  });
}

export {
  MAIN_COST_NAMES,
  ALIASES,
  normalizeBlNo,
  normalizeCurrency,
  normalizeCostName,
  normalizeCostLine,
  normalizeBill,
  normalizeParsed
};
