const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { pool, toVec } = require('../db');
const config = require('../config');
const { embed, normalize } = require('../services/embeddings');
const { sendChallenge } = require('../services/delivery');
const { requireAgent, sha256, wrap } = require('../middleware/auth');

const router = express.Router();

const urlOk = (u) => {
  try {
    const x = new URL(u);
    if (process.env.NODE_ENV === 'production') {
      if (x.protocol !== 'https:') return false;
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.hostname)) return false; // basic SSRF guard
    }
    return ['http:', 'https:'].includes(x.protocol);
  } catch { return false; }
};

const registerSchema = z.object({
  company_name: z.string().min(2).max(120),
  industry_category: z.string().min(2).max(100),
  webhook_url: z.string().refine(urlOk, 'must be a valid (https in production, public) URL'),
  interest_manifesto: z.string().min(20).max(2000),
  topics: z.array(z.string().max(50)).max(20).optional().default([]),
});
const textForEmbedding = (a) => `${a.interest_manifesto}. Topics: ${(a.topics || []).join(', ')}. Industry: ${a.industry_category}`;

router.post('/register', wrap(async (req, res) => {
  const body = registerSchema.parse(req.body);
  const apiKey = 'ak_' + crypto.randomBytes(24).toString('hex');
  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
  const vec = await embed(textForEmbedding(body));
  const zero = new Array(vec.length).fill(0);
  let row;
  try {
    const r = await pool.query(
      `INSERT INTO agents (company_name, industry_category, webhook_url, interest_manifesto, topics, api_key_hash, webhook_secret, status,
                           interest_embedding, learned_embedding, effective_embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10::vector,$9::vector)
       RETURNING id, company_name, industry_category, webhook_url, status`,
      [body.company_name, body.industry_category, body.webhook_url, body.interest_manifesto, body.topics, sha256(apiKey), secret,
       config.requireVerification ? 'pending' : 'active', toVec(vec), toVec(zero)]);
    row = r.rows[0];
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'company_name already registered' });
    throw e;
  }
  let verification = 'not_required';
  if (config.requireVerification) {
    const ok = await sendChallenge({ webhook_url: body.webhook_url, webhook_secret: secret }, crypto.randomUUID());
    // NOTE: sendChallenge compares echo of the same challenge; see /me/verify for retry
    verification = ok ? 'passed' : 'pending';
    if (ok) { await pool.query(`UPDATE agents SET status = 'active' WHERE id = $1`, [row.id]); row.status = 'active'; }
  }
  // api_key and webhook_secret are shown ONCE.
  res.status(201).json({ agent: row, api_key: apiKey, webhook_secret: secret, verification });
}));

router.get('/', wrap(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, company_name, industry_category, interest_manifesto, topics, status, trust_score FROM agents ORDER BY created_at`);
  res.json({ agents: rows });
}));

router.get('/me', requireAgent, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, company_name, industry_category, webhook_url, interest_manifesto, topics, status, trust_score, breaker_open_until FROM agents WHERE id = $1`, [req.agent.id]);
  res.json(rows[0]);
}));

router.patch('/me', requireAgent, wrap(async (req, res) => {
  const b = registerSchema.partial().omit({ company_name: true }).parse(req.body);
  const { rows } = await pool.query(`SELECT interest_manifesto, topics, industry_category, learned_embedding::text AS l FROM agents WHERE id = $1`, [req.agent.id]);
  const merged = { ...rows[0], ...b };
  const vec = await embed(textForEmbedding(merged));
  const learned = JSON.parse(rows[0].l);
  const eff = normalize(vec.map((x, k) => x + learned[k]));
  await pool.query(
    `UPDATE agents SET webhook_url = COALESCE($2, webhook_url), interest_manifesto = $3, topics = $4, industry_category = $5,
            interest_embedding = $6::vector, effective_embedding = $7::vector WHERE id = $1`,
    [req.agent.id, b.webhook_url || null, merged.interest_manifesto, merged.topics, merged.industry_category, toVec(vec), toVec(eff)]);
  res.json({ updated: true });
}));

router.post('/me/verify', requireAgent, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT webhook_url, webhook_secret FROM agents WHERE id = $1`, [req.agent.id]);
  const ok = await sendChallenge(rows[0], crypto.randomUUID());
  if (ok) await pool.query(`UPDATE agents SET status = 'active' WHERE id = $1 AND status = 'pending'`, [req.agent.id]);
  res.json({ verified: ok });
}));

// ---- Subscriptions: follow / block --------------------------------------------------------------------------------
const subSchema = z.object({ kind: z.enum(['follow_agent', 'block_agent', 'block_industry']), target: z.string().min(1).max(120) });
router.post('/me/subscriptions', requireAgent, wrap(async (req, res) => {
  const b = subSchema.parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (agent_id, kind, target) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id, kind, target`,
    [req.agent.id, b.kind, b.target]);
  res.status(201).json(rows[0] || { kind: b.kind, target: b.target, note: 'already exists' });
}));
router.get('/me/subscriptions', requireAgent, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, kind, target, created_at FROM subscriptions WHERE agent_id = $1 ORDER BY created_at`, [req.agent.id]);
  res.json({ subscriptions: rows });
}));
router.delete('/me/subscriptions/:id', requireAgent, wrap(async (req, res) => {
  await pool.query(`DELETE FROM subscriptions WHERE id = $1 AND agent_id = $2`, [req.params.id, req.agent.id]);
  res.status(204).end();
}));

// ---- Feedback stats ------------------------------------------------------------------------------------------------
router.get('/me/stats', requireAgent, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS notifications,
            count(*) FILTER (WHERE status = 'ENGAGED')::int AS engaged,
            count(*) FILTER (WHERE status = 'IGNORED')::int AS ignored,
            count(*) FILTER (WHERE status = 'FAILED')::int  AS failed,
            count(*) FILTER (WHERE status = 'NOTIFIED')::int AS pending
       FROM routing_logs WHERE target_agent_id = $1`, [req.agent.id]);
  const s = rows[0];
  const resolved = s.engaged + s.ignored;
  res.json({ ...s, engagement_rate: resolved ? Number((s.engaged / resolved).toFixed(3)) : null });
}));

module.exports = router;
