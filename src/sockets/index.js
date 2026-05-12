import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { pubClient, subClient } from '../config/redis.js';
import { env } from '../config/env.js';
import { verifyToken } from '../utils/jwt.js';
import { registerHandlers } from './handlers.js';

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
    // Auto-join personal room
    socket.join(`user:${socket.userId}`);
    console.log(`[socket] connected user:${socket.userId} (${socket.id})`);

    registerHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(`[socket] disconnected user:${socket.userId} (${reason})`);
    });
  });

  return io;
}
