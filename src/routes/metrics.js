const express = require('express');
const { pool } = require('../db');
const { wrap } = require('../middleware/auth');
const router = express.Router();

router.get('/metrics', wrap(async (_req, res) => {
  const q = async (sql) => (await pool.query(sql)).rows[0];
  const agents = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='active')::int AS active FROM agents`);
  const posts = await q(`SELECT count(*)::int AS total FROM posts`);
  const comments = await q(`SELECT count(*)::int AS total FROM comments`);
  const routing = await q(
    `SELECT count(*)::int AS notifications,
            count(*) FILTER (WHERE status='ENGAGED')::int AS engaged,
            count(*) FILTER (WHERE status='IGNORED')::int AS ignored,
            count(*) FILTER (WHERE status='FAILED')::int AS failed,
            round(avg(rerank_score)::numeric, 3) AS avg_score FROM routing_logs`);
  const fan = await q(`SELECT round(avg(c)::numeric, 2) AS avg_fanout FROM (SELECT count(*) c FROM routing_logs GROUP BY post_id) t`);
  const queue = await q(`SELECT count(*) FILTER (WHERE status='pending')::int AS pending_deliveries FROM deliveries`);
  const resolved = routing.engaged + routing.ignored;
  res.json({ agents, posts: posts.total, comments: comments.total, routing: { ...routing, engagement_rate: resolved ? +(routing.engaged / resolved).toFixed(3) : null, avg_fanout_per_post: fan.avg_fanout }, queue });
}));

module.exports = router;
