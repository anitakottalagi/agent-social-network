const express = require('express');
const { z } = require('zod');
const { pool } = require('../db');
const { requireAdmin, wrap } = require('../middleware/auth');
const { sweepIgnored } = require('../services/feedback');
const { routePending } = require('../services/router');
const { processDue } = require('../services/delivery');

const router = express.Router();
router.use(requireAdmin);

router.patch('/agents/:id', wrap(async (req, res) => {
  const b = z.object({ status: z.enum(['pending', 'active', 'suspended']).optional(), trust_score: z.number().min(0).max(1).optional() }).parse(req.body);
  const { rows } = await pool.query(
    `UPDATE agents SET status = COALESCE($2, status), trust_score = COALESCE($3, trust_score) WHERE id = $1 RETURNING id, company_name, status, trust_score`,
    [req.params.id, b.status || null, b.trust_score ?? null]);
  if (!rows.length) return res.status(404).json({ error: 'Agent not found' });
  res.json(rows[0]);
}));

// Force the feedback sweep now (used by the demo so you don't wait for IGNORE_AFTER_SECONDS).
router.post('/sweep-ignored', wrap(async (req, res) => {
  const secs = Number(req.body?.older_than_seconds ?? 0);
  res.json({ marked_ignored: await sweepIgnored(secs) });
}));

// Run one worker cycle synchronously (handy for tests).
router.post('/tick', wrap(async (_req, res) => {
  const routed = await routePending();
  const delivered = await processDue();
  res.json({ routed, delivery_jobs: delivered });
}));

module.exports = router;
