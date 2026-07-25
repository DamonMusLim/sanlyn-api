import assert from "node:assert/strict";
import { findReusableLink, normalizeScope } from "./collab-link-reuse-helper.mjs";

assert.equal(
  normalizeScope({ order_no: "SO-1", company_code: "ACME" }),
  normalizeScope({ company_code: "ACME", order_no: "SO-1" })
);

assert.equal(
  normalizeScope({ company_code: " ACME ", factory_code: " F01 ", bl_no: " BL9 ", order_no: " SO1 ", contract_no: " CT1 " }),
  normalizeScope({ company_code: "acme", factory_code: "f01", bl_no: "bl9", order_no: "so1", contract_no: "ct1" })
);

assert.equal(
  normalizeScope({ container_nos: ["C2", "C1", "C2", ""] }),
  normalizeScope({ container_nos: ["C1", "C2"] })
);

assert.equal(
  normalizeScope({ order_no: "SO-1", bl_no: "", ignored: "x", segments: [] }),
  normalizeScope({ order_no: "SO-1" })
);

// factory_scope: object subset {label,code,id} defines scope; key order & code case normalized
assert.equal(
  normalizeScope({ factory_scope: { code: "F01", label: "Acme", id: 7, junk: "z" } }),
  normalizeScope({ factory_scope: { id: 7, label: "Acme", code: "f01" } })
);
// different factory_scope must NOT collide
assert.notEqual(
  normalizeScope({ factory_scope: { code: "F01" } }),
  normalizeScope({ factory_scope: { code: "F99" } })
);
// empty/invalid factory_scope is dropped (same as absent)
assert.equal(
  normalizeScope({ order_no: "SO-1", factory_scope: {} }),
  normalizeScope({ order_no: "SO-1" })
);

{
  const row = {
    id: 7,
    recipient_role: "factory_booking",
    meta: JSON.stringify({ company_code: "ACME", order_no: "SO-1", container_nos: ["C2", "C1"] }),
    expires_at: "2099-01-01T00:00:00Z",
  };
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [row] };
    },
  };
  const found = await findReusableLink(pool, "factory_booking", {
    container_nos: ["C1", "C2"],
    order_no: "so-1",
    company_code: "acme",
  });
  assert.equal(found, row);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ["factory_booking"]);
  assert.match(calls[0].sql, /WHERE recipient_role = \$1/);
  assert.match(calls[0].sql, /expires_at IS NULL OR expires_at > NOW\(\)/);
}

{
  const pool = {
    async query() {
      return {
        rows: [
          { id: 1, recipient_role: "factory_booking", meta: { company_code: "other", order_no: "SO-1" } },
        ],
      };
    },
  };
  const found = await findReusableLink(pool, "factory_booking", { company_code: "acme", order_no: "SO-1" });
  assert.equal(found, null);
}

console.log("collab-link-reuse-helper tests passed");
