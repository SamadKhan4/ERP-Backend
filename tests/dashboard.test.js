import { beforeAll, afterAll, test, expect } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
let database, app, User, issueSession, adminToken, staffToken, admin;
beforeAll(async () => {
  database = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: database.getUri(),
    CLIENT_URL: 'http://localhost:5173',
    JWT_ACCESS_SECRET: 'a'.repeat(64),
    JWT_REFRESH_SECRET: 'b'.repeat(64),
    COOKIE_SECURE: 'false',
    COOKIE_SAME_SITE: 'lax',
    RESET_DELIVERY: 'file',
  });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  ({ issueSession } = await import('../src/services/tokenService.js'));
  await mongoose.connect(database.getUri());
  admin = await User.create({
    name: 'Admin',
    email: 'admin@dashboard.test',
    passwordHash: 'test',
    role: 'admin',
  });
  const employee = await User.create({
    name: 'Staff',
    email: 'staff@dashboard.test',
    passwordHash: 'test',
    role: 'employee',
  });
  adminToken = (await issueSession(admin)).accessToken;
  staffToken = (await issueSession(employee)).accessToken;
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
const get = (token = adminToken, suffix = '') =>
  request(app)
    .get(`/api/v1/dashboard/overview${suffix}`)
    .auth(token, { type: 'bearer' });
test('company overview denies anonymous and self-service roles; validates dates', async () => {
  expect((await request(app).get('/api/v1/dashboard/overview')).status).toBe(
    401,
  );
  expect((await get(staffToken)).status).toBe(403);
  expect((await get(adminToken, '?date=2026-02-30')).status).toBe(400);
  expect((await get(adminToken, '?date=bad')).status).toBe(400);
});
test('empty database returns honest zero values and six monthly buckets', async () => {
  const result = await get();
  expect(result.status).toBe(200);
  expect(result.body.data.finance).toEqual({
    paid: 0,
    outstanding: 0,
    overdue: 0,
    overdueCount: 0,
  });
  expect(result.body.data.revenue).toHaveLength(6);
  expect(result.body.data.tasks).toEqual([]);
  expect(result.body.data.clients).toBe(0);
});
test('overview aggregates real invoices, unique attendance, tasks and CRM while excluding deleted records', async () => {
  const { Invoice } = await import('../src/models/Invoice.js');
  const { HRMSRecord } = await import('../src/models/HRMSRecord.js');
  const { TeamTask } = await import('../src/models/TeamWork.js');
  const { Lead } = await import('../src/models/Lead.js');
  const day = new Date('2026-09-15T00:00:00+05:30');
  const invoices = [
    ['Paid', 100],
    ['Sent', 200],
    ['Overdue', 300],
    ['Draft', 400],
    ['Cancelled', 500],
  ].map(([status, grandTotal], i) => ({
    invoiceNumber: `DASH-${i}`,
    client: { company: 'Actual Client' },
    grandTotal,
    status,
    dueDate: new Date('2000-01-01'),
    invoiceDate: new Date(),
    deletedAt: null,
    createdAt: new Date(),
  }));
  await Invoice.collection.insertMany([
    ...invoices,
    {
      ...invoices[0],
      invoiceNumber: 'DELETED',
      grandTotal: 999,
      deletedAt: new Date(),
    },
  ]);
  await HRMSRecord.collection.insertMany(
    [0, 1].map(() => ({
      module: 'attendance',
      employee: admin._id,
      deletedAt: null,
      data: { date: day, checkIn: day },
    })),
  );
  await HRMSRecord.collection.insertOne({
    module: 'attendance',
    employee: admin._id,
    deletedAt: null,
    data: { date: new Date(day.getTime() - 86400000), checkIn: day },
  });
  await HRMSRecord.collection.insertOne({
    module: 'leave',
    status: 'Pending',
    deletedAt: null,
  });
  await TeamTask.collection.insertMany([
    {
      taskId: 'DASH-TASK-1',
      title: 'No deadline',
      status: 'TODO',
      deletedAt: null,
    },
    {
      taskId: 'DASH-TASK-2',
      title: 'Due task',
      status: 'BLOCKED',
      dueDate: day,
      assignedTo: admin._id,
      deletedAt: null,
    },
    {
      taskId: 'DASH-TASK-3',
      title: 'Deleted task',
      status: 'TODO',
      deletedAt: new Date(),
    },
  ]);
  await Lead.collection.insertMany([
    { leadId: 'DASH-LEAD-1', stage: 'NEW', deletedAt: null },
    { leadId: 'DASH-LEAD-2', stage: 'NEW', deletedAt: new Date() },
  ]);
  const response = await get(adminToken, '?date=2026-09-15');
  expect(response.status).toBe(200);
  const data = response.body.data;
  expect(data.finance).toEqual({
    paid: 100,
    outstanding: 500,
    overdue: 500,
    overdueCount: 2,
  });
  expect(data.revenue.reduce((sum, row) => sum + row.billed, 0)).toBe(600);
  expect(data.revenue.reduce((sum, row) => sum + row.paid, 0)).toBe(100);
  expect(data.attendance.present).toBe(1);
  expect(data.attendance.employees).toBe(2);
  expect(data.attendance.percent).toBe(50);
  expect(data.pendingLeaves).toBe(1);
  expect(data.leads).toEqual({ NEW: 1 });
  expect(data.tasks.map((task) => task.title)).toEqual([
    'Due task',
    'No deadline',
  ]);
  expect(data.invoices).toHaveLength(5);
  expect(
    (await get(adminToken, '?date=2026-09-16')).body.data.attendance.present,
  ).toBe(0);
});
