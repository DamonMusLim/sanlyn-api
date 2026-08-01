const ROMAN_TAIL = "(?:VIII|VII|VI|III|IV|II|IX|I|V|X)";
// 曾经在这里写死 4 个 SVC 白名单(BENGAL/CSS3/KCM3/NS5),是对测试用例的过拟合:
// 真实 SVC 有几十个(PA1/CIX2/KCM4/DOLPHIN/SEAGULL/HKG1…),白名单永远补不全。
// 现在改为靠"必须同时解析出航次"+ isVesselLike 的长度门槛来排除,不再维护名单。
const SVC_ROUTE_CODES = new Set();

function cleanText(raw) {
  return String(raw ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[._]+/g, ".")
    .replace(/[－—–]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function fail(reason) {
  return { vessel: null, voyage: null, confidence: "no_vessel", reason };
}

function ok(vessel, voyage, reason, confidence = "high") {
  return { vessel: normalizeVessel(vessel), voyage: normalizeVoyage(voyage), confidence, reason };
}

function normalizeVoyage(voyage) {
  return cleanText(voyage)
    .replace(/^V[.\s-]+/, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*-\s*/g, "-")
    .trim();
}

function isPortRouteCode(value) {
  const text = cleanText(value);
  if (!text) return false;
  if (SVC_ROUTE_CODES.has(text)) return true;
  if (/^[A-Z]{2,6}(?:-[A-Z0-9]{2,6}){1,3}$/.test(text)) return true;
  return false;
}

function isVoyageLike(value) {
  const text = normalizeVoyage(value);
  if (!text || !/\d/.test(text)) return false;
  return /^[A-Z0-9][A-Z0-9/-]{1,18}[A-Z0-9]$/.test(text);
}

export function normalizeVessel(name) {
  let text = cleanText(name)
    .replace(/\s*\/\s*$/g, "")
    .replace(/\s*-\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  text = text.replace(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, m => m.toUpperCase());
  return text || null;
}

export function isVesselLike(raw) {
  const text = normalizeVessel(raw);
  if (!text || isPortRouteCode(text)) return false;
  if (!/[A-Z]/.test(text)) return false;

  const words = text.split(" ");
  if (words.length >= 2) return true;
  // 单 token 必须够长才可能是船名(FENGXINDA27=11)。SVC 航线代码几乎都 ≤7 字符
  // (PA1/CIX2/SH1/BBX2/HKG1/DOLPHIN/SEAGULL),不设长度门槛会把 SVC 当成船名 ——
  // 实测 59 个真实 SVC 里有 24 个中招。
  if (text.length >= 8 && /^[A-Z]+\d{1,3}$/.test(text)) return true;
  return false;
}

function splitDelimited(text) {
  const slash = text.indexOf("/");
  if (slash === -1) return null;
  return {
    vessel: text.slice(0, slash),
    voyage: text.slice(slash + 1),
    reason: "slash_delimited",
  };
}

function splitNoiseV(text) {
  const cleaned = text.replace(/\s*-\s*V[.\s-]*/g, " ");
  if (cleaned === text) return null;
  return splitByLastToken(cleaned, "dash_v_noise");
}

function splitRomanBoundary(text) {
  const match = text.match(new RegExp(`^(.+\\b${ROMAN_TAIL})([A-Z]{1,3}\\d{2,}[A-Z0-9/-]*)$`));
  if (!match) return null;
  return {
    vessel: match[1],
    voyage: match[2],
    reason: "roman_tail_boundary",
  };
}

function splitByLastToken(text, reason = "last_token_voyage") {
  const match = text.match(/^(.+?)\s+([A-Z0-9][A-Z0-9/-]{1,18})$/);
  if (!match) return null;
  return {
    vessel: match[1],
    voyage: match[2],
    reason,
  };
}

export function parseVesselVoyage(raw) {
  const text = cleanText(raw);
  if (!text) return fail("empty");
  if (isPortRouteCode(text)) return fail("route_code_not_vessel");

  const candidates = [
    splitDelimited(text),
    splitNoiseV(text),
    splitRomanBoundary(text),
    splitByLastToken(text),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const vessel = normalizeVessel(candidate.vessel);
    const voyage = normalizeVoyage(candidate.voyage);
    if (isVesselLike(vessel) && isVoyageLike(voyage)) {
      return ok(vessel, voyage, candidate.reason);
    }
  }

  if (isVesselLike(text)) return fail("vessel_without_voyage");
  return fail("not_vessel_like");
}
