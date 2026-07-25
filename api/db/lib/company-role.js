// company-role.js — 公司角色→颜色(只读纯逻辑,给公司身份chip用)
// 角色读公司表数据(is_sanlyn_entity/type),代码零硬编码公司名。别人用标自己的主体,逻辑不变。
// 巴匕→own蓝, 恒安(type非factory/customer)→external橙, 中宠(type=factory)→factory青, PETSOME(type=customer)→customer紫
export function companyRole(company) {
  if (!company) return { role: "unknown", color: "gray", label: "未知" };
  if (company.is_sanlyn_entity === true) return { role: "own", color: "blue", label: "我方主体" };
  const t = String(company.type || "").toLowerCase();
  if (t === "factory") return { role: "factory", color: "teal", label: "上游工厂" };
  if (t === "customer") return { role: "customer", color: "purple", label: "下游客户" };
  if (t === "forwarder") return { role: "forwarder", color: "blue", label: "货代" };
  return { role: "external", color: "amber", label: "外部" };
}

export const ROLE_COLORS = {
  blue:   { bg: "#E6F1FB", fg: "#0C447C", solid: "#185FA5" },
  teal:   { bg: "#E1F5EE", fg: "#085041", solid: "#0F6E56" },
  purple: { bg: "#EEEDFE", fg: "#3C3489", solid: "#534AB7" },
  amber:  { bg: "#FAEEDA", fg: "#633806", solid: "#BA7517" },
  gray:   { bg: "#F1EFE8", fg: "#2C2C2A", solid: "#5F5E5A" },
};
