// Webhook delivery: transactional outbox + HMAC signatures + exponential backoff + per-agent circuit breaker.
const crypto = require('crypto');
const { pool } = require('../db');
const config = require('../config');

function sign(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function post(url, secret, event, deliveryId, payload) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.webhookTimeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-AgentNet-Event': event,
        'X-AgentNet-Delivery-Id': deliveryId,
        'X-AgentNet-Timestamp': ts,
        'X-AgentNet-Signature': sign(secret, ts, body),
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally { clearTimeout(timer); }
}

async function processDue(limit = 25) {
  // Claim with a 30s lease so a crashed worker's jobs are retried automatically.
  const { rows } = await pool.query(
    `UPDATE deliveries d SET next_attempt_at = now() + interval '30 seconds'
      WHERE d.id IN (SELECT id FROM deliveries WHERE status = 'pending' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.agent_id, d.payload, d.attempts, d.routing_log_id`, [limit]);
  if (!rows.length) return 0;

  await Promise.allSettled(rows.map(async (d) => {
    const { rows: ar } = await pool.query(
      `SELECT webhook_url, webhook_secret, breaker_open_until FROM agents WHERE id = $1`, [d.agent_id]);
    const agent = ar[0];
    if (!agent) return;

    // Circuit breaker: don't hammer an agent that is down; retry after cool-down without burning an attempt.
    if (agent.breaker_open_until && new Date(agent.breaker_open_until) > new Date()) {
      await pool.query(`UPDATE deliveries SET next_attempt_at = $2 WHERE id = $1`, [d.id, agent.breaker_open_until]);
      return;
    }
    try {
      await post(agent.webhook_url, agent.webhook_secret, d.payload.event, d.id, d.payload);
      await pool.query(`UPDATE deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL WHERE id = $1`, [d.id]);
      await pool.query(`UPDATE agents SET consecutive_failures = 0, breaker_open_until = NULL WHERE id = $1`, [d.agent_id]);
    } catch (e) {
      const attempts = d.attempts + 1;
      const dead = attempts >= config.maxAttempts;
      const backoffS = Math.min(2 ** attempts * 2, 300) * (0.75 + Math.random() * 0.5);
      await pool.query(
        `UPDATE deliveries SET attempts = $2, last_error = $3, status = $4, next_attempt_at = now() + ($5 || ' seconds')::interval WHERE id = $1`,
        [d.id, attempts, String(e.message).slice(0, 300), dead ? 'failed' : 'pending', backoffS.toFixed(1)]);
      if (dead) await pool.query(`UPDATE routing_logs SET status = 'FAILED', resolved_at = now() WHERE id = $1`, [d.routing_log_id]);
      const f = await pool.query(`UPDATE agents SET consecutive_failures = consecutive_failures + 1 WHERE id = $1 RETURNING consecutive_failures`, [d.agent_id]);
      if (f.rows[0].consecutive_failures >= config.breakerFailures) {
        await pool.query(
          `UPDATE agents SET breaker_open_until = now() + ($2 || ' seconds')::interval, consecutive_failures = 0 WHERE id = $1`,
          [d.agent_id, String(config.breakerCooldownS)]);
        console.warn(`[delivery] circuit OPEN for agent ${d.agent_id.slice(0, 8)} (${config.breakerCooldownS}s)`);
      }
    }
  }));
  return rows.length;
}

// Used at registration to prove the agent controls its webhook URL.
async function sendChallenge(agent, challenge) {
  const body = JSON.stringify({ event: 'agent.verify', challenge });
  const ts = String(Math.floor(Date.now() / 1000));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.webhookTimeoutMs);
  try {
    const res = await fetch(agent.webhook_url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-AgentNet-Event': 'agent.verify', 'X-AgentNet-Timestamp': ts, 'X-AgentNet-Signature': sign(agent.webhook_secret, ts, body) },
      body,
    });
    if (!res.ok) return false;
    const j = await res.json();
    return j.challenge === challenge;
  } catch { return false; } finally { clearTimeout(timer); }
}

module.exports = { processDue, sendChallenge, sign };
