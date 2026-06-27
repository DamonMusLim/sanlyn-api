import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  resolveCompany,
  recordResolution,
  enforcementMode,
  confidenceTier,
} from "./_entity-resolve.js";

const SOURCE_TYPES = new Set(["manual", "excel", "ai", "ocr"]);

const PARTY_META = {
  customer: {
    required: true,
    entityType: "customer",
    hardRole: true,
    label: "客户",
  },
  seller: {
    required: false,
    entityType: "sanlyn_entity",
    hardRole: false,
    label: "卖方",
  },
  factory: {
    required: true,
    entityType: "factory",
    hardRole: true,
    label: "工厂",
  },
  consignee: {
    required: false,
    entityType: null,
    hardRole: false,
    label: "收货人",
  },
};

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function partyInput(parties, role) {
  const p = parties && typeof parties === "object" ? parties[role] || {} : {};
  const code = cleanText(p.code);
  const text = cleanText(p.text);
  return {
    code,
    text,
    query: code || text,
    used: code ? "code" : text ? "text" : null,
  };
}

function companyCodeOf(result) {
  return result?.ok && result.company ? cleanText(result.company.code) : "";
}

function companyTypeOf(result) {
  return result?.ok && result.company ? cleanText(result.company.type) : "";
}

function candidatesOf(result) {
  if (Array.isArray(result?.candidates)) return result.candidates;
  if (result?.ok && result.company) {
    return [{
      code: result.company.code,
      name_cn: result.company.name_cn,
      type: result.company.type,
      confidence: result.confidence,
      via: result.via,
    }];
  }
  return [];
}

function addWarning(warnings, role, code, message, details = {}) {
  const item = { role, code, message, ...details };
  warnings.push(item);
  return item;
}

function roleCheck(role, result) {
  if (!result?.ok) return { role_ok: false, warning: null };

  const type = companyTypeOf(result);
  const expected = PARTY_META[role].entityType;

  // consignee 只做解析提示，不强制公司类型。
  if (role === "consignee") return { role_ok: true, warning: null };

  if (!type) {
    return { role_ok: false, warning: "角色待确认" };
  }

  if (role === "seller") {
    // 卖方可能是外部代理；只要解析到实体就不阻断，非 sanlyn_entity 只提示。
    if (type !== "sanlyn_entity") {
      return { role_ok: true, warning: "卖方不是Sanlyn内部出口主体，请人工确认是否为外部代理" };
    }
    return { role_ok: true, warning: null };
  }

  if (type !== expected) {
    return { role_ok: false, warning: `角色不匹配：期望${expected}，实际${type}` };
  }

  return { role_ok: true, warning: null };
}

function buildPartyResponse(role, input, result, roleState) {
  const resolvedCode = companyCodeOf(result);
  const canonicalRedirect =
    Boolean(input.code) &&
    result?.ok &&
    result.via === "alias" &&
    resolvedCode &&
    resolvedCode !== input.code;

  return {
    input: {
      code: input.code || null,
      text: input.text || null,
      used: input.used,
    },
    resolved_code: resolvedCode || null,
    canonical_code: resolvedCode || null,
    canonical_redirect: canonicalRedirect,
    role_ok: roleState.role_ok,
    confidence: result?.ok ? result.confidence : null,
    tier: result?.ok ? confidenceTier(result.confidence || 0) : "manual",
    via: result?.ok ? result.via : null,
    warning: roleState.warning || (!result?.ok ? result?.need || "unresolved" : null),
  };
}

async function recordPartyShadow(pool, sourceType, enforcement, role, input, result, reviewedBy) {
  const companyCode = companyCodeOf(result);
  const domainKeyCode = companyCode || input.code || input.text || "unknown";

  await recordResolution(pool, {
    domain_key: `${sourceType}+${role}+${domainKeyCode}`,
    source_type: sourceType,
    entity_type: PARTY_META[role].entityType || role,
    raw_text: input.query || "",
    candidates: candidatesOf(result),
    suggested_company_code: companyCode || null,
    confidence: result?.ok ? result.confidence : null,
    chosen_company_code: null,
    outcome: "pending",
    enforcement,
    is_critical: Boolean(PARTY_META[role].required),
    reviewed_by: reviewedBy || null,
  });
}

