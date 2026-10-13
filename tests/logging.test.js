import { beforeAll, test, expect } from 'vitest';
import express from 'express';
import pino from 'pino';
import request from 'supertest';
let loggerOptions, formatRequest, createRequestLogger, errorHandler, safeError;
beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    CLIENT_URL: 'http://localhost:5173',
    MONGO_URI: 'mongodb://127.0.0.1:27017/unused',
    JWT_ACCESS_SECRET: 'a'.repeat(64),
    JWT_REFRESH_SECRET: 'b'.repeat(64),
  });
  ({ loggerOptions, formatRequest, safeError } =
    await import('../src/config/logger.js'));
  ({ createRequestLogger } =
    await import('../src/middleware/requestLogger.js'));
  ({ errorHandler } = await import('../src/middleware/errorHandler.js'));
});
test('request colors match each status class', () => {
  for (const [statusCode, color] of [
    [200, 32],
    [302, 36],
    [400, 33],
    [500, 31],
  ])
    expect(
      formatRequest({
        method: 'GET',
        path: '/health',
        statusCode,
        responseTime: 12,
      }),
    ).toContain(`\u001b[${color}mGET`);
});
test('wrapped JSON parse errors cannot expose fragments of request bodies', () => {
  const raw = Object.assign(
    new SyntaxError('Invalid JSON: password=body-secret'),
    { type: 'entity.parse.failed' },
  );
  const result = safeError({ type: 'SyntaxError', message: raw.message, raw });
  expect(result.message).toBe('Malformed JSON request body');
  expect(result.stack).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('body-secret');
});
test('one JSON log per request, safe serialization and meaningful errors', async () => {
  const lines = [];
  const log = pino(loggerOptions, {
    write(line) {
      lines.push(JSON.parse(line));
    },
  });
  const app = express();
  app.use(createRequestLogger({ logger: log, autoLogging: true }));
  app.get('/ok', (req, res) => res.json({ password: 'response-secret' }));
  app.get('/redirect', (req, res) => res.redirect('/ok'));
  app.get('/bad', (req, res, next) => {
    const err = new Error('Invalid input');
    err.status = 400;
    next(err);
  });
  app.get('/error', () => {
    throw new Error('Database operation failed');
  });
  app.use(errorHandler);
  for (const path of ['/ok?token=query-secret', '/redirect', '/bad', '/error'])
    await request(app)
      .get(path)
      .set('Authorization', 'Bearer header-secret')
      .set('Cookie', 'refreshToken=cookie-secret');
  expect(lines).toHaveLength(4);
  expect(lines.map((line) => line.statusCode)).toEqual([200, 302, 400, 500]);
  expect(lines.map((line) => line.level)).toEqual([30, 30, 40, 50]);
  expect(lines[3].err.message).toBe('Database operation failed');
  const output = JSON.stringify(lines);
  for (const value of [
    'query-secret',
    'header-secret',
    'cookie-secret',
    'response-secret',
  ])
    expect(output).not.toContain(value);
  log.info(
    { password: 'private-password', nested: { accessToken: 'private-token' } },
    'Redaction check',
  );
  expect(JSON.stringify(lines.at(-1))).not.toContain('private-password');
  expect(JSON.stringify(lines.at(-1))).not.toContain('private-token');
});
