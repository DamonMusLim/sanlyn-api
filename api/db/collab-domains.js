// 协同闭环域配置 — config驱动,引擎不硬编码
export const FINANCE_DOMAIN = {
  name: "财务退税",
  source: { table: "finance_export_rebates", keyCol: "customs_no", dateCol: "export_date" },
  items: [
    { key: "报关单", label: "报关单", owner: "报关行",
      doneSql: "SELECT true AS done, src.customs_no::text AS doc_url" },
    { key: "进项票", label: "进项票", owner: "工厂",
      doneSql: "SELECT true AS done, fii.attachments::text AS doc_url FROM finance_invoices_in fii WHERE fii.customs_nos @> ARRAY[src.customs_no]::varchar[] AND COALESCE(fii.review_status,'') NOT IN ('void','red_ink') LIMIT 1" },
    { key: "水单", label: "水单", owner: "财务",
      doneSql: "SELECT true AS done, bs.file_url AS doc_url FROM bank_slip_links l JOIN bank_slips bs ON bs.id=l.slip_id WHERE (l.bl_no=src.customs_no OR (src.contract_no IS NOT NULL AND l.contract_no=src.contract_no)) AND bs.beneficiary_company_code = (SELECT o.factory_code FROM orders o WHERE o.contract_no=src.contract_no AND o.factory_code IS NOT NULL LIMIT 1) LIMIT 1" },
    // 采购合同排最后:暂无真源(恒missing),不遮挡水单环节。TODO接采购合同表。
    { key: "采购合同", label: "采购合同", owner: "工厂",
      doneSql: "SELECT true AS done, c.file_url AS doc_url FROM contracts c WHERE c.contract_no=src.contract_no AND c.file_url IS NOT NULL LIMIT 1" },
  ],
};

export const OCEAN_DOMAIN = {
  name: "海运",
  source: { table: "shipping_plans", keyCol: "id", dateCol: "etd", labelCol: "bl_no" },
  items: [
    { key: "订舱", label: "订舱", owner: "货代",
      doneSql: "SELECT (src.booking_no IS NOT NULL AND src.booking_no<>'') AS done, src.booking_no AS doc_url" },
    { key: "报关资料", label: "报关资料", owner: "工厂/单证", deadlineCol: "customs_cutoff",
      doneSql: "SELECT (COALESCE(src.customs_cn,src.customs_arrange) IS NOT NULL) AS done, src.customs_cn AS doc_url" },
    { key: "截单数据", label: "截单数据(SI)", owner: "单证/工厂", deadlineCol: "si_cutoff_date",
      doneSql: "SELECT (src.collab_sheet_status IS NOT NULL AND src.collab_sheet_status<>'') AS done, src.collab_sheet_status AS doc_url" },
    { key: "VGM", label: "VGM(毛重)", owner: "工厂/单证", deadlineCol: "cargo_cutoff",
      doneSql: "SELECT (src.gross_weight_kg IS NOT NULL AND src.gross_weight_kg>0) AS done, src.gross_weight_kg::text AS doc_url" },
    { key: "BL", label: "BL", owner: "货代",
      doneSql: "SELECT (COALESCE(src.bl_no,src.mbl_no) IS NOT NULL) AS done, COALESCE(src.bl_no,src.mbl_no) AS doc_url" },
  ],
};
