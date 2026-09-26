import {
  ORDER_CREATE_PRODUCT_CUSTOMER_SAFE,
  pickByAllowlist,
} from "../lib/customer-safe-fields.js";

function num(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function cleanImages(images) {
  if (Array.isArray(images)) return images;
  if (typeof images === "string" && images.trim()) {
    try {
      var parsed = JSON.parse(images);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function dedupeKey(p) {
  return String((p && (p.sku || p.code || p.barcode || p.name)) || "").trim();
}

function addUnique(map, products) {
  products.forEach(function(p) {
    var key = dedupeKey(p);
    if (!key || map.has(key)) return;
    map.set(key, p);
  });
}

function safeProduct(row) {
  return pickByAllowlist(row, ORDER_CREATE_PRODUCT_CUSTOMER_SAFE);
}

function mapCatalogRow(r) {
  var priceUsd = num(r.cp_price_usd ?? r.price_usd);
  return safeProduct({
    name: r.product_name || r.product_name_cn || "",
    code: r.alias_sku || r.sku || r.barcode || "",
    sku: r.sku || "",
    barcode: r.barcode || "",
    brand: r.brand || "",
    size: r.spec || "",
    unit: "CTN",
    unitPrice: priceUsd,
    price_usd: priceUsd,
    price_cny: num(r.cp_price_cny),
    cbm: 0,
    grossWeight: num(r.gross_weight),
    netWeight: num(r.net_weight),
    innerQty: 0,
    innerUnit: "PCS",
    hsCode: "",
    moq: r.cp_moq || 0,
    leadTimeDays: r.lead_time_days || 0,
    notes: r.cp_notes || "",
    cat1: r.cat1 || "",
    cat2: r.cat2 || "",
    cat3: r.cat3 || "",
    category: r.category || "",
    flavor: r.flavor || "",
    image_url: r.image_url || "",
    images: cleanImages(r.images),
    isAuthorized: true,
    isPublicSupplier: false,
    supplierLabel: "",
  });
}

function mapPublicSupplierRow(r) {
  var priceUsd = num(r.price_usd);
  return safeProduct({
    name: r.product_name || r.product_name_cn || "",
    code: r.sku || r.barcode || "",
    sku: r.sku || "",
    barcode: r.barcode || "",
    brand: r.brand || "",
    size: r.spec || "",
    unit: "CTN",
    unitPrice: priceUsd,
    price_usd: priceUsd,
    price_cny: 0,
    cbm: 0,
    grossWeight: num(r.gross_weight),
    netWeight: num(r.net_weight),
    innerQty: 0,
    innerUnit: "PCS",
    hsCode: "",
    moq: 0,
    leadTimeDays: 0,
    notes: "",
    cat1: r.cat1 || "",
    cat2: r.cat2 || "",
    cat3: r.cat3 || "",
    category: r.category || "",
    flavor: r.flavor || "",
    image_url: r.image_url || "",
    images: cleanImages(r.images),
    isAuthorized: false,
    isPublicSupplier: true,
    supplierLabel: "淘淘",
  });
}

function mapHistoryProduct(p, ord) {
  return safeProduct({
    name: p.name || "",
    code: p.code || p.sku || "",
    sku: p.sku || p.code || "",
    brand: p.brand || "",
    size: p.size || p.spec || "",
    unit: p.unit || "CTN",
    unitPrice: num(p.unitPrice || p.price),
    price_usd: num(p.price_usd || p.unitPrice || p.price),
    price_cny: num(p.price_cny),
    cbm: num(p.cbm),
    grossWeight: num(p.grossWeight),
    netWeight: num(p.netWeight),
    innerQty: p.innerQty || p.bagsPerBox || 0,
    innerUnit: p.innerUnit || "PCS",
    hsCode: p.hsCode || "",
    cat1: p.cat1 || "",
    cat2: p.cat2 || "",
    cat3: p.cat3 || "",
    category: p.category || "",
    flavor: p.flavor || "",
    barcode: p.barcode || "",
    image_url: p.image_url || "",
    images: cleanImages(p.images),
    lastQty: p.qty || 0,
    lastOrderNo: ord.order_no || "",
    lastDate: ord.created_at || null,
    declareAmountPerBox: num(p.declareAmountPerBox),
    vatRate: num(p.vatRate),
    taxRebateRate: num(p.taxRebateRate),
    isAuthorized: false,
    isPublicSupplier: false,
    supplierLabel: "",
  });
}

async function loadCompanyProducts(pool, companyCode) {
  var result = await pool.query(
    `SELECT cp.id AS cp_id,
            cp.alias_sku,
            cp.price_cny AS cp_price_cny,
            cp.price_usd AS cp_price_usd,
            cp.moq AS cp_moq,
            cp.lead_time_days,
            cp.notes AS cp_notes,
            p.sku,
            p.barcode,
            p.product_name,
            p.product_name_cn,
            p.brand,
            p.spec,
            p.gross_weight,
            p.net_weight,
            p.cat1,
            p.cat2,
            p.cat3,
            p.category,
            p.flavor,
            p.image_url,
            p.images,
            p.price_usd
       FROM company_products cp
       JOIN customers cust ON cust.id = cp.company_id
       JOIN products p ON p.id = cp.product_id
      WHERE cust.company_code = $1
        AND cp.active = true
      ORDER BY COALESCE(p.product_name, p.product_name_cn, p.sku, '')`,
    [companyCode]
  );
  return result.rows || [];
}

async function loadPublicSupplierProducts(pool) {
  var result = await pool.query(
    `SELECT p.sku,
            p.barcode,
            p.product_name,
            p.product_name_cn,
            p.brand,
            p.spec,
            p.gross_weight,
            p.net_weight,
            p.cat1,
            p.cat2,
            p.cat3,
            p.category,
            p.flavor,
            p.image_url,
            p.images,
            p.price_usd
       FROM products p
      WHERE COALESCE(p.is_public_supplier, false) = true
      ORDER BY COALESCE(p.cat1, p.cat2, p.cat3, p.category, ''),
               COALESCE(p.brand, ''),
               COALESCE(p.product_name, p.product_name_cn, p.sku, '')`
  );
  return result.rows || [];
}

async function loadHistoryProducts(pool, companyCode) {
  var recentOrders = await pool.query(
    "SELECT products, customer_po, order_no, created_at FROM orders WHERE company_code = $1 AND products IS NOT NULL ORDER BY created_at DESC LIMIT 10",
    [companyCode]
  );
  var productMap = new Map();
  (recentOrders.rows || []).forEach(function(ord) {
    var prods = [];
    try {
      prods = typeof ord.products === "string" ? JSON.parse(ord.products) : (ord.products || []);
    } catch (_) {}
    if (!Array.isArray(prods)) return;
    prods.forEach(function(p) {
      var product = mapHistoryProduct(p || {}, ord);
      var key = dedupeKey(product);
      if (key && !productMap.has(key)) productMap.set(key, product);
    });
  });
  return {
    products: Array.from(productMap.values()),
    orderCount: (recentOrders.rows || []).length,
  };
}

async function loadDefaults(pool, companyCode) {
  var result = await pool.query(
    "SELECT country, destination_port, customer_address, consignee, currency FROM orders WHERE company_code = $1 ORDER BY created_at DESC LIMIT 1",
    [companyCode]
  ).catch(function() { return { rows: [] }; });
  return result.rows[0] || {};
}

export async function getCustomerProductsCatalog(pool, companyCode) {
  var baseProducts = [];
  var source = "order_history";
  var orderCount = 0;
  var defaults = {};

  try {
    var cpRows = await loadCompanyProducts(pool, companyCode);
    if (cpRows.length > 0) {
      baseProducts = cpRows.map(mapCatalogRow);
      source = "company_products";
    }
  } catch (_) {
    baseProducts = [];
  }

  if (baseProducts.length === 0) {
    var history = await loadHistoryProducts(pool, companyCode);
    baseProducts = history.products;
    orderCount = history.orderCount;
    defaults = await loadDefaults(pool, companyCode);
  }

  var publicRows = await loadPublicSupplierProducts(pool);
  var publicProducts = publicRows.map(mapPublicSupplierRow);
  var merged = new Map();
  addUnique(merged, baseProducts);
  addUnique(merged, publicProducts);

  var products = Array.from(merged.values());
  return {
    products: products,
    orderCount: orderCount,
    defaults: defaults,
    source: publicProducts.length > 0 ? source + "+public_supplier" : source,
    authorizedCount: products.filter(function(p) { return p.isAuthorized; }).length,
    publicSupplierCount: products.filter(function(p) { return p.isPublicSupplier; }).length,
  };
}
