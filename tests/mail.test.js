import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));
let database, app, User, MailJob, processMailQueue, adminToken, hrToken, employeeToken;
const origin = 'http://localhost:5173';
const call = (method, path, token, data) => request(app)[method](`/api/v1${path}`).set('Origin', origin).auth(token, { type: 'bearer' }).send(data);
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: database.getUri(), CLIENT_URL: origin, JWT_ACCESS_SECRET: 'm'.repeat(64), JWT_REFRESH_SECRET: 'n'.repeat(64), COOKIE_SECURE: 'false', MAIL_DELIVERY: 'smtp', SMTP_HOST: 'smtp.test', SMTP_USER: 'sender@test.example', SMTP_PASS: 'not-real', MAIL_FROM: 'sender@test.example', PASSWORD_RESET_URL: `${origin}/reset-password` });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  ({ MailJob } = await import('../src/models/MailJob.js'));
  ({ processMailQueue } = await import('../src/services/mailService.js'));
  await mongoose.connect(database.getUri());
  await Promise.all(Object.values(mongoose.models).map((Model) => Model.init()));
  const { issueSession } = await import('../src/services/tokenService.js');
  for (const role of ['admin', 'hr', 'employee']) {
    const user = await User.create({ name: role, email: `${role}@mail.test`, role, passwordHash: 'unused' });
    const token = (await issueSession(user)).accessToken;
    if (role === 'admin') adminToken = token;
    else if (role === 'hr') hrToken = token;
    else employeeToken = token;
  }
});
afterAll(async () => { await mongoose.disconnect(); await database?.stop(); });

test('user creation queues encrypted welcome mail; retries work and setup link is single use', async () => {
  const created = await call('post', '/user-management', adminToken, { name: '<HR Person>', email: 'welcome@mail.test', role: 'hr', temporaryPassword: 'TemporaryPass123' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const userId = created.body.data._id;
  const job = await MailJob.findOne({ user: userId }).select('+encryptedToken');
  expect(job.status).toBe('PENDING');
  expect(job.encryptedToken).not.toMatch(/^[a-f0-9]{64}$/);
  sendMail.mockRejectedValueOnce(new Error('SMTP_PASS must never leak'));
  await processMailQueue();
  expect((await MailJob.findById(job.id)).status).toBe('PENDING');
  await MailJob.updateOne({ _id: job.id }, { nextAttemptAt: new Date(0) });
  sendMail.mockResolvedValue({ accepted: ['welcome@mail.test'] });
  await processMailQueue();
  const sent = await MailJob.findById(job.id).select('+encryptedToken');
  expect(sent.status).toBe('SENT');
  expect(sent.attempts).toBe(2);
  expect(sent.encryptedToken).toBeUndefined();
  const message = sendMail.mock.calls.at(-1)[0];
  expect(message.to).toBe('welcome@mail.test');
  expect(message.html).toContain('&lt;HR Person&gt;');
  expect(message.text).not.toContain('TemporaryPass123');
  const url = message.text.match(/http:\/\/localhost:5173\/reset-password#[^\s]+/)[0];
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('token');
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  const body = { token, password: 'MyNewPassword123' };
  expect((await call('post', '/auth/reset-password', adminToken, body)).status).toBe(200);
  expect((await call('post', '/auth/reset-password', adminToken, body)).status).toBe(400);
  const listing = await call('get', '/mail', adminToken);
  expect(listing.status).toBe(200);
  expect(JSON.stringify(listing.body)).not.toContain(token);
  expect(JSON.stringify(listing.body)).not.toContain('encryptedToken');
  expect(JSON.stringify(listing.body)).not.toContain('SMTP_PASS');
});
test('mail APIs enforce role hierarchy and resend cooldown', async () => {
  expect((await call('get', '/mail', employeeToken)).status).toBe(403);
  const hrList = await call('get', '/mail', hrToken);
  expect(hrList.body.data.items.every((item) => ['employee', 'executive', 'team_leader', 'lead_caller'].includes(item.role))).toBe(true);
  const target = await User.findOne({ email: 'welcome@mail.test' });
  expect((await call('post', `/mail/users/${target.id}/welcome`, hrToken, {})).status).toBe(404);
  await MailJob.collection.updateOne({ user: target._id }, { $set: { updatedAt: new Date(0) } });
  const responses = await Promise.all([1, 2].map(() => call('post', `/mail/users/${target.id}/welcome`, adminToken, {})));
  expect(responses.map((response) => response.status).sort()).toEqual([202, 429]);
});
test('queue storage failure does not roll back account creation', async () => {
  vi.spyOn(MailJob, 'findOneAndUpdate').mockRejectedValueOnce(new Error('Queue temporarily unavailable'));
  const created = await call('post', '/user-management', adminToken, { name: 'Another HR', email: 'queue-failed@mail.test', role: 'hr', temporaryPassword: 'TemporaryPass123' });
  expect(created.status).toBe(201);
  expect(await User.exists({ email: 'queue-failed@mail.test' })).toBeTruthy();
  vi.restoreAllMocks();
});
