// Customer statement portal — document attachment index (真源 document_files + bank_slips).
// 只暴露客户面单据:提单/发票/装箱单/合同/检疫证。
// 绝不暴露 'other'(内含货代账单/结算清单=我方成本)、customs_decl/customs_release(报关单含工厂抬头=跳单风险)、
// bank_receipt(我方付工厂水单)。新增 doc_kind 默认不可见,必须显式加进白名单。
import { clean } from "./statement-portal-helpers.js";

// Damon 2026-07-19: 客户对账单只给两类——产品行=IV(我们开客户的发票),物流行=BL提单。
// PL/SC/PI/CO/证书全部不给(报关套件是内部资料);海运是海运、物品是物品,单据不跨行类。
export const CUSTOMER_DOC_KINDS = ["BL", "IV"];

// UI label key per kind (i18n key in statement-portal.html dict; falls back to kind).
export const DOC_LABEL_KEY = {
  BL: "doc_bl", IV: "doc_iv", PL: "doc_pl", PI: "doc_pi", SC: "doc_sc", CO: "doc_co",
  health_cert: "doc_cert", phyto_cert: "doc_cert", vet_cert: "doc_cert",
  halal_cert: "doc_cert", fumigation: "doc_cert",
};

const DOC_SQL = `
WITH ords AS (
  SELECT id, order_no, bl_no, contract_no
    FROM orders
   WHERE company_code = $1
     AND deleted_at IS NULL
     AND COALESCE(status, '') <> 'cancelled'
),
bl_docs AS (
  SELECT DISTINCT ON (o.bl_no, df.doc_kind)
         'bl'::text AS match_type, o.bl_no AS match_key,
         df.id, df.doc_kind, df.display_name, df.uploaded_at
    FROM ords o
    JOIN shipping_plans sp ON (sp.bl_no = o.bl_no OR sp.hbl_no = o.bl_no)
    JOIN document_files df
      ON df.bound_subject_type = 'shipping_plan'
     AND df.bound_subject_id = sp.id::text
   WHERE NULLIF(o.bl_no, '') IS NOT NULL
     AND df.deleted_at IS NULL
     AND df.doc_kind = ANY($2::text[])
   ORDER BY o.bl_no, df.doc_kind, df.version DESC, df.uploaded_at DESC
),
order_docs AS (
  SELECT DISTINCT ON (o.order_no, df.doc_kind)
         'order'::text AS match_type, o.order_no AS match_key,
         df.id, df.doc_kind, df.display_name, df.uploaded_at
    FROM ords o
    JOIN document_files df
      ON df.bound_subject_type = 'order'
     AND df.bound_subject_id = o.id::text
   WHERE df.deleted_at IS NULL
     AND df.doc_kind = ANY($2::text[])
   ORDER BY o.order_no, df.doc_kind, df.version DESC, df.uploaded_at DESC
)
SELECT * FROM bl_docs
UNION ALL
SELECT * FROM order_docs`;

// Payment slips the customer themselves uploaded / that were matched to their
// orders. Only rows with a real file are exposed — no file, no link.
const SLIP_SQL = `
WITH ords AS (
  SELECT order_no, bl_no, contract_no
    FROM orders
   WHERE company_code = $1
     AND deleted_at IS NULL
     AND COALESCE(status, '') <> 'cancelled'
)
SELECT DISTINCT
       COALESCE(NULLIF(l.order_no, ''), '') AS order_no,
       COALESCE(NULLIF(l.bl_no, ''), '')    AS bl_no,
       bs.id, bs.payment_date, bs.amount, bs.currency
  FROM bank_slip_links l
  JOIN bank_slips bs ON bs.id = l.slip_id
 WHERE NULLIF(bs.file_url, '') IS NOT NULL
   AND (
     l.order_no    IN (SELECT order_no    FROM ords WHERE NULLIF(order_no, '')    IS NOT NULL)
  OR l.bl_no       IN (SELECT bl_no       FROM ords WHERE NULLIF(bl_no, '')       IS NOT NULL)
  OR l.contract_no IN (SELECT contract_no FROM ords WHERE NULLIF(contract_no, '') IS NOT NULL)
   )`;

