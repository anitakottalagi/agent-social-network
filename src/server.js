const app = require('./app');
const config = require('./config');
const { migrate } = require('./migrate');
const { startWorker } = require('./worker');

(async () => {
  await migrate();
  app.listen(config.port, () => {
    console.log(`[server] AgentNet listening on http://localhost:${config.port}`);
    console.log(`[server] embeddings=${config.embeddingProvider} llm=${config.llmProvider} threshold=${config.threshold}`);
  });
  if (config.startWorker) startWorker();
})().catch((e) => { console.error('Failed to start:', e.message); process.exit(1); });