async function checkDuplicateOrderRef(pool, orderRef) {
  const ref = cleanText(orderRef);
  if (!ref) return null;

  // order_ref 只查重不写主表；按实际存在字段动态拼 WHERE，避免老环境列缺失导致端点失败。
  const cols = await pool.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name in ('order_no', 'contract_no', 'customer_po')
  `);

  const names = cols.rows.map(r => r.column_name);
  if (!names.length) return null;

  const where = names.map((name, idx) => `${name} = $${idx + 1}`).join(" or ");
  const sql = `
    select ${names.join(", ")}
    from orders
    where ${where}
    limit 5
  `;
  const found = await pool.query(sql, names.map(() => ref));
  return found.rows.length ? found.rows : null;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const body = req.body || {};
  const sourceType = cleanText(body.source_type || "manual").toLowerCase();

  if (!SOURCE_TYPES.has(sourceType)) {
    return res.status(400).json({
      ok: false,
      error: "invalid_source_type",
      message: "source_type must be manual/excel/ai/ocr",
    });
  }

  const pool = getPool();
  const enforcement = enforcementMode(sourceType);
  const isHard = enforcement === "hard";
  const warnings = [];
  const partiesOut = {};
  let blocking = false;

  try {
    for (const role of ["customer", "seller", "factory", "consignee"]) {
      const meta = PARTY_META[role];
      const input = partyInput(body.parties, role);
      let result = { ok: false, need: "missing_input" };

      if (!input.query) {
        if (meta.required) {
          addWarning(warnings, role, "missing_required", `${meta.label}必填`);
          if (isHard) blocking = true;
        } else if (role === "seller") {
          addWarning(warnings, role, "seller_recommended", "卖方建议填写");
        }

        const roleState = { role_ok: false, warning: result.need };
        partiesOut[role] = buildPartyResponse(role, input, result, roleState);
        continue;
      }

      // 复用P0解析：客户/工厂传入强类型；卖方/收货人先解析实体，类型差异后置为warning。
      // 审码修正(Claude 2026-06-28):不把role传给resolveCompany,否则模块按type过滤会把
      // 卖方(sanlyn_entity)/收货人(无对应type)/空type客户直接拒成role_mismatch。
      // 角色判断全部交给下面的 roleCheck(它能正确处理 空type→待确认/卖方宽松/客户工厂硬校验)。
      const resolveOptions = {
        sourceType,
        entityType: meta.entityType,
      };

      result = await resolveCompany(pool, input.query, resolveOptions);
      const roleState = roleCheck(role, result);
      const partyOut = buildPartyResponse(role, input, result, roleState);
      partiesOut[role] = partyOut;

      await recordPartyShadow(
        pool,
        sourceType,
        enforcement,
        role,
        input,
        result,
        req.user?.email || req.user?.username || req.user?.id || req.user?.role,
      );

      if (partyOut.canonical_redirect) {
        addWarning(warnings, role, "canonical_redirect", "输入旧码已合并，已重定向到canonical公司码", {
          input_code: input.code,
          canonical_code: partyOut.canonical_code,
        });
      }

      if (!result.ok) {
        addWarning(warnings, role, result.need || "unresolved", `${meta.label}未解析`, {
          input: input.query,
        });
        if (isHard && meta.required) blocking = true;
        continue;
      }

      if (roleState.warning) {
        addWarning(warnings, role, "role_warning", roleState.warning, {
          resolved_code: partyOut.resolved_code,
          company_type: companyTypeOf(result) || null,
        });
      }

      if (isHard && meta.hardRole && !roleState.role_ok) {
        blocking = true;
      }
    }

    const duplicate = await checkDuplicateOrderRef(pool, body.order_ref);
    if (duplicate) {
      addWarning(warnings, "order_ref", "duplicate_order_ref", "order_ref疑似重复", {
        order_ref: cleanText(body.order_ref),
        matches: duplicate,
      });
    }

    if (
      partiesOut.customer?.resolved_code &&
      partiesOut.consignee?.resolved_code &&
      partiesOut.customer.resolved_code !== partiesOut.consignee.resolved_code
    ) {
      addWarning(warnings, "consignee", "consignee_differs_from_customer", "收货人与客户不同，请人工确认", {
        customer_code: partiesOut.customer.resolved_code,
        consignee_code: partiesOut.consignee.resolved_code,
      });
    }

    return res.status(200).json({
      ok: !blocking,
      source_type: sourceType,
      enforcement,
      blocking,
      parties: partiesOut,
      warnings,
    });
  } catch (err) {
    console.error("[order-intake-validate]", err);
    return res.status(500).json({
      ok: false,
      error: "order_intake_validate_failed",
      message: err.message,
    });
  }
}
