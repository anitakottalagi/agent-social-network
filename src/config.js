require('dotenv').config();
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
const bool = (k, d) => (process.env[k] === undefined ? d : process.env[k] === 'true');
const str = (k, d) => process.env[k] || d;

module.exports = {
  port: num('PORT', 3000),
  publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:3000'),
  databaseUrl: str('DATABASE_URL', 'postgres://agentnet:agentnet@localhost:5432/agentnet'),
  adminToken: str('ADMIN_TOKEN', 'change-me-admin-token'),
  embeddingProvider: str('EMBEDDING_PROVIDER', 'mock'),
  llmProvider: str('LLM_PROVIDER', 'mock'),
  embedDim: num('EMBED_DIM', 384),
  openaiKey: str('OPENAI_API_KEY', ''),
  openaiEmbedModel: str('OPENAI_EMBED_MODEL', 'text-embedding-3-small'),
  openaiChatModel: str('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
  anthropicKey: str('ANTHROPIC_API_KEY', ''),
  anthropicModel: str('ANTHROPIC_MODEL', 'claude-sonnet-4-5'),
  annTopK: num('ANN_TOP_K', 50),
  threshold: num('RELEVANCE_THRESHOLD', 0.55),
  maxNotify: num('MAX_NOTIFY_PER_POST', 5),
  requireVerification: bool('REQUIRE_VERIFICATION', false),
  minTrust: num('MIN_TRUST_SCORE', 0.3),
  postsPerHour: num('POSTS_PER_HOUR', 30),
  commentsPerHour: num('COMMENTS_PER_HOUR', 120),
  webhookTimeoutMs: num('WEBHOOK_TIMEOUT_MS', 5000),
  maxAttempts: num('MAX_DELIVERY_ATTEMPTS', 5),
  breakerFailures: num('CIRCUIT_BREAKER_FAILURES', 5),
  breakerCooldownS: num('CIRCUIT_BREAKER_COOLDOWN_S', 60),
  workerIntervalMs: num('WORKER_INTERVAL_MS', 500),
  startWorker: bool('START_WORKER', true),
  ignoreAfterSeconds: num('IGNORE_AFTER_SECONDS', 120),
  learningRate: num('LEARNING_RATE', 0.15),
  demoAgentsPort: num('DEMO_AGENTS_PORT', 4000),
};
