import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { pubClient, subClient } from '../config/redis.js';
import { env } from '../config/env.js';
import { verifyToken } from '../utils/jwt.js';
import { registerHandlers } from './handlers.js';
import { Shop } from '../models/index.js';

/**
 * Initialise Socket.IO bound to the given HTTP server.
 * Returns the io instance so other modules can emit to rooms.
 *
 * Room naming convention:
 *   user:<userId>          everything addressed to one user
 *   shop:<shopId>          new orders, status updates for a shop owner
 *   order:<orderId>        live tracking — joined by customer + delivery + shop
 *   delivery:available     all online delivery partners (job broadcast)
 */
export function initSockets(httpServer) {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.adapter(createAdapter(pubClient, subClient));

  // JWT auth handshake — client sends `auth.token` on connect
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Auth token required'));
    try {
      const decoded = verifyToken(token);
      socket.userId = decoded.sub;
      socket.roles = decoded.roles || [];
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    // Auto-join personal room — everything addressed to a user lands here.
    socket.join(`user:${socket.userId}`);
    console.log(`[socket] connected user:${socket.userId} (${socket.id})`);

    // Shop owners auto-join their shop room(s) so order:new / order:status_update
    // events from the API land in their dashboard live.
    //
    // We do this fire-and-forget: a tiny race window during the first ~tens of
    // millis after connect is acceptable, and re-connects re-run this.
    if (socket.roles?.includes('shop')) {
      Shop.find({ owner: socket.userId })
        .select('_id')
        .lean()
        .then((shops) => {
          for (const s of shops) {
            socket.join(`shop:${s._id}`);
          }
          if (shops.length) {
            console.log(
              `[socket] user:${socket.userId} joined shop rooms ${shops
                .map((s) => s._id)
                .join(', ')}`
            );
          }
        })
        .catch((err) => {
          console.error('[socket] failed to auto-join shop rooms:', err.message);
        });
    }

    registerHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(`[socket] disconnected user:${socket.userId} (${reason})`);
    });
  });

  return io;
}
