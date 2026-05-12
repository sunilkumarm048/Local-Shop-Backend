import Redis from 'ioredis';
import { env } from './env.js';

/**
 * Two Redis clients:
 *   - `redis`     general-purpose client (cache, rate-limit, OTP store)
 *   - `pubClient` / `subClient`  for the Socket.IO adapter (must be separate)
 *
 * Why separate clients for socket.io? The adapter uses PSUBSCRIBE on subClient,
 * which blocks that connection from doing other commands.
 */

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export const pubClient = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const subClient = pubClient.duplicate();

for (const [name, client] of [['redis', redis], ['pub', pubClient], ['sub', subClient]]) {
  client.on('ready', () => console.log(`[redis:${name}] ready`));
  client.on('error', (err) => console.error(`[redis:${name}] error:`, err.message));
}
