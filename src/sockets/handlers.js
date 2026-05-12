import { DeliveryProfile } from '../models/index.js';

/**
 * Wire up event handlers for a connected socket.
 * Heavy logic (order events, payment confirmations) is implemented in services
 * and emitted to rooms from there — these handlers mostly handle the client
 * publishing data TO the server (location pings, room joins).
 */
export function registerHandlers(io, socket) {
  // Client subscribes to a specific order they're allowed to see.
  // Authorization is enforced when the order is fetched server-side in Phase 3.
  socket.on('order:join', ({ orderId }) => {
    if (typeof orderId === 'string') {
      socket.join(`order:${orderId}`);
    }
  });

  socket.on('order:leave', ({ orderId }) => {
    socket.leave(`order:${orderId}`);
  });

  // Delivery partner reports live location ~ every 5s while on a job.
  // We broadcast to anyone watching the relevant order(s) — Phase 5 wires this
  // through to the customer tracking page.
  socket.on('delivery:location', async ({ lat, lng, orderIds = [] }) => {
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    if (!socket.roles?.includes('delivery')) return;

    // Persist last-known location (lightweight write — could be debounced)
    try {
      await DeliveryProfile.updateOne(
        { user: socket.userId },
        {
          $set: {
            'currentLocation.coordinates': [lng, lat],
            'currentLocation.updatedAt': new Date(),
          },
        }
      );
    } catch (err) {
      console.error('[socket] failed to update location:', err.message);
    }

    // Fan out to anyone tracking these orders
    for (const orderId of orderIds) {
      io.to(`order:${orderId}`).emit('delivery:location', {
        orderId,
        lat,
        lng,
        at: Date.now(),
      });
    }
  });

  // Delivery partner toggles online/offline
  socket.on('delivery:online', async ({ online }) => {
    if (!socket.roles?.includes('delivery')) return;
    try {
      await DeliveryProfile.updateOne(
        { user: socket.userId },
        { $set: { available: !!online } }
      );
      if (online) socket.join('delivery:available');
      else socket.leave('delivery:available');
    } catch (err) {
      console.error('[socket] failed to toggle availability:', err.message);
    }
  });
}
