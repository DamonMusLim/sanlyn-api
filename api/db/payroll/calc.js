export const CALCULATION_METHOD = "FIXED_PROFILE";
export const CALCULATION_VERSION = "2026-07-fixed-v1";

function isNil(v) {
  return v === null || v === undefined;
}

function toNumber(v, fallback = 0) {
  if (isNil(v) || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(v) {
  return Math.round(toNumber(v) * 100) / 100;
}

function fromRowOrEmp(rowValue, empValue) {
  return round2(isNil(rowValue) ? empValue : rowValue);
}

export function computeFixedProfile(row, emp = null) {
  const warnings = [];
  const baseSalary = toNumber(row?.base_salary);
  const bonus = toNumber(row?.bonus);
  const allowance = toNumber(row?.allowance);
  const deduction = toNumber(row?.deduction);

  const grossPay = round2(baseSalary + bonus + allowance - deduction);
  const personalSocialInsurance = fromRowOrEmp(row?.personal_social_insurance, emp?.pension);
  const personalMedicalInsurance = fromRowOrEmp(row?.personal_medical_insurance, emp?.medical);
  const unemploymentInsurance = fromRowOrEmp(row?.unemployment_insurance, emp?.unemployment);
  const personalHousingFund = fromRowOrEmp(row?.personal_housing_fund, emp?.housing_fund);
  const personalTax = 0;
  const netPay = round2(isNil(row?.net_pay) ? emp?.default_net_pay : row.net_pay);
  const bankAmount = netPay;
  const employerSocialInsurance = 0;
  const employerMedicalInsurance = 0;
  const employerHousingFund = 0;

  if (!emp) {
    warnings.push("employee profile missing; using payroll row values only");
  }

  const formulaNet = round2(
    grossPay
      - personalSocialInsurance
      - personalMedicalInsurance
      - unemploymentInsurance
      - personalHousingFund
      - personalTax
  );
  if (Math.abs(netPay - formulaNet) > 1) {
    warnings.push("net_pay differs from gross minus deductions; preserving fixed profile net_pay");
  }

  return {
    grossPay,
    personalSocialInsurance,
    personalMedicalInsurance,
    unemploymentInsurance,
    personalHousingFund,
    personalTax,
    netPay,
    bankAmount,
    employerSocialInsurance,
    employerMedicalInsurance,
    employerHousingFund,
    warnings,
    calculationMethod: CALCULATION_METHOD,
    calculationVersion: CALCULATION_VERSION,
  };
}
