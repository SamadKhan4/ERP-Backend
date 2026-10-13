import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { requestLogger } from './middleware/requestLogger.js';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { router } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY);
app.use(requestLogger);
app.use(helmet());
const origins = env.CLIENT_URL.split(',').map((value) => value.trim());
app.use(cors({ origin: origins, credentials: true }));
app.use((req, res, next) => {
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    (!req.headers.origin || !origins.includes(req.headers.origin))
  )
    return res.status(403).json({
      success: false,
      error: { message: 'Trusted Origin header required' },
    });
  next();
});
app.use(express.json({ limit: '512kb' }));
app.use(cookieParser());
app.use(
  rateLimit({
    windowMs: 60000,
    limit: 200,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
);
app.use('/api/v1', router);
app.use((req, res) =>
  res
    .status(404)
    .json({ success: false, error: { message: 'Route not found' } }),
);
app.use(errorHandler);
