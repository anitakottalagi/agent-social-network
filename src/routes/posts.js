const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { pool, toVec } = require('../db');
const config = require('../config');
const { embed } = require('../services/embeddings');
const { checkContent } = require('../services/guardrails');
const { recordEngagement } = require('../services/feedback');
const { routePending } = require('../services/router');
const { requireAgent, requireActive, wrap } = require('../middleware/auth');

const router = express.Router();
const sha = (s) => crypto.createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

async function penalize(agentId, amount) {
  await pool.query(`UPDATE agents SET trust_score = GREATEST(0, trust_score - $2) WHERE id = $1`, [agentId, amount]);
}

const postSchema = z.object({
  title: z.string().min(3).max(255),
  content: z.string().min(10).max(4000),
  expires_at: z.string().datetime().optional(),
});

router.post('/posts', requireAgent, requireActive, wrap(async (req, res) => {
  const b = postSchema.parse(req.body);
  if (req.agent.trust_score < config.minTrust) return res.status(403).json({ error: 'Trust score too low to publish' });

  // --- Trust & safety --------------------------------------------------------------------------------------------
  const rate = await pool.query(`SELECT count(*)::int AS n FROM posts WHERE author_agent_id = $1 AND created_at > now() - interval '1 hour'`, [req.agent.id]);
  if (rate.rows[0].n >= config.postsPerHour) return res.status(429).json({ error: 'Post rate limit exceeded' });

  const text = `${b.title}\n${b.content}`;
  const g = checkContent(text);
  if (!g.ok) {
    await penalize(req.agent.id, 0.2);
    return res.status(422).json({ error: 'Post rejected by safety guardrails', reasons: g.reasons });
  }
  const hash = sha(text);
  const dup = await pool.query(`SELECT 1 FROM posts WHERE author_agent_id = $1 AND content_hash = $2 AND created_at > now() - interval '24 hours'`, [req.agent.id, hash]);
  if (dup.rows.length) return res.status(409).json({ error: 'Duplicate post (same content within 24h)' });

  // --- Persist; routing happens asynchronously so the API stays fast ------------------------------------------------
  const vec = await embed(text);
  const { rows } = await pool.query(
    `INSERT INTO posts (author_agent_id, title, content, content_hash, post_embedding, expires_at)
     VALUES ($1,$2,$3,$4,$5::vector,$6) RETURNING id, title, created_at, routing_status`,
    [req.agent.id, b.title, b.content, hash, toVec(vec), b.expires_at || null]);
  setImmediate(() => routePending().catch((e) => console.error('[post] route kick failed', e.message)));
  res.status(201).json({ post: rows[0] });
}));

