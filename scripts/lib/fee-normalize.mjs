const MASTER_ALIASES = [
  ["燃油土地附加费", "1050", "燃油附加费"],
  ["燃油和土地附加费", "1050", "燃油附加费"],
  ["燃油土地", "1050", "燃油附加费"],
  ["设备交接单", "SBJJDF", "设备交接单费"],
  ["设备", "SBJJDF", "设备交接单费"],
  ["设备交接", "SBJJDF", "设备交接单费"],
  ["设备交接费", "SBJJDF", "设备交接单费"],
  ["设备交接单费", "SBJJDF", "设备交接单费"],
  ["设备管理费", "SBJJDF", "设备交接单费"],
  ["VGM费", "VGM", "VGM"],
  ["VGM", "VGM", "VGM"],
  ["单证", "WJF", "文件费"],
  ["单证费", "WJF", "文件费"],
  ["DOC", "WJF", "文件费"],
  ["文件费", "WJF", "文件费"],
  ["场站", "222", "场站费"],
  ["场站费", "222", "场站费"],
  ["CFS", "222", "场站费"],
  ["提箱", "444", "提箱费"],
  ["提箱费", "444", "提箱费"],
  ["港杂", "GZF", "港杂费"],
  ["港杂费", "GZF", "港杂费"],
  ["铅封", "FZF", "封志费"],
  ["铅封费", "FZF", "封志费"],
  ["SEAL", "FZF", "封志费"],
  ["封志费", "FZF", "封志费"],
  ["电放", "333", "电放费"],
  ["电放费", "333", "电放费"],
  ["TLX", "333", "电放费"],
  ["安保", "666", "安保费"],
  ["安保费", "666", "安保费"],
  ["港口设施保安费", "666", "安保费"],
  ["条码", "1038", "吊机条码费"],
  ["条形码", "1038", "吊机条码费"],
  ["放箱服务费", "1038", "吊机条码费"],
  ["放箱服务费条码费", "1038", "吊机条码费"],
  ["信息传输费", "999", "信息费"],
  ["信息费", "999", "信息费"],
  ["EIR", "1011", "EIR"],
  ["出口服务费", "2010", "出口服务费"],
  ["订舱", "DCF", "订舱费"],
  ["订舱费", "DCF", "订舱费"],
  ["舱单费", "CDF", "舱单费"],
  ["THC", "THC", "THC"],
  ["THC台湾", "THC", "THC"],
];

const TRADITIONAL_MAP = new Map([
  ["單", "单"],
  ["證", "证"],
  ["場", "场"],
  ["站", "站"],
  ["費", "费"],
  ["雜", "杂"],
  ["鉛", "铅"],
  ["電", "电"],
  ["設", "设"],
  ["備", "备"],
  ["交", "交"],
  ["接", "接"],
  ["單", "单"],
  ["提", "提"],
  ["箱", "箱"],
]);

const PENDING_NAMES = new Set([
  "小票费",
  "场站小票费",
  "改单费",
  "改单",
  "操作费",
  "检疫费",
  "青岛港免费箱使",
  "PORTDUE",
  "提箱费+安保费",
]);

const MASTER = new Map(MASTER_ALIASES.map(([name, code, canonical]) => [keyName(name), [code, canonical]]));

