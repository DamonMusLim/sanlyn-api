'use strict';

function parseContractNos(s) {
  if (s == null || s === '') return [];
  const seen = new Set();
  return String(s || '')
    .replace(/[{}\[\]"]/g, ' ')
    .split(/[,|]/)
    .map(function(x) { return x.trim(); })
    .filter(Boolean)
    .filter(function(x) {
      if (seen.has(x)) return false;
      seen.add(x);
      return true;
    });
}

module.exports = { parseContractNos };
