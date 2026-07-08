import assert from "node:assert/strict";
import { computeFixedProfile } from "./calc.js";

const fixtures = [
  {
    employeeId: "emp-linzl",
    gross: 12000,
    pension: 323.44,
    medical: 88.66,
    unemployment: 20.22,
    housingFund: 0,
    netPay: 11547.65,
  },
  {
    employeeId: "emp-lincy",
    gross: 8800,
    pension: 323.44,
    medical: 88.66,
    unemployment: 20.22,
    housingFund: 0,
    netPay: 8363.65,
  },
  {
    employeeId: "emp-limq",
    gross: 8000,
    pension: 323.44,
    medical: 88.66,
    unemployment: 20.22,
    housingFund: 0,
    netPay: 8000,
  },
  {
    employeeId: "emp-zouz",
    gross: 5000,
    pension: 323.44,
    medical: 88.66,
    unemployment: 20.22,
    housingFund: 0,
    netPay: 5000,
  },
  {
    employeeId: "emp-panxw",
    gross: 4500,
    pension: 0,
    medical: 0,
    unemployment: 0,
    housingFund: 0,
    netPay: 4500,
  },
];

for (const fixture of fixtures) {
  const result = computeFixedProfile({
    employee_id: fixture.employeeId,
    base_salary: fixture.gross,
    bonus: 0,
    allowance: 0,
    deduction: 0,
    personal_social_insurance: fixture.pension,
    personal_medical_insurance: fixture.medical,
    unemployment_insurance: fixture.unemployment,
    personal_housing_fund: fixture.housingFund,
    net_pay: fixture.netPay,
  });

  assert.equal(result.grossPay, fixture.gross, `${fixture.employeeId} gross`);
  assert.equal(result.personalSocialInsurance, fixture.pension, `${fixture.employeeId} pension`);
  assert.equal(result.personalMedicalInsurance, fixture.medical, `${fixture.employeeId} medical`);
  assert.equal(result.unemploymentInsurance, fixture.unemployment, `${fixture.employeeId} unemployment`);
  assert.equal(result.personalHousingFund, fixture.housingFund, `${fixture.employeeId} housing fund`);
  assert.equal(result.personalTax, 0, `${fixture.employeeId} personal tax`);
  assert.equal(result.netPay, fixture.netPay, `${fixture.employeeId} net pay`);
  assert.equal(result.bankAmount, fixture.netPay, `${fixture.employeeId} bank amount`);
  assert.equal(result.employerSocialInsurance, 0, `${fixture.employeeId} employer pension`);
  assert.equal(result.employerMedicalInsurance, 0, `${fixture.employeeId} employer medical`);
  assert.equal(result.employerHousingFund, 0, `${fixture.employeeId} employer housing`);
}

const fallback = computeFixedProfile(
  {
    base_salary: 10000,
    bonus: 0,
    allowance: 0,
    deduction: 0,
    personal_social_insurance: null,
    personal_medical_insurance: null,
    unemployment_insurance: null,
    personal_housing_fund: null,
    net_pay: null,
  },
  {
    pension: 500,
    medical: 100,
    unemployment: 50,
    housing_fund: 300,
    default_net_pay: 9800,
  }
);

assert.equal(fallback.personalSocialInsurance, 500, "fallback pension");
assert.equal(fallback.personalMedicalInsurance, 100, "fallback medical");
assert.equal(fallback.unemploymentInsurance, 50, "fallback unemployment");
assert.equal(fallback.personalHousingFund, 300, "fallback housing fund");
assert.equal(fallback.netPay, 9800, "fallback fixed net pay");
assert.equal(fallback.bankAmount, 9800, "fallback bank amount");
assert.notEqual(fallback.netPay, 9050, "must not derive net from gross minus deductions");

console.log("R1 calc fixture PASS");