function keyName(value) {
  return String(value || "").replace(/[\s'’"＇（）()]/g, "").toUpperCase();
}

function toSimplified(value) {
  return [...String(value || "")].map((ch) => TRADITIONAL_MAP.get(ch) || ch).join("");
}

function uniqPush(parts, value) {
  if (value && !parts.includes(value)) parts.push(value);
}

function appendNote(note, extra) {
  const parts = String(note || "").split(" | ").filter(Boolean);
  for (const item of extra) uniqPush(parts, item);
  return parts.join(" | ");
}

function splitProtectedSuffix(name) {
  const suffixes = [];
  let base = String(name || "").trim();
  while (true) {
    const match = base.match(/^(.*?)([（(]([^）)]+)[）)])$/);
    if (!match) break;
    if (/^[A-Za-z]+$/.test(match[3].trim())) break;
    suffixes.unshift(match[2].replace(/^（/, "(").replace(/）$/, ")"));
    base = match[1].trim();
  }
  return { base, suffix: suffixes.join("") };
}

function stripUnit(name) {
  const match = String(name || "").trim().match(/^(.*?)\s*[\/／]\s*(柜|票|箱|BILL)\s*$/i);
  if (!match) return { name: String(name || "").trim(), unit: "" };
  return { name: match[1].trim(), unit: match[2].toUpperCase() === "BILL" ? "票" : match[2] };
}

function stripCodeParens(name) {
  const removed = [];
  const clean = String(name || "").replace(/[（(]\s*([A-Za-z]+)\s*[）)]/g, (_, code) => {
    removed.push(code.toUpperCase());
    return "";
  });
  return { name: clean.trim(), codes: removed };
}

function normalizePendingName(name) {
  const compact = keyName(name);
  if (compact === "PORTDUE") return "PORT DUE";
  if (compact === "提箱费+安保费") return "提箱费+安保费";
  return String(name || "").trim();
}

export function normalizeFeeName(rawName) {
  const { base, suffix } = splitProtectedSuffix(rawName);
  const simplified = toSimplified(base);
  const codeResult = stripCodeParens(simplified);
  const unitResult = stripUnit(codeResult.name);
  const cleaned = unitResult.name.replace(/\s+/g, "").trim();
  const notes = [];
  if (unitResult.unit) notes.push(`计价单位:${unitResult.unit}`);
  if (codeResult.codes.length) notes.push(`原名:${rawName}`);
  return { lookupName: cleaned, displayName: `${cleaned}${suffix}`, suffix, notes };
}

export function normalizeFeeRows(rows) {
  const unknown = new Map();
  const pending = new Map();
  const mappedCategories = new Set();
  const mapped = rows.map((row) => {
    const normalized = normalizeFeeName(row.cost_category);
    const hit = MASTER.get(keyName(normalized.lookupName));
    if (hit) {
      mappedCategories.add(hit[1]);
      return {
        ...row,
        fee_code: hit[0],
        cost_category: `${hit[1]}${normalized.suffix}`,
        note: appendNote(row.note, normalized.notes),
      };
    }
    const displayName = normalizePendingName(normalized.lookupName);
    const next = {
      ...row,
      fee_code: "",
      cost_category: `${displayName}${normalized.suffix}`,
      note: appendNote(row.note, [...normalized.notes, "⚠️主数据无此费目,待新增"]),
    };
    const unknownKey = `${row.sheet}\u0001${displayName}`;
    if (!unknown.has(unknownKey)) unknown.set(unknownKey, { sheet: row.sheet, category: displayName, count: 0 });
    unknown.get(unknownKey).count += 1;
    const pendingKey = displayName;
    if (!pending.has(pendingKey)) pending.set(pendingKey, { category: displayName, carriers: new Set(), amounts: new Map() });
    const item = pending.get(pendingKey);
    item.carriers.add(row.carrier_code);
    const carrierAmounts = item.amounts.get(row.carrier_code) || new Set();
    carrierAmounts.add(`${row.container_type}:${row.rate}${row.currency || "CNY"}`);
    item.amounts.set(row.carrier_code, carrierAmounts);
    return next;
  });
  const suggested = [...pending.values()].map((item) => ({
    category: item.category,
    carriers: [...item.carriers].sort(),
    amounts: [...item.amounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([carrier, values]) => `${carrier}=${[...values].sort().join("/")}`)
      .join("; "),
  })).sort((a, b) => a.category.localeCompare(b.category, "zh-Hans-CN"));
  const mappedRows = mapped.filter((row) => row.fee_code);
  const blankRows = mapped.filter((row) => !row.fee_code);
  return {
    rows: mapped,
    unknown: [...unknown.values()],
    suggested,
    stats: {
      mappedRows: mappedRows.length,
      mappedCategories: mappedCategories.size,
      blankRows: blankRows.length,
    },
  };
}
