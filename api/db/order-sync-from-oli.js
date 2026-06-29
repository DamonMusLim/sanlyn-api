function toNumber(value) {
  var n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, places) {
  var factor = Math.pow(10, places);
  return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  var n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function key(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function buildOldProductMap(raw) {
  var products = raw && Array.isArray(raw.products) ? raw.products : [];
  var byKey = {};
  products.forEach(function(product) {
    if (!product || typeof product !== "object") return;
    var sku = key(product.sku);
    var name = key(product.product_name || product.productName || product.name);
    if (sku && !byKey[sku]) byKey[sku] = product;
    if (name && !byKey[name]) byKey[name] = product;
  });
  return byKey;
}

function lineSubtotal(row) {
  var subtotal = numericOrNull(row.subtotal);
  if (subtotal !== null) return subtotal;
  return toNumber(row.qty_ctn) * toNumber(row.unit_price);
}

function lineFactorySubtotal(row) {
  var subtotal = numericOrNull(row.factory_subtotal);
  if (subtotal !== null) return subtotal;
  return toNumber(row.qty_ctn) * toNumber(row.factory_price);
}

function productFromLine(row, oldByKey) {
  var sku = key(row.sku);
  var name = key(row.product_name);
  var qty = toNumber(row.qty_ctn);
  var cbm = toNumber(row.cbm_ctn);
  var base = { ...(oldByKey[sku] || oldByKey[name] || {}) };

  return {
    ...base,
    qty: numericOrNull(row.qty_ctn) ?? 0,
    sku: row.sku,
    name: row.product_name,
    brand: row.brand,
    unit: row.unit,
    size: row.size,
    bgBx: numericOrNull(row.bg_bx),
    unitPrice: numericOrNull(row.unit_price),
    factoryPrice: numericOrNull(row.factory_price),
    subtotal: round(lineSubtotal(row), 2),
    factorySubtotal: round(lineFactorySubtotal(row), 2),
    cbm: numericOrNull(row.cbm_ctn),
    totalCbm: round(qty * cbm, 6),
    netWeight: numericOrNull(row.nw_ctn),
    grossWeight: numericOrNull(row.gw_ctn),
    hsCode: row.hs_code,
    vatRate: numericOrNull(row.vat_rate),
    taxRebateRate: numericOrNull(row.tax_rebate_rate),
    declareAmountPerBox: numericOrNull(row.declare_amount_per_box),
    declarationName: row.declaration_name,
    blDescription: row.bl_description,
  };
}

function compute(rows) {
  var totalQty = 0;
  var totalCbm = 0;
  var grossWeight = 0;
  var netWeight = 0;
  var factoryAmount = 0;
  var customerAmount = 0;
  var declareAmount = 0;
  var taxRebateAmount = 0;

  rows.forEach(function(row) {
    var qty = toNumber(row.qty_ctn);
    var declarePerBox = toNumber(row.declare_amount_per_box);

    totalQty += qty;
    totalCbm += qty * toNumber(row.cbm_ctn);
    grossWeight += qty * toNumber(row.gw_ctn);
    netWeight += qty * toNumber(row.nw_ctn);
    factoryAmount += lineFactorySubtotal(row);
    customerAmount += lineSubtotal(row);
    declareAmount += qty * declarePerBox;
    taxRebateAmount += qty * declarePerBox * toNumber(row.tax_rebate_rate);
  });

  factoryAmount = round(factoryAmount, 2);
  customerAmount = round(customerAmount, 2);
  var marginAmount = round(customerAmount - factoryAmount, 2);

  return {
    total_qty: totalQty,
    total_cbm: round(totalCbm, 6),
    gross_weight: round(grossWeight, 4),
    net_weight: round(netWeight, 4),
    factory_amount: factoryAmount,
    customer_amount: customerAmount,
    total_amount: customerAmount,
    total_amount_factory: factoryAmount,
    declare_amount: round(declareAmount, 2),
    tax_rebate_amount: round(taxRebateAmount, 2),
    margin_amount: marginAmount,
    margin_pct: factoryAmount > 0 ? round((marginAmount / factoryAmount) * 100, 2) : 0,
  };
}

export async function syncOrderFromOLI(client, orderId) {
  var id = parseInt(orderId);
  if (!id) throw new Error("orderId required");

  var lineResult = await client.query(
    `SELECT sku, product_name, brand, bg_bx, qty_ctn, unit, unit_price,
            factory_price, subtotal, factory_subtotal, nw_ctn, gw_ctn,
            cbm_ctn, size, hs_code, declaration_name, declaration_name_en,
            bl_description, vat_rate, tax_rebate_rate,
            declare_amount_per_box, barcode, product_id
       FROM order_line_items
      WHERE order_id = $1
      ORDER BY sort_order ASC, id ASC`,
    [id]
  );

  var orderResult = await client.query("SELECT raw FROM orders WHERE id = $1", [id]);
  if (!orderResult.rows.length) throw new Error("Order " + id + " not found");

  var rows = lineResult.rows;
  var scalars = compute(rows);
  var oldByKey = buildOldProductMap(orderResult.rows[0].raw);
  var newProducts = rows.map(function(row) {
    return productFromLine(row, oldByKey);
  });

  await client.query(
    `UPDATE orders SET
       total_qty            = $2,
       total_cbm            = $3,
       gross_weight         = $4,
       net_weight           = $5,
       factory_amount       = $6,
       customer_amount      = $7,
       total_amount         = $8,
       total_amount_factory = $9,
       declare_amount       = $10,
       tax_rebate_amount    = $11,
       margin_amount        = $12,
       margin_pct           = $13,
       raw                  = jsonb_set(COALESCE(raw, '{}'::jsonb), '{products}', $14::jsonb, true),
       updated_at           = now()
     WHERE id = $1`,
    [
      id,
      scalars.total_qty,
      scalars.total_cbm,
      scalars.gross_weight,
      scalars.net_weight,
      scalars.factory_amount,
      scalars.customer_amount,
      scalars.total_amount,
      scalars.total_amount_factory,
      scalars.declare_amount,
      scalars.tax_rebate_amount,
      scalars.margin_amount,
      scalars.margin_pct,
      JSON.stringify(newProducts),
    ]
  );

  return scalars;
}
