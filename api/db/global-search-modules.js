// Fixed allowlist of workbench modules exposed to top-bar global search.
export const MODULE_SEARCHES = [
  ["业务预警", "/biz-alerts.html", "客户额度 合同 回款 风险"],
  ["操作预警", "/ops-alerts.html", "操作节点 船期 单证 预警"],
  ["操作待办", "/ops-todos.html", "待办 审核 operation_todos"],
  ["审核管理", "/audit-review.html", "审核 review approval"],
  ["费用预警", "/fee-alerts.html", "费用 异常 港杂 账单"],
  ["费用模板", "/fee-templates.html", "费率 模板 标准"],
  ["开票记录", "/invoice-records.html", "发票 进项 销项"],
  ["收付管理", "/receipt-payment-management.html", "回款 付款 水单 finance_payments"],
  ["核销管理", "/settlement-management.html", "核销 settlement"],
  ["提成管理", "/commission-management.html", "提成 业务员 回款"],
  ["业务报表", "/business-report.html", "报表 业务 订单"],
  ["财务报表", "/financial-report.html", "财务 报表 金额"],
  ["集运费用明细", "/consolidated-fee-details.html", "集运 费用 明细"],
  ["服务项目", "/order-services.html", "订单 服务 项目"],
  ["订单人员角色", "/order-staff-slots.html", "业务员 操作 单证 财务 角色"],
  ["订舱平台", "/booking-platform.html", "订舱 booking SO 船公司"],
  ["提单管理", "/bl-management.html", "提单 BL MBL HBL"],
  ["六方向运输", "/transport-directions.html", "运输方向 内外贸"],
  ["订单录入", "/order-entry.html", "订单 草稿 录入"],
  ["自定义导航", "/custom-nav.html", "导航 工作台 菜单"],
  ["价表总台", "/rates-hub.html", "价表 海运 港杂 本地费"],
  ["在线报关", "/online-customs.html", "报关 单一窗口"],
  ["报文数据通道", "/manifest-message-channel.html", "报文 生成 校验"],
  ["上海舱单发送", "/manifest-send.html", "上海 舱单"],
  ["天津/大连舱单", "/tianjin-dalian-manifest-send.html", "天津 大连 舱单"],
  ["深圳/南沙舱单", "/shenzhen-nansha-manifest-send.html", "深圳 南沙 舱单"],
  ["青岛舱单发送", "/qingdao-manifest-send.html", "青岛 舱单"],
  ["厦门舱单发送", "/xiamen-manifest-send.html", "厦门 舱单"],
  ["ICS2欧线", "/ics2-send.html", "ICS2 ENS 欧线"],
  ["箱货信息", "/cargo-info.html", "箱号 货重 VGM"],
  ["仓储信息", "/warehouse-info.html", "仓库 库存 finished_goods"],
];

function normalize(v) {
  return String(v ?? "").trim().toLowerCase();
}

export function searchModules(q, limit = 8) {
  const needle = normalize(q);
  if (needle.length < 2) return null;
  const items = MODULE_SEARCHES
    .filter(([label, url, tags]) => normalize(`${label} ${url} ${tags}`).includes(needle))
    .slice(0, limit)
    .map(([label, url, tags]) => ({
      type: "模块",
      label,
      sub: tags,
      url,
    }));
  return items.length ? { type: "模块", items } : null;
}
