import pinoHttp from 'pino-http';
import { logger, safeError } from '../config/logger.js';
const fields = (req, res, value) => {
  const path = (req.originalUrl || req.url).split('?')[0];
  const event = path.startsWith('/api/v1/auth/')
    ? `auth.${path.split('/').at(-1)}.${res.statusCode < 400 ? 'success' : 'failed'}`
    : undefined;
  return {
    ...value,
    method: req.method,
    path,
    statusCode: res.statusCode,
    ...(res.locals.loggingError ? { err: res.locals.loggingError } : {}),
    ...(event ? { event } : {}),
  };
};
export const createRequestLogger = (options = {}) =>
  pinoHttp({
    logger,
    autoLogging: process.env.NODE_ENV !== 'test',
    serializers: {
      err: safeError,
      req: (req) => ({
        id: req.id,
        method: req.method,
        path: req.url?.split('?')[0],
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (req, res, err) =>
      err || res.statusCode >= 500
        ? 'error'
        : res.statusCode >= 400
          ? 'warn'
          : 'info',
    customSuccessObject: fields,
    customErrorObject: (req, res, error, value) => ({
      ...fields(req, res, value),
      err: res.locals.loggingError || error,
    }),
    customSuccessMessage: () => 'Request completed',
    customErrorMessage: () => 'Request failed',
    ...options,
  });
export const requestLogger = createRequestLogger();
