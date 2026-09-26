// customs-declaration-form-lib.js — 报关单公共库（对外入口不变）
// 0926 拆分：纯工具在 -fmt.js，读库在 -load.js，本文件只留渲染行/汇总，并原样转出另两个文件的全部导出，
// 所以 customs-declaration-form.js / customs-doc-quality-gate.js 的 import 一个字都不用改。
import { blank, clean, esc, fmtInt, fmtM, parseRaw, pick } from "./customs-declaration-form-fmt.js";
export * from "./customs-declaration-form-fmt.js";
export * from "./customs-declaration-form-load.js";

export function cell(label, value, cls, field) {
  var fa = field ? ` data-field="${field}"` : "";
  return `<div class="cell ${cls || ""}"><div class="lbl">${esc(label)}</div><div class="val"${fa}>${blank(value)}</div></div>`;
}

export function bigCell(label, value, field) {
  var fa = field ? ` data-field="${field}"` : "";
  return `<div class="cell wide"><div class="lbl">${esc(label)}</div><div class="val"${fa}>${blank(value)}</div></div>`;
}

// 报关单「商品名称及规格型号」栏的申报要素写法(2026-08-08 对照真实海关单修正)
// 实样(海关出的 COAU9506731780 膨润土猫砂):
//   膨润土猫砂
//   0|1|宠物清洁用|蒙脱石70%-80%,水10%,二氧化硅5%-15%|15.6KG/BAG|无中文或外文品牌|无型号
// → 只写【值】,用 | 分隔,**不写"1:品牌类型:"这种序号和标签**。
// 我们库里 products.declaration_elements 是带标签存的(便于人看/校验),
// 印到报关单上必须剥掉标签。Damon 2026-08-08:「猫砂下面没有写这些的」。
export function declElementsForCustoms(v, spec) {
  var raw = clean(v);
  if (!raw) return "";
  var parsed = raw.split("|").map(function (part) {
    var t = String(part || "").trim();
    if (!t) return null;
    var m = /^\s*(\d+)\s*:\s*([^:：]+?)\s*[:：]\s*([\s\S]*)$/.exec(t);
    if (m) return { name: m[2].trim(), val: m[3].trim() };
    var m2 = /^\s*([^:：]{1,14})\s*[:：]\s*([\s\S]*)$/.exec(t);
    if (m2 && /品牌|用途|成分|材质|型号|规格|享惠|类型|等级|种类|包装/.test(m2[1])) {
      return { name: m2[1].trim(), val: m2[2].trim() };
    }
    return { name: "", val: t };
  }).filter(Boolean);

  // 有 HS 规格 → 只印规格里列的项、按规格顺序（项数由 HS 定，不是全印）
  if (spec && spec.length) {
    return spec.map(function (nm) {
      var hit = parsed.find(function (p) { return p.name === nm; });
      return hit ? hit.val : "";
    }).join("|");
  }
  return parsed.map(function (p) { return p.val; }).filter(Boolean).join("|");
}

// 拉某些 HS 的申报要素规格（哪几项、什么顺序）。查不到就返回空 → 按老行为全印。
export async function loadHsDeclSpecs(pool, hsCodes) {
  var out = {};
  try {
    var codes = (hsCodes || []).filter(Boolean);
    if (!codes.length) return out;
    var r = await pool.query(
      "SELECT hs_code, element_name FROM hs_declaration_specs WHERE hs_code = ANY($1::text[]) ORDER BY hs_code, seq",
      [codes]
    );
    (r.rows || []).forEach(function (x) {
      (out[x.hs_code] || (out[x.hs_code] = [])).push(x.element_name);
    });
  } catch (e) { console.warn("[customs] loadHsDeclSpecs 失败(按老行为全印):", e.message); }
  return out;
}

