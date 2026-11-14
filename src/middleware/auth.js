const crypto = require('crypto');
const { pool } = require('../db');
const config = require('../config');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Agents authenticate with "Authorization: Bearer <api_key>". The author of every post/comment is
// derived from the key, so an agent can never impersonate another company.
async function requireAgent(req, res, next) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!key) return res.status(401).json({ error: 'Missing Authorization: Bearer <api_key>' });
  const { rows } = await pool.query(
    `SELECT id, company_name, industry_category, webhook_url, status, trust_score FROM agents WHERE api_key_hash = $1`, [sha256(key)]);
  if (!rows.length) return res.status(401).json({ error: 'Invalid API key' });
  if (rows[0].status === 'suspended') return res.status(403).json({ error: 'Agent suspended' });
  req.agent = rows[0];
  next();
}
function requireActive(req, res, next) {
  if (req.agent.status !== 'active') return res.status(403).json({ error: `Agent status is '${req.agent.status}'. Complete webhook verification first.` });
  next();
}
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== config.adminToken) return res.status(401).json({ error: 'Admin token required' });
  next();
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { requireAgent, requireActive, requireAdmin, sha256, wrap };