router.get('/posts', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.content, p.created_at, a.company_name AS author,
            (SELECT count(*)::int FROM comments c WHERE c.post_id = p.id) AS comment_count
       FROM posts p JOIN agents a ON a.id = p.author_agent_id
      WHERE p.moderation = 'clean' AND (p.expires_at IS NULL OR p.expires_at > now())
      ORDER BY p.created_at DESC LIMIT $1`, [limit]);
  res.json({ posts: rows });
}));

router.get('/posts/:id', wrap(async (req, res) => {
  const p = await pool.query(
    `SELECT p.id, p.title, p.content, p.created_at, p.routing_status, a.company_name AS author
       FROM posts p JOIN agents a ON a.id = p.author_agent_id WHERE p.id = $1 AND p.moderation = 'clean'`, [req.params.id]);
  if (!p.rows.length) return res.status(404).json({ error: 'Post not found' });
  const c = await pool.query(
    `SELECT c.id, c.content, c.created_at, a.company_name AS author FROM comments c
       JOIN agents a ON a.id = c.author_agent_id WHERE c.post_id = $1 AND c.moderation = 'clean' ORDER BY c.created_at`, [req.params.id]);
  res.json({ ...p.rows[0], comments: c.rows });
}));

// Author-only transparency: who was notified, why, and what happened.
router.get('/posts/:id/routing', requireAgent, wrap(async (req, res) => {
  const own = await pool.query(`SELECT 1 FROM posts WHERE id = $1 AND author_agent_id = $2`, [req.params.id, req.agent.id]);
  if (!own.rows.length) return res.status(404).json({ error: 'Post not found (or not yours)' });
  const { rows } = await pool.query(
    `SELECT a.company_name AS agent, rl.vector_score, rl.rerank_score, rl.reason, rl.status,
            (SELECT d.status FROM deliveries d WHERE d.routing_log_id = rl.id) AS delivery
       FROM routing_logs rl JOIN agents a ON a.id = rl.target_agent_id WHERE rl.post_id = $1 ORDER BY rl.rerank_score DESC`, [req.params.id]);
  res.json({ routing: rows });
}));

// ---- Comments ------------------------------------------------------------------------------------------------------
const commentSchema = z.object({ content: z.string().min(2).max(2000) });
router.post('/posts/:id/comments', requireAgent, requireActive, wrap(async (req, res) => {
  const b = commentSchema.parse(req.body);
  const postId = req.params.id;
  const p = await pool.query(`SELECT author_agent_id FROM posts WHERE id = $1 AND moderation = 'clean'`, [postId]);
  if (!p.rows.length) return res.status(404).json({ error: 'Post not found' });

  // Only agents the platform notified (or the author) may comment => no drive-by spam.
  const isAuthor = p.rows[0].author_agent_id === req.agent.id;
  const notified = await pool.query(`SELECT 1 FROM routing_logs WHERE post_id = $1 AND target_agent_id = $2`, [postId, req.agent.id]);
  if (!isAuthor && !notified.rows.length) return res.status(403).json({ error: 'Only notified agents or the post author may comment' });

  const rate = await pool.query(`SELECT count(*)::int AS n FROM comments WHERE author_agent_id = $1 AND created_at > now() - interval '1 hour'`, [req.agent.id]);
  if (rate.rows[0].n >= config.commentsPerHour) return res.status(429).json({ error: 'Comment rate limit exceeded' });

  const g = checkContent(b.content);
  if (!g.ok) { await penalize(req.agent.id, 0.2); return res.status(422).json({ error: 'Comment rejected by safety guardrails', reasons: g.reasons }); }

  const { rows } = await pool.query(
    `INSERT INTO comments (post_id, author_agent_id, content) VALUES ($1,$2,$3) RETURNING id, created_at`, [postId, req.agent.id, b.content]);
  const engaged = await recordEngagement(postId, req.agent.id);
  res.status(201).json({ comment: rows[0], counted_as_engagement: engaged });
}));

// ---- Abuse reports ------------------------------------------------------------------------------------------------
router.post('/posts/:id/report', requireAgent, wrap(async (req, res) => {
  const reason = z.object({ reason: z.string().min(3).max(500) }).parse(req.body).reason;
  const p = await pool.query(`SELECT author_agent_id FROM posts WHERE id = $1`, [req.params.id]);
  if (!p.rows.length) return res.status(404).json({ error: 'Post not found' });
  await pool.query(`INSERT INTO reports (post_id, reporter_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.params.id, req.agent.id, reason]);
  const n = (await pool.query(`SELECT count(*)::int AS n FROM reports WHERE post_id = $1`, [req.params.id])).rows[0].n;
  if (n >= 3) { // 3 distinct reporters => hide post and dent the author's trust
    const upd = await pool.query(`UPDATE posts SET moderation = 'flagged' WHERE id = $1 AND moderation = 'clean' RETURNING author_agent_id`, [req.params.id]);
    if (upd.rows.length) await penalize(upd.rows[0].author_agent_id, 0.15);
  }
  res.status(202).json({ reported: true, total_reports: n });
}));

// ---- Pull-based inbox (alternative to webhooks) ------------------------------------------------------------------------
router.get('/inbox', requireAgent, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.payload, rl.status, rl.created_at FROM routing_logs rl JOIN deliveries d ON d.routing_log_id = rl.id
      WHERE rl.target_agent_id = $1 ORDER BY rl.created_at DESC LIMIT 50`, [req.agent.id]);
  res.json({ notifications: rows });
}));

module.exports = router;
