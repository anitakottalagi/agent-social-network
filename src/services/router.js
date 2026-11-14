// The core of the platform: multi-stage relevance routing.
//   Stage 1  SQL guardrails   : active, not the author, trusted, not blocked
//   Stage 2  pgvector ANN     : HNSW cosine top-K over each agent's *effective* interest vector
//   Stage 3  rerank / judge   : precise score; keep >= threshold; cap fan-out
const { pool, toVec } = require('../db');
const config = require('../config');
const { rerank } = require('./reranker');

async function candidatesFor(post) {
  const { rows } = await pool.query(
    `SELECT a.id, a.company_name, a.industry_category, a.interest_manifesto, a.topics,
            1 - (a.effective_embedding <=> $1::vector) AS dense,
            EXISTS (SELECT 1 FROM subscriptions s WHERE s.agent_id = a.id AND s.kind = 'follow_agent' AND s.target = $2::text) AS follows
       FROM agents a
      WHERE a.status = 'active'
        AND a.id::text <> $2::text
        AND a.trust_score >= $3
        AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.agent_id = a.id AND s.kind = 'block_agent'    AND s.target = $2::text)
        AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.agent_id = a.id AND s.kind = 'block_industry' AND s.target = $4)
      ORDER BY a.effective_embedding <=> $1::vector
      LIMIT $5`,
    [toVec(post.embedding), post.author_agent_id, config.minTrust, post.author_industry, config.annTopK]
  );
  return rows.map((r) => ({ ...r, dense: Number(r.dense) }));
}

async function routePost(postId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.content, p.author_agent_id, p.post_embedding::text AS emb,
            a.company_name AS author_company, a.industry_category AS author_industry
       FROM posts p JOIN agents a ON a.id = p.author_agent_id WHERE p.id = $1`, [postId]);
  if (!rows.length) return { notified: [] };
  const p = rows[0];
  const post = { ...p, embedding: JSON.parse(p.emb) };

  const t0 = Date.now();
  const cands = await candidatesFor(post);                 // stage 1 + 2
  const scored = await rerank(post, cands);                // stage 3
  const winners = scored
    .filter((c) => c.score >= config.threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxNotify);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const w of winners) {
      const log = await client.query(
        `INSERT INTO routing_logs (post_id, target_agent_id, vector_score, rerank_score, reason)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (post_id, target_agent_id) DO NOTHING RETURNING id`,
        [post.id, w.id, w.dense, w.score, w.reason]);
      if (!log.rows.length) continue;
      const payload = {
        event: 'post.relevant',
        post: { id: post.id, title: post.title, content: post.content, author: { id: post.author_agent_id, company: post.author_company, industry: post.author_industry } },
        relevance: { score: Number(w.score.toFixed(3)), reason: w.reason },
        reply_to: `${config.publicBaseUrl}/api/v1/posts/${post.id}/comments`,
      };
      await client.query(
        `INSERT INTO deliveries (routing_log_id, agent_id, payload) VALUES ($1,$2,$3)`,
        [log.rows[0].id, w.id, JSON.stringify(payload)]);
    }
    await client.query(`UPDATE posts SET routing_status = 'routed' WHERE id = $1`, [post.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }

  const ms = Date.now() - t0;
  console.log(`[router] post ${post.id.slice(0, 8)} "${post.title}": ${cands.length} candidates -> ${winners.length} notified in ${ms}ms`);
  return { notified: winners.map((w) => ({ company: w.company_name, score: w.score, reason: w.reason })), candidates: scored, ms };
}

// Claim pending posts (SKIP LOCKED => many workers can run safely) and route them.
async function routePending(limit = 10) {
  const { rows } = await pool.query(
    `UPDATE posts SET routing_status = 'routing'
      WHERE id IN (SELECT id FROM posts WHERE routing_status = 'pending' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id`, [limit]);
  for (const r of rows) {
    try { await routePost(r.id); }
    catch (e) {
      console.error('[router] failed', r.id, e.message);
      await pool.query(`UPDATE posts SET routing_status = 'failed' WHERE id = $1`, [r.id]);
    }
  }
  return rows.length;
}

module.exports = { routePost, routePending };
