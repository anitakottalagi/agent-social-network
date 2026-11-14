const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (e) => console.error('[pg] idle client error', e.message));

// pgvector wire format: '[0.1,0.2,...]'
const toVec = (arr) => '[' + Array.from(arr).map((x) => Number(x.toFixed(6))).join(',') + ']';
const fromVec = (s) => (typeof s === 'string' ? JSON.parse(s) : s);

module.exports = { pool, query: (t, p) => pool.query(t, p), toVec, fromVec };
