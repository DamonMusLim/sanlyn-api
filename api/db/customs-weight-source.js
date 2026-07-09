function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function unitScale(digits) {
  return 10 ** (Number.isInteger(digits) ? digits : 2);
}

function toUnits(value, digits) {
  return Math.round(num(value) * unitScale(digits));
}

function fromUnits(value, digits) {
  return value / unitScale(digits);
}

function positive(value) {
  const n = num(value);
  return n > 0 ? n : 0;
}

function norm(value) {
  return String(value || "").trim();
}

// 合理性护栏: 场站实测优先,但实测明显偏离OLI(如把空柜重3700误录进货重)则回退OLI,绝不拿错值报关。
// 阈值: 实测须在 OLI 的 [minRatio,maxRatio] 内才可信; OLI=0时无从比较直接用实测。
export function isMeasuredSuspicious(measured, oliSum, options = {}) {
  const m = positive(measured);
  const o = num(oliSum);
  if (m <= 0 || o <= 0) return false;
  const lo = Number.isFinite(options.minRatio) ? options.minRatio : 0.7;
  const hi = Number.isFinite(options.maxRatio) ? options.maxRatio : 1.5;
  const ratio = m / o;
  return ratio < lo || ratio > hi;
}

export function resolveContainerGrossWeight(measured, oliSum, options = {}) {
  const m = positive(measured);
  const o = num(oliSum);
  if (m <= 0) return o;                          // 无实测 -> OLI
  if (o <= 0) return m;                           // 无OLI可比 -> 用实测
  if (isMeasuredSuspicious(m, o, options)) return o;  // 实测可疑(疑似空柜重) -> 回退OLI
  return m;                                        // 实测合理 -> 用实测(真实数据为准)
}

export function scaleGrossWeightsToContainer(lineGrosses, containerGross, oliSum, options = {}) {
  const digits = Number.isInteger(options.digits) ? options.digits : 2;
  const values = (lineGrosses || []).map(num);
  const baseSum = num(oliSum);
  if (!values.length || baseSum <= 0) {
    return values.map(v => fromUnits(toUnits(v, digits), digits));
  }

  const targetGross = resolveContainerGrossWeight(containerGross, baseSum);
  const scale = unitScale(digits);
  const targetUnits = toUnits(targetGross, digits);
  const quotas = values.map((v, index) => {
    const exactUnits = (v * targetGross * scale) / baseSum;
    const floorUnits = Math.floor(exactUnits);
    return {
      index,
      floorUnits,
      remainder: exactUnits - floorUnits,
    };
  });

  let allocated = quotas.reduce((sum, q) => sum + q.floorUnits, 0);
  let remainderUnits = targetUnits - allocated;
  const order = quotas
    .slice()
    .sort((a, b) => (b.remainder - a.remainder) || (a.index - b.index));

  for (let i = 0; remainderUnits > 0 && order.length; i++, remainderUnits--) {
    order[i % order.length].floorUnits += 1;
  }
  for (let i = order.length - 1; remainderUnits < 0 && i >= 0; i--, remainderUnits++) {
    if (order[i].floorUnits > 0) order[i].floorUnits -= 1;
  }

  const byIndex = new Map(order.map(q => [q.index, q.floorUnits]));
  return values.map((_v, index) => fromUnits(byIndex.get(index) || 0, digits));
}

export async function loadContainerWeightSources(pool, { blNo, orderNos = [], contractNos = [] } = {}) {
  const clauses = [];
  const params = [];
  const push = value => {
    params.push(value);
    return "$" + params.length;
  };

  if (norm(blNo)) clauses.push("bl_no = " + push(norm(blNo)));
  const keys = [...orderNos, ...contractNos].map(norm).filter(Boolean);
  if (keys.length) clauses.push("contract_no = ANY(" + push(keys) + "::text[])");
  if (!clauses.length) return makeSource([]);

  const { rows } = await pool.query(
    "SELECT contract_no, container_no, COALESCE(cargo_weight_kg, 0)::numeric AS cargo_weight_kg " +
    "FROM container_bookings WHERE " + clauses.join(" OR "),
    params
  );
  return makeSource(rows || []);
}

function makeSource(rows) {
  const byContainerNo = new Map();
  const byOrderNo = new Map();

  for (const row of rows || []) {
    const rec = {
      contract_no: norm(row.contract_no),
      container_no: norm(row.container_no),
      cargo_weight_kg: positive(row.cargo_weight_kg),
    };
    if (rec.contract_no) byOrderNo.set(rec.contract_no, rec);
    if (rec.container_no) {
      const prev = byContainerNo.get(rec.container_no);
      if (!prev || (!prev.cargo_weight_kg && rec.cargo_weight_kg)) {
        byContainerNo.set(rec.container_no, rec);
      }
    }
  }

  return {
    rows: rows || [],
    byContainerNo,
    byOrderNo,
    measuredFor({ containerNo, orderNo, contractNo } = {}) {
      const byContainer = byContainerNo.get(norm(containerNo));
      if (byContainer) return byContainer.cargo_weight_kg;
      const byOrder = byOrderNo.get(norm(orderNo)) || byOrderNo.get(norm(contractNo));
      return byOrder ? byOrder.cargo_weight_kg : 0;
    },
    containerFor({ orderNo, contractNo } = {}) {
      const byOrder = byOrderNo.get(norm(orderNo)) || byOrderNo.get(norm(contractNo));
      return byOrder ? byOrder.container_no : "";
    },
  };
}
