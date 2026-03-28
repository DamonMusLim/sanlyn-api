// probe_imm.js
import('@alicloud/imm20200930').then(m => {
  console.log('typeof default:', typeof m.default);
  console.log('default.prototype?', !!m.default?.prototype);
  console.log('typeof default.default:', typeof m.default?.default);
  console.log('default.default.prototype?', !!m.default?.default?.prototype);
  
  // 检查 default 是否有 createOfficeConversionTask 方法（在 prototype 上）
  if (m.default?.prototype) {
    const methods = Object.getOwnPropertyNames(m.default.prototype).filter(k => k.includes('onvert') || k.includes('ffice'));
    console.log('default.prototype methods (convert/office):', methods);
  }
  if (m.default?.default?.prototype) {
    const methods = Object.getOwnPropertyNames(m.default.default.prototype).filter(k => k.includes('onvert') || k.includes('ffice'));
    console.log('default.default.prototype methods:', methods);
  }
});
