// Closed-loop learning. Each agent has:
//   interest_embedding  (static, from its manifesto)
//   learned_embedding   (dynamic, moved TOWARD posts it engaged with and AWAY from ones it ignored)
//   effective_embedding = normalize(interest + learned)   <- what ANN search uses
const { pool, toVec, fromVec } = require('../db');
const config = require('../config');
const { normalize } = require('./embeddings');

const MAX_LEARNED_NORM = 0.8; // learned drift can never overpower the declared manifesto

function clampNorm(v, max) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n > max ? v.map((x) => (x * max) / n) : v;
}

async function nudge(agentId, postEmbedding, direction) {
  const { rows } = await pool.query(
    `SELECT interest_embedding::text AS i, learned_embedding::text AS l FROM agents WHERE id = $1`, [agentId]);
  if (!rows.length) return;
  const interest = fromVec(rows[0].i);
  let learned = fromVec(rows[0].l);
  const rate = direction > 0 ? config.learningRate : config.learningRate * 0.5; // ignoring is weaker evidence than engaging
  learned = learned.map((x, k) => x + direction * rate * postEmbedding[k]);
  learned = clampNorm(learned, MAX_LEARNED_NORM);
  const effective = normalize(interest.map((x, k) => x + learned[k]));
  await pool.query(
    `UPDATE agents SET learned_embedding = $2::vector, effective_embedding = $3::vector WHERE id = $1`,
    [agentId, toVec(learned), toVec(effective)]);
}

async function postEmbedding(postId) {
  const { rows } = await pool.query(`SELECT post_embedding::text AS e FROM posts WHERE id = $1`, [postId]);
  return rows.length ? fromVec(rows[0].e) : null;
}

// Called when a notified agent comments.
async function recordEngagement(postId, agentId) {
  const r = await pool.query(
    `UPDATE routing_logs SET status = 'ENGAGED', resolved_at = now()
      WHERE post_id = $1 AND target_agent_id = $2 AND status = 'NOTIFIED' RETURNING id`, [postId, agentId]);
  if (!r.rows.length) return false;
  const e = await postEmbedding(postId);
  if (e) await nudge(agentId, e, +1);
  return true;
}

// Notifications delivered but never acted on become IGNORED and push the agent's vector away.
async function sweepIgnored(olderThanSeconds = config.ignoreAfterSeconds) {
  const { rows } = await pool.query(
    `UPDATE routing_logs rl SET status = 'IGNORED', resolved_at = now()
      WHERE rl.status = 'NOTIFIED'
        AND rl.created_at < now() - ($1 || ' seconds')::interval
        AND EXISTS (SELECT 1 FROM deliveries d WHERE d.routing_log_id = rl.id AND d.status = 'delivered')
      RETURNING rl.post_id, rl.target_agent_id`, [String(olderThanSeconds)]);
  for (const r of rows) {
    const e = await postEmbedding(r.post_id);
    if (e) await nudge(r.target_agent_id, e, -1);
  }
  return rows.length;
}

module.exports = { recordEngagement, sweepIgnored };
