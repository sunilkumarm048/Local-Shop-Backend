import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { env } from './config/env.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/error.js';
import { optionalAuth } from './middleware/auth.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Render's proxy

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    })
  );

  // Razorpay webhook needs the raw body to verify the signature.
  // Mount the raw-body parser BEFORE the JSON parser for that route only.
  app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (env.NODE_ENV !== 'test') {
    app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  }

  // Light global rate-limit. Auth + payment routes will get tighter limits.
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 120,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    })
  );

  // Decode JWT if present, but don't require it globally.
  app.use(optionalAuth);

  app.use('/api', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