function push(map, key, value) {
  const k = clean(key);
  if (!k) return;
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(value);
}

// Build the full set of documents this customer scope may see, indexed by the
// keys a statement row carries (bl_no / order_no).
export async function fetchCustomerDocIndex(pool, scopeCode) {
  const [docs, slips] = await Promise.all([
    pool.query(DOC_SQL, [scopeCode, CUSTOMER_DOC_KINDS]),
    pool.query(SLIP_SQL, [scopeCode]),
  ]);
  const byBl = new Map();
  const byOrder = new Map();
  const allowed = new Set();

  for (const d of docs.rows) {
    const item = {
      ref: `df:${d.id}`,
      kind: d.doc_kind,
      label_key: DOC_LABEL_KEY[d.doc_kind] || null,
      name: d.display_name || `${d.doc_kind}.pdf`,
    };
    allowed.add(item.ref);
    push(d.match_type === "bl" ? byBl : byOrder, d.match_key, item);
  }

  const slipsByBl = new Map();
  const slipsByOrder = new Map();
  for (const s of slips.rows) {
    const item = {
      ref: `bs:${s.id}`,
      kind: "slip",
      label_key: "doc_slip",
      name: [s.payment_date ? String(s.payment_date).slice(0, 10) : null,
             s.amount != null ? `${s.currency || ""} ${s.amount}`.trim() : null]
        .filter(Boolean).join(" · ") || `slip #${s.id}`,
    };
    allowed.add(item.ref);
    if (s.bl_no) push(slipsByBl, s.bl_no, item);
    if (s.order_no) push(slipsByOrder, s.order_no, item);
  }

  return { byBl, byOrder, slipsByBl, slipsByOrder, allowed };
}

function collect(row, index) {
  const out = [];
  const seen = new Set();
  const add = (list) => {
    for (const it of list || []) {
      if (seen.has(it.ref)) continue;
      seen.add(it.ref);
      out.push(it);
    }
  };
  const orderNos = row.order_nos && row.order_nos.length ? row.order_nos : [row.order_no];
  if (clean(row.category) === "logistics") {
    // 物流行: 提单(海运是海运) + 运费借记单(海运费+港杂费,现生成)
    add((index.byBl.get(clean(row.bl_no)) || []).filter((it) => it.kind === "BL"));
    const bl = clean(row.bl_no);
    if (bl) {
      out.push({ ref: `gen:freight:${bl}`, kind: "DN", label_key: "doc_freight", name: "Freight Invoice " + bl });
      seen.add(`gen:freight:${bl}`);
    }
  } else {
    // 产品行: IV=按订单数据现生成(Damon 07-19:订单在=发票在,不依赖上传文件;报关套件是我们的)
    const nos = orderNos.map(clean).filter(Boolean);
    if (nos.length) {
      out.push({ ref: `gen:iv:${nos.join(",")}`, kind: "IV", label_key: "doc_iv",
                 name: "Invoice " + nos.join(" + ") });
      seen.add(`gen:iv:${nos.join(",")}`);
    }
  }
  const slips = [];
  const seenSlip = new Set();
  for (const it of [...(index.slipsByBl.get(clean(row.bl_no)) || []),
                    ...orderNos.flatMap((o) => index.slipsByOrder.get(clean(o)) || [])]) {
    if (seenSlip.has(it.ref)) continue;
    seenSlip.add(it.ref);
    slips.push(it);
  }
  return { docs: out, slips };
}

// Attach docs/slips to already-built public rows. Empty arrays are kept so the
// frontend can distinguish "none on file" from "not loaded" — it must not invent links.
export function attachDocs(rows, index) {
  for (const row of rows) {
    const { docs, slips } = collect(row, index);
    row.docs = docs;
    row.slips = slips;
  }
  return rows;
}

// Reused: statement-portal-helpers.clean, document_files/bank_slips/bank_slip_links真源.
// Final line count after this edit: 158.
