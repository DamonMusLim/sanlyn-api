export function buildOceanSql(conds) {
  return `
SELECT f.id,
  COALESCE(pol_p.name_en, f.pol) AS pol,
  COALESCE(pod_p.name_en, f.pod) AS pod,
  f.pol AS pol_raw, f.pod AS pod_raw,
  f.carrier, f.forwarder, f.supplier_id, f.currency,
  f.route_code, f.via, f.thc, f.local_charge_code,
  f.gp20, f.hq40, f.customer_gp20, f.customer_hq40,
  f.markup_sales, f.markup_customer, f.min_container_qty,
  f.payment_method, f.applicable_commodity, f.space_status,
  f.official_gp20, f.official_hq40, f.profit_20gp, f.profit_40hq,
  to_char(f.valid_from,'YYYY-MM-DD') AS valid_from,
  to_char(f.valid_to,'YYYY-MM-DD') AS valid_to,
  f.status, f.source, f.remarks,
  to_char(f.sail_date,'YYYY-MM-DD') AS sail_date,
  f.vessel_name, f.voyage_no,
  to_char(f.eta_date,'YYYY-MM-DD') AS eta_date,
  to_char(f.doc_cutoff,'YYYY-MM-DD') AS doc_cutoff,
  to_char(f.cargo_cutoff,'YYYY-MM-DD') AS cargo_cutoff,
  f.transit_days, f.freetime, f.pol_port_id, f.pod_port_id
FROM freight_rates f
LEFT JOIN ports pol_p ON pol_p.id = f.pol_port_id
LEFT JOIN ports pod_p ON pod_p.id = f.pod_port_id
${conds.length ? "WHERE " + conds.join(" AND ") : ""}
ORDER BY COALESCE(f.valid_to,'9999-12-31'::date) DESC, f.pol, f.pod, f.carrier, f.forwarder`;
}
