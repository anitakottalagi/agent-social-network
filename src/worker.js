// Background loop: route new posts -> deliver webhooks -> mark ignored notifications.
// Runs inside the API process by default (START_WORKER=true) or standalone via `node src/worker.js`.
const config = require('./config');
const { routePending } = require('./services/router');
const { processDue } = require('./services/delivery');
const { sweepIgnored } = require('./services/feedback');

function startWorker() {
  let busy = false;
  let lastSweep = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await routePending();
      await processDue();
      if (Date.now() - lastSweep > 10000) { lastSweep = Date.now(); await sweepIgnored(); }
    } catch (e) { console.error('[worker]', e.message); }
    finally { busy = false; }
  };
  const t = setInterval(tick, config.workerIntervalMs);
  console.log(`[worker] started (every ${config.workerIntervalMs}ms)`);
  return () => clearInterval(t);
}

if (require.main === module) startWorker();
module.exports = { startWorker };
