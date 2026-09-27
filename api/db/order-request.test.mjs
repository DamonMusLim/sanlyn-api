import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const {
  canAccessRequest,
  sanitizeForAudience,
  orderRequestFormConfig,
} = await import("./lib/order-request.js");

const row = {
  id: "or_test",
  channel: "factory",
  buyer_company_code: "BABI",
  factory_company_code: "F001",
  status: "submitted",
  customer_po: "PO-SECRET",
  lines: [{
    sku: "SKU-1",
    product_name: "Toy",
    unit_price: 9.9,
    customer_amount: 99,
    factory_price: 5.5,
    factory_amount: 55,
    factory_code: "F001",
  }],
  files: [],
  created_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-27T00:00:00Z",
};
const customerRow = { ...row, channel: "customer" };

const factoryUser = { role: "factory", companyCode: "F001" };
const otherFactory = { role: "factory", companyCode: "F999" };
const customerUser = { role: "customer", companyCodes: ["BABI"] };
const otherCustomer = { role: "customer", companyCodes: ["C999"] };

assert.equal(canAccessRequest(factoryUser, row), true);
assert.equal(canAccessRequest(otherFactory, row), false);
assert.equal(canAccessRequest(customerUser, row), false);
assert.equal(canAccessRequest(customerUser, customerRow), true);
assert.equal(canAccessRequest(otherCustomer, row), false);

const factoryView = sanitizeForAudience(row, factoryUser);
assert.equal("buyer_company_code" in factoryView, false);
assert.equal("customer_po" in factoryView, false);
assert.equal("unit_price" in factoryView.lines[0], false);
assert.equal("customer_amount" in factoryView.lines[0], false);
assert.equal(factoryView.lines[0].factory_price, 5.5);

const customerView = sanitizeForAudience(customerRow, customerUser);
assert.equal(customerView.buyer_company_code, "BABI");
assert.equal("factory_company_code" in customerView, false);
assert.equal("factory_price" in customerView.lines[0], false);
assert.equal("factory_amount" in customerView.lines[0], false);
assert.equal(customerView.lines[0].unit_price, 9.9);

assert.deepEqual(orderRequestFormConfig(factoryUser).buyer, {
  fixed: true,
  companyCode: "BABI",
  name: "厦门巴匕进出口有限公司",
});

console.log("order-request tests passed");
