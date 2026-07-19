var REQUIRED_FIELDS = [
  { key: "customer", label: "客户" },
  { key: "factory", label: "工厂" },
  { key: "product_name", label: "品名" },
  { key: "hs_code", label: "HS" },
  { key: "qty", label: "数量" },
  { key: "trade_terms", label: "成交方式" },
  { key: "destination_port", label: "目的港" },
  { key: "delivery_date", label: "交货期" },
];

function present(v) {
  if (v == null) return false;
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

function positiveQty(v) {
  var n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function firstFilled(values) {
  for (var i = 0; i < values.length; i += 1) {
    if (present(values[i])) return values[i];
  }
  return "";
}

export function getOrderIntakeMissingFields(body) {
  body = body || {};
  var products = Array.isArray(body.products) ? body.products : [];
  var hasLine = products.some(function(p) {
    return p && positiveQty(p.qty || p.quantity || p.qty_ctn);
  });
  var hasProductName = products.some(function(p) {
    return p && present(firstFilled([p.name, p.productName, p.product_name, p.declarationName, p.declaration_name]));
  });
  var hasHs = products.some(function(p) {
    return p && present(firstFilled([p.hsCode, p.hs_code, p.hs]));
  });

  var checks = {
    customer: present(firstFilled([body.companyNameCN, body.companyNameEN, body.customer, body.customerName])),
    factory: present(firstFilled([
      body.factory,
      body.factory_code,
      body.factoryCode,
      body.factoryCompanyCode,
      body.selectedFactoryCode,
      products[0] && (products[0].factory_code || products[0].factoryCode || products[0].factory_name || products[0].factory),
    ])),
    product_name: products.length > 0 && hasProductName,
    hs_code: products.length > 0 && hasHs,
    qty: products.length > 0 && hasLine,
    trade_terms: present(firstFilled([body.trade_terms, body.tradeTerms, body.tradeTerm, body.incoterm])),
    destination_port: present(firstFilled([body.destinationPort, body.destination_port, body.destination, body.pod])),
    delivery_date: present(firstFilled([body.deliveryDate, body.delivery_date, body.requiredArrival, body.requiredArrivalDate, body.expectedDelivery])),
  };

  return REQUIRED_FIELDS.filter(function(f) { return !checks[f.key]; });
}

export function isDraftOrder(body) {
  return body && (body.is_draft === true || body.isDraft === true);
}

export function orderIntakeErrorPayload(missing) {
  var labels = (missing || []).map(function(f) { return f.label; });
  return {
    error: "录单必填项缺失",
    missing: labels,
    missingFields: missing,
    message: "缺少必填项：" + labels.join("、"),
  };
}

export function enforceOrderIntakeGate(req, res) {
  var body = (req && req.body) || {};
  if (isDraftOrder(body)) return false;
  var missing = getOrderIntakeMissingFields(body);
  if (!missing.length) return false;
  res.status(422).json(orderIntakeErrorPayload(missing));
  return true;
}
