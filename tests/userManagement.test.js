import { afterAll, beforeAll, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';

let app, database, User, superToken;
const origin = 'http://localhost:5173';
const password = 'StrongPassword123';

async function login(email) {
  const response = await request(app).post('/api/v1/auth/login').set('Origin', origin).send({ email, password });
  return response.body.data.accessToken;
}

async function create(token, body) {
  return request(app).post('/api/v1/user-management').set('Origin', origin).auth(token, { type: 'bearer' }).send({ ...body, temporaryPassword: password });
}

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test', MONGO_URI: database.getUri(), CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 'u'.repeat(64), JWT_REFRESH_SECRET: 'v'.repeat(64), COOKIE_SECURE: 'false',
  });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  await mongoose.connect(database.getUri());
  await User.create({ name: 'Super Admin', email: 'super-users@example.test', passwordHash: await bcrypt.hash(password, 12), role: 'super_admin' });
  superToken = await login('super-users@example.test');
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

test('user management enforces the exact creation hierarchy', async () => {
  expect((await create(superToken, { name: 'Admin User', email: 'managed-admin@example.test', role: 'admin' })).status).toBe(201);
  const adminToken = await login('managed-admin@example.test');
  expect((await create(adminToken, { name: 'Manager User', email: 'managed-manager@example.test', role: 'manager' })).status).toBe(201);
  expect((await create(adminToken, { name: 'Another Admin', email: 'blocked-admin@example.test', role: 'admin' })).status).toBe(403);
  const managerToken = await login('managed-manager@example.test');
  expect((await create(managerToken, { name: 'HR User', email: 'managed-hr@example.test', role: 'hr' })).status).toBe(201);
  expect((await create(managerToken, { name: 'Another Manager', email: 'blocked-manager@example.test', role: 'manager' })).status).toBe(403);
  const hrToken = await login('managed-hr@example.test');
  expect((await request(app).get('/api/v1/user-management').auth(hrToken, { type: 'bearer' })).status).toBe(403);
});
