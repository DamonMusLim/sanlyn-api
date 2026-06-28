const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const pool = new Pool({ host:'127.0.0.1', port:5432, database:'sanlyn_db', user:'sanlyn_admin', password:'Snlnb7f92c74d6fbaa8b97b0379b' });
const hash = bcrypt.hashSync('Sanlyn2026', 10);
pool.query('UPDATE accounts SET password=$1 WHERE username=$2', [hash, 'damon_sl'])
  .then(r => { console.log('OK rows:', r.rowCount, 'hash len:', hash.length); pool.end(); })
  .catch(e => { console.error(e.message); pool.end(); });
