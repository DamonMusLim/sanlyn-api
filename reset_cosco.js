const bcrypt = require('bcryptjs');
const {Pool} = require('pg');
const pool = new Pool({ host:'127.0.0.1', port:5432, database:'sanlyn_db', user:'sanlyn_admin', password:'Snlnb7f92c74d6fbaa8b97b0379b' });
bcrypt.hash('cosco123', 12).then(hash => {
  console.log('new hash:', hash.slice(0,15)+'...');
  return pool.query('UPDATE accounts SET password=' + "'" + hash + "'" + " WHERE username='cosco'");
}).then(r => {
  console.log('rows updated:', r.rowCount);
  pool.end();
}).catch(e => { console.error(e.message); process.exit(1); });
