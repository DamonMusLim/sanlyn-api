const SEP = '\x1f';
export const SHELF_LIFE_MIN_DAYS = 1;
export const SHELF_LIFE_MAX_DAYS = 7300;
export const SUPP_FIELDS = [
  'brand',
  'pet_type',
  'shelf_life_days',
  'expire_date_batch',
  'compliance_status',
  'shelf_location',
];

export function isEmptyLiteral(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  if (text === '') return true;

  const lower = text.toLowerCase();
  return lower === 'null' || lower === 'undefined' || lower === 'nan' || lower === 'none';
}

export function isRepeatedNullUndefined(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  if (/^(null|undefined)$/i.test(text)) return false;
  return /^(null|undefined)+$/i.test(text);
}

export function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '') return null;

  const lower = text.toLowerCase();
  if (lower === 'null' || lower === 'undefined' || lower === 'nan' || lower === 'none') return null;
  if (/^(null|undefined)+$/i.test(text)) return null;

  return text;
}

export function parseShelfLifeDays(value) {
  const text = clean(value);
  if (!text) return null;
  if (!/^[+-]?\d+$/.test(text)) return null;

  const days = Number.parseInt(text, 10);
  if (!Number.isInteger(days)) return null;
  if (days < SHELF_LIFE_MIN_DAYS || days > SHELF_LIFE_MAX_DAYS) return null;

  return days;
}

export function validDateParts(year, month, day) {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function isExplicitDatePattern(text) {
  let match = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(text);
  if (match) {
    return validDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) {
    return validDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  return false;
}

export function parseExpireDateBatch(value) {
  const text = clean(value);
  if (!text) return null;
  if (/null/i.test(text)) return null;

  if (isExplicitDatePattern(text)) return text;
  if (!Number.isNaN(Date.parse(text))) return text;

  return null;
}

export function isDirtySuppValue(field, value) {
  if (isEmptyLiteral(value)) return false;
  if (isRepeatedNullUndefined(value)) return true;

  if (field === 'shelf_life_days') {
    return parseShelfLifeDays(value) === null;
  }

  if (field === 'expire_date_batch') {
    const text = String(value).trim();
    if (/null/i.test(text)) return true;
    return parseExpireDateBatch(value) === null;
  }

  return false;
}

export function sameText(a, b) {
  const left = clean(a);
  const right = clean(b);
  return left !== null && right !== null && left === right;
}

export function isChinaGs1(value) {
  return /^69\d/.test(clean(value) || '');
}

export function isStoreCode(value) {
  return /^2\d/.test(clean(value) || '');
}

export function classifyBarcodeConflict(tencentValue, miniValue) {
  const tencent = clean(tencentValue);
  const mini = clean(miniValue);

  if (isChinaGs1(tencent) && isStoreCode(mini)) return 'keep_tencent';
  if (isStoreCode(tencent) && isChinaGs1(mini)) return 'prefer_mini';
  return 'needs_damon';
}

export function parseImageUrls(value) {
  const text = clean(value);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;

    const urls = parsed.map(clean).filter(Boolean);
    return urls.length ? urls : null;
  } catch {
    return null;
  }
}

export function cleanTsvField(row, field, value) {
  if (isDirtySuppValue(field, value)) {
    row.__dirtyFields[field] = true;
  }

  return clean(value);
}

export function parseTsv(content) {
  const rows = [];
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);

  for (const [index, line] of lines.entries()) {
    const cols = line.split(SEP);
    if (cols.length !== 10) {
      throw new Error(`Invalid TSV column count at line ${index + 1}: ${cols.length}`);
    }

    const row = {};
    Object.defineProperty(row, '__dirtyFields', {
      value: {},
      enumerable: false,
    });

    Object.assign(row, {
      product_code: cleanTsvField(row, 'product_code', cols[0]),
      upc_code: cleanTsvField(row, 'upc_code', cols[1]),
      brand: cleanTsvField(row, 'brand', cols[2]),
      pet_type: cleanTsvField(row, 'pet_type', cols[3]),
      shelf_life_days: cleanTsvField(row, 'shelf_life_days', cols[4]),
      expire_date_batch: cleanTsvField(row, 'expire_date_batch', cols[5]),
      compliance_status: cleanTsvField(row, 'compliance_status', cols[6]),
      shelf_location: cleanTsvField(row, 'shelf_location', cols[7]),
      image_urls: cleanTsvField(row, 'image_urls', cols[8]),
      image_ocr_text: cleanTsvField(row, 'image_ocr_text', cols[9]),
    });

    rows.push(row);
  }

  return rows.filter((row) => row.product_code);
}

