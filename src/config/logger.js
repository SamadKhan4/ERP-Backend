import pino from 'pino';
import pretty from 'pino-pretty';
import { env } from './env.js';

const sensitive = [
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'resetToken',
  'resetHash',
  'secret',
  'authorization',
  'cookie',
  'cookies',
  'smtpUrl',
  'apiKey',
  'clientSecret',
  'csrfToken',
  'email',
  'phone',
];
export function safeError(error) {
  if (!error) return undefined;
  // pino-http wraps errors with a serialized view and keeps the original in raw.
  error = error.raw || error;
  let message =
    error.type === 'entity.parse.failed'
      ? 'Malformed JSON request body'
      : error.message || 'Unknown error';
  let stack = error.stack || '';
  for (const [key, value] of Object.entries(process.env)) {
    if (/PASSWORD|SECRET|TOKEN|MONGO_URI|SMTP_URL|SMTP_PASS/.test(key) && value) {
      message = message.split(value).join('[REDACTED]');
      stack = stack.split(value).join('[REDACTED]');
    }
  }
  const mask = (text) =>
    text
      .replace(
        /(password|token|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi,
        '$1=[REDACTED]',
      )
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
  return {
    type: error.name || error.type,
    message: mask(message),
    ...(env.NODE_ENV === 'development' && error.type !== 'entity.parse.failed'
      ? { stack: mask(stack) }
      : {}),
  };
}
export const loggerOptions = {
  level: 'info',
  redact: {
    paths: [
      ...sensitive,
      ...sensitive.map((key) => `*.${key}`),
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'req.body',
      'res.body',
      'body',
    ],
    censor: '[REDACTED]',
  },
  serializers: { err: safeError },
};
export const formatRequest = (log, key = 'msg') => {
  if (!log.method) return log[key];
  const status = log.statusCode || 0;
  const color =
    status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32;
  return `\u001b[${color}m${log.method.padEnd(6)} ${log.path.padEnd(42)} ${status} ${Number(
    log.responseTime || 0,
  )
    .toFixed(1)
    .padStart(7)} ms${log.event ? `  ${log.event}` : ''}\u001b[0m`;
};
const developmentStream =
  env.NODE_ENV === 'development'
    ? pretty({
        colorize: true,
        singleLine: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore:
          'pid,hostname,req,res,responseTime,event,method,path,statusCode,requestId',
        messageFormat: formatRequest,
      })
    : undefined;
export const logger = pino(loggerOptions, developmentStream);
