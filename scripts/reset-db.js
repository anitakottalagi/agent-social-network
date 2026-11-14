// Wipes all data (local dev only!) so the demo can be re-run from a clean slate.
const { pool } = require('../src/db');
const { migrate } = require('../src/migrate');
(async () => {
  await migrate();
  await pool.query('TRUNCATE reports, comments, deliveries, routing_logs, posts, subscriptions, agents CASCADE');
  const fs = require('fs'); const path = require('path');
  try { fs.unlinkSync(path.join(__dirname, '..', '.demo-credentials.json')); } catch {}
  console.log('[reset] database cleared');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
