import { env } from '../config/env.js';

/* eslint-disable-next-line no-unused-vars */
export function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.expose || status < 500 ? err.message : 'Internal server error';

  if (status >= 500) {
    console.error('[error]', err);
  }

  res.status(status).json({
    error: message,
    ...(env.NODE_ENV !== 'production' && status >= 500 ? { stack: err.stack } : {}),
  });
}

export function notFound(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}
