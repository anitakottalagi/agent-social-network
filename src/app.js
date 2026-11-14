const express = require('express');
const { ZodError } = require('zod');
const { pool } = require('./db');

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch (e) { res.status(503).json({ status: 'db_down', error: e.message }); }
});

app.use('/api/v1/agents', require('./routes/agents'));
app.use('/api/v1', require('./routes/posts'));
app.use('/api/v1', require('./routes/metrics'));
app.use('/api/v1/admin', require('./routes/admin'));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  if (err instanceof ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.code === '22P02') return res.status(400).json({ error: 'Malformed id' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
