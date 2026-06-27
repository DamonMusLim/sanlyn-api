/**
 * provision-jj-pet-portal.mjs
 * Creates JJ PET GROUP portal account in production DB.
 * Run: node scripts/provision-jj-pet-portal.mjs
 * Requires: .env.local with PG_* vars + JJPET_PASS env var
 *
 * SECURITY:
 * - Password comes from JJPET_PASS env var — never hardcoded
 * - Hash never printed to stdout
 * - Full transaction with ROLLBACK on error
 * - Read-only dedup check before any write
 */

import { config } from 'dotenv';
import pkg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pkg;
config({ path: new URL('../.env.local', import.meta.url).pathname });

const pool = new Pool({
  host: process.env.PG_HOST,
  port: +process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const pass = process.env.JJPET_PASS;
  if (!pass || pass.length < 8) {
    console.error('ERROR: Set JJPET_PASS env var (min 8 chars). Password never logged.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    // ── READ-ONLY DEDUP CHECK ──────────────────────────────
    const dupCo = await client.query(
      "SELECT id, company_code FROM portal_companies WHERE company_code='CN-00042'"
    );
    if (dupCo.rows.length > 0) {
      console.log('SKIP: portal_company CN-00042 already exists:', dupCo.rows[0].id);
      const dupUsr = await client.query(
        "SELECT id, username FROM portal_users WHERE company_id=$1", [dupCo.rows[0].id]
      );
      if (dupUsr.rows.length > 0) {
        console.log('SKIP: portal_user already exists:', dupUsr.rows[0].username);
      } else {
        console.log('NOTE: portal_company exists but no user — would need user-only insert');
      }
      process.exit(0);
    }

    const dupUsr = await client.query("SELECT id FROM portal_users WHERE username='jjpet'");
    if (dupUsr.rows.length > 0) {
      console.error('ERROR: username jjpet already exists as', dupUsr.rows[0].id);
      process.exit(1);
    }

    // ── VERIFY ORDERS EXIST ───────────────────────────────
    const orders = await client.query(
      "SELECT id, order_no, status FROM orders WHERE company_code='CN-00042' ORDER BY id DESC"
    );
    console.log('Orders that will become visible:', orders.rows.length);
    orders.rows.forEach(o => console.log(' -', o.id, o.order_no, o.status));

    // ── HASH PASSWORD (never log) ─────────────────────────
    const hash = await bcrypt.hash(pass, 10);

    // ── TRANSACTION ───────────────────────────────────────
    await client.query('BEGIN');

    const r1 = await client.query(`
      INSERT INTO portal_companies(id,company_code,company_name,company_type,status,created_at,updated_at)
      VALUES(gen_random_uuid(),'CN-00042','JJ PET GROUP SDN BHD','customer','active',NOW(),NOW())
      RETURNING id`);
    const companyId = r1.rows[0].id;
    console.log('portal_company created:', companyId);

    const r2 = await client.query(`
      INSERT INTO portal_users(id,company_id,username,password_hash,display_name,user_type,status,created_by,created_at,updated_at)
      VALUES(gen_random_uuid(),$1,'jjpet',$2,'JJ PET GROUP','customer','active','damon_sl',NOW(),NOW())
      RETURNING id`, [companyId, hash]);
    const userId = r2.rows[0].id;
    console.log('portal_user created:', userId);

    await client.query(`
      INSERT INTO portal_user_roles(id,user_id,role_code,granted_at,granted_by)
      VALUES(gen_random_uuid(),$1,'customer_view',NOW(),'damon_sl')`, [userId]);
    console.log('portal_user_roles: customer_view granted');

    await client.query('COMMIT');
    console.log('DONE — JJ PET portal account provisioned successfully');
    console.log('Login: username=jjpet | password=(the one you set in JJPET_PASS)');
    console.log('Visible orders:', orders.rows.map(o => o.id).join(', '));

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLBACK — error:', e.message);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

run();
