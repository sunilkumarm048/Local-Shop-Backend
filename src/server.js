import http from 'node:http';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';
import { createApp } from './app.js';
import { initSockets } from './sockets/index.js';
import { startAutoAssign } from './services/autoAssign.js';
import { startPendingOrderCleanup } from './services/pendingCleanup.js';
import { startSlotReminder } from './services/slotReminder.js';
import { setPushIO } from './services/push.js';

async function start() {
  await connectDB();

  const app = createApp();
  const httpServer = http.createServer(app);
  const io = initSockets(httpServer);

  // Make io accessible to route handlers via app.get('io')
  app.set('io', io);

  // Give the push service the io instance so sendPushToUser() can emit
  // in-app socket notifications (it's called from routes that don't receive io).
  setPushIO(io);

  httpServer.listen(env.PORT, () => {
    console.log(`[server] listening on http://localhost:${env.PORT}`);
    console.log(`[server] CORS origin: ${env.CLIENT_ORIGIN}`);
    console.log(`[server] env: ${env.NODE_ENV}`);
  });

  // Phase 5b — background worker that auto-assigns idle pickups to the
  // nearest online partner. No-op when nothing matches.
  startAutoAssign(io);
  startPendingOrderCleanup();
  startSlotReminder();

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`[server] ${signal} received, shutting down...`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
