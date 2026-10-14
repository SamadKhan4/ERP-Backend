import { beforeAll, afterAll, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { readFile, unlink } from 'node:fs/promises';
let database, app, User, Session, hashToken;
const origin = 'http://localhost:5173';
const credentials = {
  email: 'admin@example.test',
  password: 'StrongPassword123',
};
const post = (path, body) =>
  request(app)
    .post(`/api/v1/auth/${path}`)
    .set('Origin', origin)
    .send(body || {});
beforeAll(async () => {
  database = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: database.getUri(),
    CLIENT_URL: `${origin}/,https://adborn-erp.vercel.app/`,
    JWT_ACCESS_SECRET: 'a'.repeat(64),
    JWT_REFRESH_SECRET: 'b'.repeat(64),
    COOKIE_SECURE: 'false',
    COOKIE_SAME_SITE: 'lax',
    RESET_DELIVERY: 'file',
  });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  ({ Session } = await import('../src/models/Session.js'));
  ({ hashToken } = await import('../src/services/tokenService.js'));
  await mongoose.connect(database.getUri());
  await User.create({
    name: 'Test Admin',
    email: credentials.email,
    passwordHash: await bcrypt.hash(credentials.password, 12),
    role: 'employee',
  });
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
test('health reports database connection', async () => {
  const res = await request(app).get('/api/v1/health');
  expect(res.status).toBe(200);
  expect(res.body.data.database).toBe('connected');
});

test('CORS accepts configured origins with trailing slashes and rejects other origins', async () => {
  const allowed = 'https://adborn-erp.vercel.app';
  const preflight = await request(app)
    .options('/api/v1/auth/refresh')
    .set('Origin', allowed)
    .set('Access-Control-Request-Method', 'POST');
  expect(preflight.status).toBe(204);
  expect(preflight.headers['access-control-allow-origin']).toBe(allowed);
  expect(preflight.headers['access-control-allow-credentials']).toBe('true');
  const refresh = await request(app).post('/api/v1/auth/refresh').set('Origin', allowed);
  expect(refresh.status).toBe(401);
  expect(refresh.headers['access-control-allow-origin']).toBe(allowed);
  const rejected = await request(app).post('/api/v1/auth/refresh').set('Origin', 'https://untrusted.example');
  expect(rejected.status).toBe(403);
  expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
});
test('departments require authentication and employee directory enforces RBAC', async () => {
  expect((await request(app).get('/api/v1/departments')).status).toBe(401);
  const login = await post('login', credentials);
  const token = login.body.data.accessToken;
  const result = await request(app)
    .get('/api/v1/departments')
    .auth(token, { type: 'bearer' });
  expect(result.body.data.map((item) => item.id)).toEqual([
    'social_media',
    'web_dev',
    'graphics',
    'video_editing',
    'seo',
  ]);
  expect(
    (
      await request(app)
        .get('/api/v1/hrms/employees')
        .auth(token, { type: 'bearer' })
    ).status,
  ).toBe(403);
  await User.updateOne({ email: credentials.email }, { role: 'super_admin' });
  const employees = await request(app)
    .get('/api/v1/hrms/employees')
    .auth(token, { type: 'bearer' });
  expect(employees.status).toBe(200);
  expect(employees.body.data.items[0].passwordHash).toBeUndefined();
  expect(employees.body.data.pagination.nextCursor).toBeNull();
  expect(
    (
      await request(app)
        .get('/api/v1/hrms/employees?cursor=invalid')
        .auth(token, { type: 'bearer' })
    ).status,
  ).toBe(400);
  await User.updateOne({ email: credentials.email }, { role: 'employee' });
});
test('authentication, rotation, logout, RBAC and strict profile validation', async () => {
  expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
  expect(
    (await post('login', { ...credentials, password: 'wrong' })).status,
  ).toBe(401);
  expect(
    (await request(app).post('/api/v1/auth/login').send(credentials)).status,
  ).toBe(403);
  const login = await post('login', credentials);
  expect(login.status).toBe(200);
  const token = login.body.data.accessToken;
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  expect(cookie).toContain('refreshToken=');
  expect(login.headers['set-cookie'][0]).toContain('HttpOnly');
  expect(
    (await request(app).get('/api/v1/auth/me').auth(token, { type: 'bearer' }))
      .body.data.email,
  ).toBe(credentials.email);
  expect(
    (await request(app).get('/api/v1/users').auth(token, { type: 'bearer' }))
      .status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .patch('/api/v1/users/me')
        .set('Origin', origin)
        .auth(token, { type: 'bearer' })
        .send({ name: 'Updated', role: 'super_admin' })
    ).status,
  ).toBe(400);
  const rotated = await post('refresh').set('Cookie', cookie);
  expect(rotated.status).toBe(200);
  expect((await post('refresh').set('Cookie', cookie)).status).toBe(401);
  const newCookie = rotated.headers['set-cookie'][0].split(';')[0];
  expect((await post('logout').set('Cookie', newCookie)).status).toBe(200);
  expect((await post('refresh').set('Cookie', newCookie)).status).toBe(401);
});
test('password changes revoke access and refresh sessions', async () => {
  const login = await post('login', credentials);
  const response = await post('change-password', {
    currentPassword: credentials.password,
    newPassword: 'NewStrongPassword123',
  }).auth(login.body.data.accessToken, { type: 'bearer' });
  expect(response.status).toBe(200);
  expect(
    (
      await request(app)
        .get('/api/v1/auth/me')
        .auth(login.body.data.accessToken, { type: 'bearer' })
    ).status,
  ).toBe(401);
  expect(await Session.countDocuments()).toBe(0);
  expect(
    (await post('login', { ...credentials, password: 'NewStrongPassword123' }))
      .status,
  ).toBe(200);
});
test('forgot password delivers a private token without revealing account existence', async () => {
  const user = await User.findOne({ email: credentials.email });
  const file = new URL(`../.reset-mail/${user.id}.json`, import.meta.url);
  try {
    const known = await post('forgot-password', { email: credentials.email });
    const unknown = await post('forgot-password', {
      email: 'unknown@example.test',
    });
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    const message = JSON.parse(await readFile(file, 'utf8'));
    const token = message.text.match(/[a-f0-9]{64}/)[0];
    expect(JSON.stringify(known.body)).not.toContain(token);
    expect((await User.findById(user.id).select('+resetHash')).resetHash).toBe(
      hashToken(token),
    );
  } finally {
    await unlink(file).catch(() => {});
  }
});
test('expired reset tokens fail; valid tokens are single use and revoke sessions', async () => {
  const token = 'c'.repeat(64);
  await User.updateOne(
    { email: credentials.email },
    { resetHash: hashToken(token), resetExpires: new Date(Date.now() - 1000) },
  );
  expect(
    (await post('reset-password', { token, password: 'ResetPassword123' }))
      .status,
  ).toBe(400);
  await User.updateOne(
    { email: credentials.email },
    { resetExpires: new Date(Date.now() + 60000) },
  );
  expect(
    (await post('reset-password', { token, password: 'ResetPassword123' }))
      .status,
  ).toBe(200);
  expect(
    (await post('reset-password', { token, password: 'ResetPassword123' }))
      .status,
  ).toBe(400);
  expect(await Session.countDocuments()).toBe(0);
});
