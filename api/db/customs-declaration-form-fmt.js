// customs-declaration-form-fmt.js — 报关单：纯格式化/取值工具（无 DB、无 IO）
// 从 customs-declaration-form-lib.js 拆出（0926，code-guard 600 行上限）。逐行原样搬移，未改逻辑。

export function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function clean(v) {
  return String(v ?? "").trim();
}

export function pick() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v !== null && v !== undefined && String(v).trim() !== "") return v;
  }
  return "";
}

export function parseRaw(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (_) { return {}; }
}

export function fmtM(v, dec) {
  if (v == null || v === "") return "";
  var n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: dec == null ? 2 : dec,
    maximumFractionDigits: dec == null ? 2 : dec,
    useGrouping: false,
  });
}

export function fmtInt(v) {
  if (v == null || v === "") return "";
  var n = Number(v);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n));
}

export function fmtDate(v) {
  if (!v) return "";
  var s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  try {
    var d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch (_) {}
  return s.slice(0, 10);
}

export function blank(v) {
  var s = clean(v);
  return s ? esc(s) : '<span class="empty">—</span>';
}

// 目的国/贸易国规范化（2026-08-08 修）
// 病根：orders.country 存法五花八门 —— MALAYSIA/Malaysia/MY/SG/MM/Espana/CHILE…
//       原来只认 MYS/MALAYSIA/马来 这种写法，遇到 ISO2 的 "MY" 直接原样印上报关单
//       （LL-23 的贸易国/运抵国/最终目的国就印成了 "MY"）。全库有 8 票是 ISO2 写法。
// 规矩：认不出来就【原样返回】并让人看见，绝不猜一个国家。
const _COUNTRY_TABLE = [
  { cn: "马来西亚(MYS)",   iso2: "MY", keys: ["MYS","MALAYSIA","马来","KLANG","WESTPORT","PASIR GUDANG","PENANG","巴生","KOTA KINABALU","BINTULU"] },
  { cn: "泰国(THA)",       iso2: "TH", keys: ["THA","THAILAND","泰国","LAEM CHABANG","BANGKOK"] },
  { cn: "越南(VNM)",       iso2: "VN", keys: ["VNM","VIETNAM","越南","HAIPHONG","HO CHI MINH","CAI MEP"] },
  { cn: "新加坡(SGP)",     iso2: "SG", keys: ["SGP","SINGAPORE","新加坡"] },
  { cn: "印度尼西亚(IDN)", iso2: "ID", keys: ["IDN","INDONESIA","印尼","印度尼西亚","JAKARTA","SURABAYA"] },
  { cn: "菲律宾(PHL)",     iso2: "PH", keys: ["PHL","PHILIPPINES","菲律宾","MANILA"] },
  { cn: "缅甸(MMR)",       iso2: "MM", keys: ["MMR","MYANMAR","BURMA","缅甸","YANGON"] },
  { cn: "孟加拉国(BGD)",   iso2: "BD", keys: ["BGD","BANGLADESH","孟加拉","CHITTAGONG","CHATTOGRAM"] },
  { cn: "柬埔寨(KHM)",     iso2: "KH", keys: ["KHM","CAMBODIA","柬埔寨","SIHANOUKVILLE"] },
  { cn: "沙特阿拉伯(SAU)", iso2: "SA", keys: ["SAU","SAUDI","沙特","JEDDAH","DAMMAM"] },
  { cn: "西班牙(ESP)",     iso2: "ES", keys: ["ESP","SPAIN","ESPANA","ESPAÑA","西班牙","BARCELONA","VALENCIA"] },
  { cn: "智利(CHL)",       iso2: "CL", keys: ["CHL","CHILE","智利","VALPARAISO","SAN ANTONIO"] },
  { cn: "日本(JPN)",       iso2: "JP", keys: ["JPN","JAPAN","日本","TOKYO","OSAKA","YOKOHAMA"] },
  { cn: "韩国(KOR)",       iso2: "KR", keys: ["KOR","KOREA","韩国","BUSAN","INCHEON"] },
  { cn: "美国(USA)",       iso2: "US", keys: ["USA","UNITED STATES","美国","LOS ANGELES","LONG BEACH","NEW YORK"] },
  { cn: "澳大利亚(AUS)",   iso2: "AU", keys: ["AUS","AUSTRALIA","澳大利亚","SYDNEY","MELBOURNE"] },
];
export function countryFromPod(pod) {
  var s = clean(pod).toUpperCase();
  if (!s) return "";
  // ① ISO2 精确匹配（"MY" 这种，必须整串相等，否则会被别的词误伤）
  for (var a = 0; a < _COUNTRY_TABLE.length; a++) {
    if (s === _COUNTRY_TABLE[a].iso2) return _COUNTRY_TABLE[a].cn;
  }
  // ② 关键词包含匹配
  for (var b = 0; b < _COUNTRY_TABLE.length; b++) {
    var ks = _COUNTRY_TABLE[b].keys;
    for (var c = 0; c < ks.length; c++) if (s.includes(ks[c])) return _COUNTRY_TABLE[b].cn;
  }
  return clean(pod);   // 认不出来原样返回：宁可人看出来不对，也不猜
}

export function sellerLabel(name, company) {
  var n = clean(name || company?.name_cn || company?.name_en);
  var uscc = clean(company?.tax_id || company?.registration_no || company?.uscc);
  if (uscc && n) return uscc + " " + n;
  return n;
}

export function firstOrderValue(orders, field, rawField) {
  for (var i = 0; i < orders.length; i++) {
    var raw = parseRaw(orders[i].raw);
    var v = pick(orders[i][field], rawField ? raw[rawField] : "");
    if (v) return v;
  }
  return "";
}