export function emptyForField(value) {
  return clean(value) === null;
}

export function suppValueForField(field, value) {
  if (field === 'shelf_life_days') return parseShelfLifeDays(value);
  if (field === 'expire_date_batch') return parseExpireDateBatch(value);
  return clean(value);
}

export function buildPlan(miniRows, tencentRows, suppRows = [], masterRows = []) {
  const tencentByCode = new Map(tencentRows.map((row) => [row.product_code, row]));
  const suppByCode = new Map(suppRows.map((row) => [row.product_code, row]));
  const masterCodes = new Set(masterRows.map((row) => row.product_code));

  const plan = {
    barcodeAdds: [],
    barcodeConsistent: [],
    barcodeConflicts: [],
    suppUpdates: [],
    imageUpdates: [],
    stats: {
      barcode: {
        addable: 0,
        consistent: 0,
        conflict: 0,
        keep_tencent: 0,
        prefer_mini: 0,
        needs_damon: 0,
      },
      supp: Object.fromEntries(
        SUPP_FIELDS.map((field) => [field, { fillable: 0, inconsistent: 0, dirty: 0 }]),
      ),
      images: {
        image_urls: 0,
        image_ocr_text: 0,
      },
    },
  };

  for (const mini of miniRows) {
    const tencent = tencentByCode.get(mini.product_code);
    if (!tencent) continue;

    const miniBarcode = clean(mini.upc_code);
    const tencentBarcode = clean(tencent.barcode);

    if (miniBarcode && !tencentBarcode) {
      plan.barcodeAdds.push({ product_code: mini.product_code, barcode: miniBarcode });
      plan.stats.barcode.addable += 1;
    } else if (miniBarcode && tencentBarcode && sameText(miniBarcode, tencentBarcode)) {
      plan.barcodeConsistent.push({ product_code: mini.product_code });
      plan.stats.barcode.consistent += 1;
    } else if (miniBarcode && tencentBarcode) {
      const resolution = classifyBarcodeConflict(tencentBarcode, miniBarcode);
      plan.barcodeConflicts.push({
        product_code: mini.product_code,
        field: 'barcode',
        tencent_value: tencentBarcode,
        mini_value: miniBarcode,
        resolution,
      });
      plan.stats.barcode.conflict += 1;
      plan.stats.barcode[resolution] += 1;
    }

    const supp = suppByCode.get(mini.product_code) || { product_code: mini.product_code };
    const suppPatch = { product_code: mini.product_code };

    for (const field of SUPP_FIELDS) {
      if (mini.__dirtyFields?.[field] || isDirtySuppValue(field, mini[field])) {
        plan.stats.supp[field].dirty += 1;
        continue;
      }

      const miniValue = suppValueForField(field, mini[field]);
      const tencentValue = clean(supp[field]);
      if (!miniValue) continue;

      if (emptyForField(tencentValue)) {
        suppPatch[field] = miniValue;
        plan.stats.supp[field].fillable += 1;
      } else if (tencentValue !== String(miniValue)) {
        plan.stats.supp[field].inconsistent += 1;
      }
    }

    if (Object.keys(suppPatch).length > 1) {
      plan.suppUpdates.push(suppPatch);
    }

    if (masterCodes.has(mini.product_code)) {
      const urls = parseImageUrls(mini.image_urls);
      const ocrText = clean(mini.image_ocr_text);

      if (urls || ocrText) {
        plan.imageUpdates.push({
          product_code: mini.product_code,
          image_urls: urls,
          image_ocr_text: ocrText,
        });
        if (urls) plan.stats.images.image_urls += 1;
        if (ocrText) plan.stats.images.image_ocr_text += 1;
      }
    }
  }

  return plan;
}
