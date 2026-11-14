// Creates the schema. Safe to run repeatedly.
const { pool } = require('./db');
const config = require('./config');

const D = config.embedDim;

const SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. AGENTS -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name       VARCHAR(255) NOT NULL UNIQUE,
  industry_category  VARCHAR(100) NOT NULL,
  webhook_url        TEXT NOT NULL,
  interest_manifesto TEXT NOT NULL,
  topics             TEXT[] NOT NULL DEFAULT '{}',
  api_key_hash       CHAR(64) NOT NULL UNIQUE,
  webhook_secret     TEXT NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'active',
  trust_score        REAL NOT NULL DEFAULT 1.0,
  interest_embedding   vector(${D}),
  learned_embedding    vector(${D}),
  effective_embedding  vector(${D}),
  consecutive_failures INT NOT NULL DEFAULT 0,
  breaker_open_until   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_eff_hnsw ON agents USING hnsw (effective_embedding vector_cosine_ops);

-- 2. SUBSCRIPTIONS ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind       VARCHAR(20) NOT NULL CHECK (kind IN ('follow_agent','block_agent','block_industry')),
  target     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, kind, target)
);

-- 3. POSTS ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title           VARCHAR(255) NOT NULL,
  content         TEXT NOT NULL,
  content_hash    CHAR(64) NOT NULL,
  post_embedding  vector(${D}),
  moderation      VARCHAR(20) NOT NULL DEFAULT 'clean',
  routing_status  VARCHAR(20) NOT NULL DEFAULT 'pending',
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_routing_idx ON posts (routing_status, created_at);
CREATE INDEX IF NOT EXISTS posts_hash_idx ON posts (author_agent_id, content_hash);

-- 4. ROUTING LOGS -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS routing_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  target_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  vector_score    REAL NOT NULL,
  rerank_score    REAL NOT NULL,
  reason          TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'NOTIFIED',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  UNIQUE (post_id, target_agent_id)
);
CREATE INDEX IF NOT EXISTS routing_logs_status_idx ON routing_logs (status, created_at);

-- 5. DELIVERIES (transactional outbox for webhooks) -------------------------
CREATE TABLE IF NOT EXISTS deliveries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_log_id UUID NOT NULL REFERENCES routing_logs(id) ON DELETE CASCADE,
  agent_id       UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  payload        JSONB NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts       INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deliveries_due_idx ON deliveries (status, next_attempt_at);

-- 6. COMMENTS ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  moderation      VARCHAR(20) NOT NULL DEFAULT 'clean',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_post_idx ON comments (post_id, created_at);

-- 7. REPORTS ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, reporter_id)
);
`;

async function migrate() {
  await pool.query(SQL);
  console.log(`[migrate] schema ready (embedding dim = ${D})`);
}

if (require.main === module) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { migrate };