export function cargoRows(lines, destination, sourceArea, hsSpecs) {
  if (!lines.length) {
    return `<tr><td colspan="9" class="empty-row">无货物明细</td></tr>`;
  }
  // 2026-07-06: SQL已按hs_code唯一分组(见loadLines name_by_hs),每行天然对应唯一HS,不再需要按HS去重申报要素
  // (旧逻辑按"见过的HS"清空后续行文字,同HS下不同品名如"宠物罐头/宠物软罐头"被误判成重复行,第二行整段申报要素被清空——已改成SQL层合并解决)
  return lines.map(function (l, i) {
    var qty = [
      // 2026-08-04: 原为 0 位小数，71,354.40→71354，与箱单/汇总栏对不上(报关行据此报"不一样")。
      // 件数保持整数(箱/袋本就是整数)，重量一律两位。
      fmtM(l.net_weight_kg, 2) ? fmtM(l.net_weight_kg, 2) + "千克" : "",
      fmtInt(l.qty_ctn) ? fmtInt(l.qty_ctn) + "箱" : "",
    ].filter(Boolean).join("<br>");
    // 单价精度: 两位能精确表示就两位(55.30), 否则最多5位并去尾零(56.155), 保证 单价×数量=总价
    var _upn = Number(l.unit_price);
    var _up = !Number.isFinite(_upn) ? "" :
      (Math.abs(Number(_upn.toFixed(2)) - _upn) < 1e-9
        ? fmtM(_upn, 2)
        : _upn.toFixed(5).replace(/0+$/, "").replace(/\.$/, ""));
    var money = [
      _up,
      fmtM(l.total_amount, 2),
      "人民币",
    ].filter(Boolean).join("<br>");
    var elements = declElementsForCustoms(l.declaration_elements, (hsSpecs||{})[clean(l.hs_code)]);
    var name = [clean(l.declaration_name), elements].filter(Boolean).map(esc).join("<br>");
    return `<tr>
      <td data-field="item_no" data-row="${i}">${i + 1}</td>
      <td data-field="hs_code" data-row="${i}">${blank(l.hs_code)}</td>
      <td class="goods-name" data-field="goods_name" data-row="${i}">${name || '<span class="empty">—</span>'}</td>
      <td data-field="qty_unit" data-row="${i}">${qty || '<span class="empty">—</span>'}</td>
      <td data-field="price_amount_currency" data-row="${i}">${money || '<span class="empty">—</span>'}</td>
      <td data-field="origin_country" data-row="${i}">中国(CHN)</td>
      <td data-field="dest_country" data-row="${i}">${blank(destination)}</td>
      <td data-field="source_area" data-row="${i}">${clean(l.origin) ? esc(clean(l.origin)) : (sourceArea ? esc(sourceArea) : '<span class="empty">—</span>')}</td>
      <td data-field="levy_exempt" data-row="${i}">照章征税</td>
    </tr>`;
  }).join("");
}

export function sumOrderMetric(orders, fields, rawFields) {
  return orders.reduce(function (sum, o) {
    var raw = parseRaw(o.raw);
    var v = "";
    for (var i = 0; i < fields.length && v === ""; i++) v = pick(o[fields[i]]);
    for (var j = 0; j < rawFields.length && v === ""; j++) v = pick(raw[rawFields[j]]);
    var n = Number(v);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
}

export async function loadContainersForBl(pool, plan) {
  try {
    var out = [];
    var raw = parseRaw(plan.raw);
    var blNo = clean(pick(plan.bl_no, raw.blNo, raw.bl_no));
    var pushList = function (v) {
      String(v == null ? "" : v).split(/[,/;\s]+/).forEach(function (c) {
        c = clean(c); if (c && out.indexOf(c) < 0) out.push(c);
      });
    };
    if (blNo) {
      try {
        var r0 = await pool.query(
          `SELECT DISTINCT btrim(c.container_no) AS c
             FROM order_containers oc
             JOIN containers c ON c.id = oc.container_id
             LEFT JOIN shipment_group sg ON sg.id = c.shipment_group_id
             JOIN orders o ON o.id = oc.order_id
            WHERE (sg.bl_master = $1 OR o.bl_no = $1 OR o.raw->>'blNo' = $1 OR o.raw->>'bl_no' = $1)
              AND NULLIF(btrim(c.container_no), '') IS NOT NULL
            ORDER BY btrim(c.container_no)`,
          [blNo]
        );
        r0.rows.forEach(function (x) { pushList(x.c); });
      } catch (e) {}
    }
    try {
      var r1 = await pool.query(
        "SELECT DISTINCT btrim(container_no) AS c FROM container_bookings WHERE shipping_plan_id = $1 OR ($2 <> '' AND btrim(bl_no) = $2)",
        [plan.id, blNo]);
      r1.rows.forEach(function (x) { pushList(x.c); });
    } catch (e) {}
    if (blNo) {
      try {
        var r2 = await pool.query("SELECT container_no FROM shipping_plans WHERE btrim(bl_no) = $1", [blNo]);
        r2.rows.forEach(function (x) { pushList(x.container_no); });
      } catch (e) {}
    }
    pushList(plan.container_no);
    return out;
  } catch (e) { return []; }
}
