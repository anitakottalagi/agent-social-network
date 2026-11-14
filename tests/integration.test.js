// Needs Postgres+pgvector (see README). Spins up its own receiver and calls services directly.
process.env.REQUIRE_VERIFICATION = 'true';
process.env.START_WORKER = 'false';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const request = (app) => new Promise((resolve) => { const s = app.listen(0, () => resolve({ s, base: `http://localhost:${s.address().port}` })); });

const { pool, fromVec } = require('../src/db');
const { migrate } = require('../src/migrate');
const app = require('../src/app');
const { routePending } = require('../src/services/router');
const { processDue } = require('../src/services/delivery');
const { sweepIgnored } = require('../src/services/feedback');

let server, base, receiver, recvPort;
const received = [];
let failNext = 0;
const secrets = {};

async function api(method, url, key, body) {
  const res = await fetch(base + '/api/v1' + url, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test.before(async () => {
  await migrate();
  await pool.query('TRUNCATE reports, comments, deliveries, routing_logs, posts, subscriptions, agents CASCADE');
  ({ s: server, base } = await request(app));
  receiver = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const slug = req.url.split('/').pop();
      const ts = req.headers['x-agentnet-timestamp'];
      const expected = 'sha256=' + crypto.createHmac('sha256', secrets[slug] || '').update(`${ts}.${raw}`).digest('hex');
      if (req.headers['x-agentnet-signature'] !== expected) { res.statusCode = 401; return res.end('{}'); }
      const body = JSON.parse(raw);
      if (body.event === 'agent.verify') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ challenge: body.challenge })); }
      if (failNext > 0) { failNext--; res.statusCode = 500; return res.end('{}'); }
      received.push({ slug, body });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => receiver.listen(0, r));
  recvPort = receiver.address().port;
});
test.after(async () => { server.close(); receiver.close(); await pool.end(); });

const reg = (name, manifesto, slug) => api('POST', '/agents/register', null, {
  company_name: name, industry_category: 'Test', interest_manifesto: manifesto, webhook_url: `http://localhost:${recvPort}/${slug}` });

test('webhook verification gates posting; retry + HMAC + feedback learning work', async () => {
  // A) Registration: webhook secret is unknown to the receiver until we learn it, so verification starts 'pending'.
  const a = await reg('AlphaFood', 'Food delivery restaurants and festive discounts for customers', 'alpha');
  secrets.alpha = a.json.webhook_secret;
  assert.equal(a.json.agent.status, 'pending');
  let p = await api('POST', '/posts', a.json.api_key, { title: 'Test post here', content: 'Some content that is long enough' });
  assert.equal(p.status, 403, 'pending agents cannot post');
  assert.equal((await api('POST', '/agents/me/verify', a.json.api_key)).json.verified, true);

  const b = await reg('BetaPay', 'UPI payments card offers and merchant cashback for festive food delivery discounts', 'beta');
  secrets.beta = b.json.webhook_secret;
  await api('POST', '/agents/me/verify', b.json.api_key);

  // B) Publish; routing is async.
  p = await api('POST', '/posts', a.json.api_key, { title: 'Diwali delivery offer', content: '5% off all deliveries on Diwali.' });
  assert.equal(p.status, 201);
  await routePending();

  // C) Delivery fails once -> retried with backoff, HMAC verified by receiver (bad signature would 401 and never deliver)
  failNext = 1;
  await processDue();
  let d = (await pool.query('SELECT status, attempts FROM deliveries')).rows[0];
  assert.equal(d.status, 'pending'); assert.equal(d.attempts, 1);
  await pool.query(`UPDATE deliveries SET next_attempt_at = now()`);
  await processDue();
  d = (await pool.query('SELECT status, attempts FROM deliveries')).rows[0];
  assert.equal(d.status, 'delivered');
  assert.equal(received.length, 1);
  assert.equal(received[0].body.post.title, 'Diwali delivery offer');

  // D) Engagement moves the agent's effective vector toward the post (higher cosine afterwards).
  const before = (await pool.query(`SELECT 1 - (a.effective_embedding <=> p.post_embedding) AS s FROM agents a, posts p WHERE a.company_name='BetaPay'`)).rows[0].s;
  const c = await api('POST', `/posts/${p.json.post.id}/comments`, b.json.api_key, { content: 'We can add cashback on UPI payments for this offer.' });
  assert.equal(c.status, 201); assert.equal(c.json.counted_as_engagement, true);
  const after = (await pool.query(`SELECT 1 - (a.effective_embedding <=> p.post_embedding) AS s FROM agents a, posts p WHERE a.company_name='BetaPay'`)).rows[0].s;
  assert.ok(after > before, `similarity should increase (${before} -> ${after})`);

  // E) Ignored notifications push away; non-notified agents cannot comment.
  const stranger = await reg('Gamma', 'Heavy machinery and mining equipment leasing', 'gamma');
  secrets.gamma = stranger.json.webhook_secret; await api('POST', '/agents/me/verify', stranger.json.api_key);
  assert.equal((await api('POST', `/posts/${p.json.post.id}/comments`, stranger.json.api_key, { content: 'spam spam spam' })).status, 403);

  // F) Blocklist (stage 1) is honoured.
  await api('POST', '/agents/me/subscriptions', b.json.api_key, { kind: 'block_agent', target: a.json.agent.id });
  p = await api('POST', '/posts', a.json.api_key, { title: 'Another festive offer', content: 'Flat 10% cashback on food delivery during festive season.' });
  await routePending();
  const rows = (await pool.query(`SELECT count(*)::int AS n FROM routing_logs WHERE post_id = $1 AND target_agent_id = $2`, [p.json.post.id, b.json.agent.id])).rows[0];
  assert.equal(rows.n, 0, 'blocked author must not be routed to BetaPay');
  assert.equal(typeof (await sweepIgnored(0)), 'number');
});

test('circuit breaker opens after repeated delivery failures', async () => {
  const beta = (await pool.query(`SELECT id FROM agents WHERE company_name='BetaPay'`)).rows[0].id;
  const log = (await pool.query(`SELECT id FROM routing_logs WHERE target_agent_id = $1 LIMIT 1`, [beta])).rows[0].id;
  await pool.query(`UPDATE agents SET webhook_url = 'http://localhost:1/dead', consecutive_failures = 4 WHERE id = $1`, [beta]);
  await pool.query(`INSERT INTO deliveries (routing_log_id, agent_id, payload) VALUES ($1,$2,$3)`, [log, beta, JSON.stringify({ event: 'post.relevant' })]);
  await processDue();
  const a = (await pool.query(`SELECT breaker_open_until FROM agents WHERE id = $1`, [beta])).rows[0];
  assert.ok(a.breaker_open_until && new Date(a.breaker_open_until) > new Date(), 'breaker should be open');
});

test('unverifiable (dead) webhook keeps agent pending and unable to post', async () => {
  const bad = await api('POST', '/agents/register', null, { company_name: 'DownCorp', industry_category: 'Test', interest_manifesto: 'food delivery festive discounts offers', webhook_url: 'http://localhost:1/dead' });
  assert.equal(bad.status, 201); assert.equal(bad.json.agent.status, 'pending');
  assert.equal((await api('POST', '/posts', bad.json.api_key, { title: 'Hello world', content: 'Should not be allowed yet' })).status, 403);
});
