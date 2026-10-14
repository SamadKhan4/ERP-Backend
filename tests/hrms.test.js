import { beforeAll, afterAll, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let database, app, User, EmployeeProfile, HRMSRecord, adminToken, employeeToken, uploadDirectory;
const origin = 'http://localhost:5173';
const adminCredentials = {
  email: 'hr-admin@example.test',
  password: 'StrongPassword123',
};

const write = (method, path, token, body) =>
  request(app)[method](`/api/v1/hrms${path}`)
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send(body);

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  uploadDirectory = await mkdtemp(join(tmpdir(), 'adborn-onboarding-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: database.getUri(),
    CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 'h'.repeat(64),
    JWT_REFRESH_SECRET: 'i'.repeat(64),
    COOKIE_SECURE: 'false',
    RESET_DELIVERY: 'file',
    ONBOARDING_UPLOAD_DIR: uploadDirectory,
  });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  ({ EmployeeProfile } = await import('../src/models/EmployeeProfile.js'));
  ({ HRMSRecord } = await import('../src/models/HRMSRecord.js'));
  await mongoose.connect(database.getUri());
  await User.create({
    name: 'HR Admin',
    email: adminCredentials.email,
    passwordHash: await bcrypt.hash(adminCredentials.password, 12),
    role: 'super_admin',
  });
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send(adminCredentials);
  adminToken = login.body.data.accessToken;
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
  await rm(uploadDirectory, { recursive: true, force: true });
});

test('employee lifecycle stores a separate profile and never returns password hashes', async () => {
  const onboarding = await write('post', '/onboarding', adminToken, {
    personal: { fullName: 'Riya Shah', email: 'riya@example.test', dateOfBirth: '1998-10-20', phone: '9876543210', gender: 'Female', bloodGroup: 'B+' },
    employment: { department: 'graphics', designation: 'Graphic Designer', employmentType: 'full_time', joiningDate: '2026-10-13', workLocation: 'Mumbai' },
    address: { current: 'Mumbai current address', permanent: 'Mumbai permanent address' },
    emergencyContact: { name: 'Raj Shah', phone: '9876543211', relationship: 'Father' },
    education: [{ qualification: 'BFA', institute: 'Design Institute', year: 2020 }],
    experience: [],
  });
  expect(onboarding.status).toBe(201);
  expect(onboarding.body.data.status).toBe('Unassigned');
  expect(await User.exists({ email: 'riya@example.test' })).toBeNull();
  const onboardingId = onboarding.body.data._id;
  expect((await write('post', `/onboarding/${onboardingId}/complete`, adminToken, {})).status).toBe(409);

  const created = await write('post', `/employees/from-onboarding/${onboardingId}`, adminToken, { temporaryPassword: 'EmployeePass123' });
  expect(created.status).toBe(201);
  expect(created.body.data.onboarding.status).toBe('In Progress');
  expect(JSON.stringify(created.body)).not.toContain('password');
  expect(created.body.data.profile.employeeCode).toMatch(/^ADB-EMP-\d{4,}$/);
  const employeeId = created.body.data.employee._id;
  expect(await EmployeeProfile.exists({ user: employeeId })).toBeTruthy();

  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ email: 'riya@example.test', password: 'EmployeePass123' });
  employeeToken = login.body.data.accessToken;

  for (const type of ['identity_proof', 'address_proof', 'profile_photo', 'education', 'bank_proof']) {
    const uploaded = await request(app).post('/api/v1/hrms/self/onboarding/documents').set('Origin', origin).auth(employeeToken, { type: 'bearer' }).field('type', type).attach('file', Buffer.from('%PDF onboarding test'), { filename: `${type}.pdf`, contentType: 'application/pdf' });
    expect(uploaded.status).toBe(201);
    expect((await write('patch', `/onboarding/${onboardingId}/documents/${uploaded.body.data._id}/verify`, adminToken, { status: 'Verified' })).status).toBe(200);
  }
  const ownOnboarding = await request(app).get('/api/v1/hrms/self/onboarding').auth(employeeToken, { type: 'bearer' });
  expect(ownOnboarding.status).toBe(200);
  expect(ownOnboarding.body.data.documents).toHaveLength(5);
  const completed = await write('post', `/onboarding/${onboardingId}/complete`, adminToken, {});
  expect(completed.status).toBe(200);
  expect(completed.body.data.status).toBe('Completed');
  expect(completed.body.data.department).toBe('graphics');
  const profile = await request(app)
    .get('/api/v1/hrms/self/profile')
    .auth(employeeToken, { type: 'bearer' });
  expect(profile.body.data.profile.designation).toBe('Graphic Designer');

  const updated = await write('patch', `/employees/${employeeId}`, adminToken, {
    designation: 'Senior Graphic Designer',
  });
  expect(updated.body.data.profile.designation).toBe(
    'Senior Graphic Designer',
  );
});

test('direct employee creation is blocked for HR and privileged roles cannot bypass onboarding', async () => {
  const hrUser = await User.create({
    name: 'HR User',
    email: 'hr-user@example.test',
    passwordHash: await bcrypt.hash('HRUserPassword123', 12),
    role: 'hr',
  });
  const otherHr = await User.create({
    name: 'Other HR',
    email: 'other-hr@example.test',
    passwordHash: await bcrypt.hash('OtherHRPassword123', 12),
    role: 'hr',
  });
  const manager = await User.create({
    name: 'Protected Manager',
    email: 'protected-manager@example.test',
    passwordHash: await bcrypt.hash('ManagerPassword123', 12),
    role: 'manager',
  });
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ email: 'hr-user@example.test', password: 'HRUserPassword123' });
  const hrToken = login.body.data.accessToken;
  const directory = await request(app)
    .get('/api/v1/hrms/employees')
    .auth(hrToken, { type: 'bearer' });
  expect(directory.status).toBe(200);
  expect(directory.body.data.items.map((item) => item.role)).not.toContain('super_admin');
  expect(directory.body.data.items.map((item) => item.role)).not.toContain('manager');
  expect(directory.body.data.items.map((item) => item.role)).not.toContain('hr');
  expect(directory.body.data.items.map((item) => item.email)).not.toContain(hrUser.email);
  expect(directory.body.data.items.map((item) => item.email)).not.toContain(otherHr.email);
  expect((await request(app).get(`/api/v1/hrms/employees/${manager.id}`).auth(hrToken, { type: 'bearer' })).status).toBe(404);
  expect((await write('patch', `/employees/${manager.id}`, hrToken, { name: 'Blocked update' })).status).toBe(403);
  expect((await write('delete', `/employees/${otherHr.id}`, hrToken)).status).toBe(403);
  const privileged = await write('post', '/employees', hrToken, {
    name: 'Unauthorized Manager',
    email: 'unauthorized-manager@example.test',
    temporaryPassword: 'EmployeePass123',
    role: 'manager',
  });
  expect(privileged.status).toBe(409);
  expect(await User.exists({ email: 'unauthorized-manager@example.test' })).toBeNull();

  const employee = await write('post', '/employees', hrToken, {
    name: 'Standard Employee',
    email: 'standard-employee@example.test',
    temporaryPassword: 'EmployeePass123',
  });
  expect(employee.status).toBe(409);
  expect(await User.exists({ email: 'standard-employee@example.test' })).toBeNull();
});

test('validated resource CRUD, pagination, status review and soft archive work', async () => {
  const invalid = await write('post', '/holidays', adminToken, {
    title: 'Invalid Holiday',
    status: 'Published',
    data: { type: 'company' },
  });
  expect(invalid.status).toBe(400);

  const created = await write('post', '/holidays', adminToken, {
    title: 'Diwali',
    status: 'Published',
    effectiveDate: '2026-11-08T00:00:00.000Z',
    data: {
      date: '2026-11-08T00:00:00.000Z',
      type: 'company',
      description: 'Company holiday',
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.data._id;

  const list = await request(app)
    .get('/api/v1/hrms/holidays?limit=1')
    .auth(adminToken, { type: 'bearer' });
  expect(list.body.data.items).toHaveLength(1);
  expect(list.body.data.items[0].title).toBe('Diwali');

  const reviewed = await write(
    'patch',
    `/holidays/${id}/status`,
    adminToken,
    { status: 'Archived', note: 'Calendar updated' },
  );
  expect(reviewed.body.data.status).toBe('Archived');

  expect((await write('delete', `/holidays/${id}`, adminToken)).status).toBe(
    200,
  );
  expect(
    await HRMSRecord.exists({ _id: id, deletedAt: { $ne: null } }),
  ).toBeTruthy();
  const missing = await request(app)
    .get(`/api/v1/hrms/holidays/${id}`)
    .auth(adminToken, { type: 'bearer' });
  expect(missing.status).toBe(404);
});

test('employee self-service is ownership-bound and dashboard uses stored records', async () => {
  const employee = await User.findOne({ email: 'riya@example.test' });
  const leave = await write('post', '/self/leave', employeeToken, {
    title: 'Annual leave',
    data: {
      leaveType: 'annual',
      startDate: '2026-10-20T00:00:00.000Z',
      endDate: '2026-10-22T00:00:00.000Z',
      reason: 'Family function',
    },
  });
  expect(leave.status).toBe(201);
  expect(leave.body.data.employee).toBe(String(employee._id));
  expect(leave.body.data.status).toBe('Pending');
  const ownLeave = await request(app)
    .get('/api/v1/hrms/self/leave')
    .auth(employeeToken, { type: 'bearer' });
  expect(ownLeave.status).toBe(200);
  expect(ownLeave.body.data.items).toHaveLength(1);

  expect(
    (
      await request(app)
        .get('/api/v1/hrms/assets')
        .auth(employeeToken, { type: 'bearer' })
    ).status,
  ).toBe(403);
  const dashboard = await request(app)
    .get('/api/v1/hrms/dashboard')
    .auth(adminToken, { type: 'bearer' });
  expect(dashboard.status).toBe(200);
  expect(dashboard.body.data.kpis.totalEmployees).toBe(
    await User.countDocuments({ role: { $nin: ['customer'] }, active: true }),
  );
  expect(dashboard.body.data.pendingApprovals).toEqual(
    expect.arrayContaining([{ module: 'leave', count: 1 }]),
  );
});

test('attendance punches and leave ledger enforce core workflow rules', async () => {
  const employee = await User.findOne({ email: 'riya@example.test' });
  const checkIn = await write('post', '/attendance/check-in', employeeToken, {});
  expect(checkIn.status).toBe(201);
  expect((await write('post', '/attendance/check-in', employeeToken, {})).status).toBe(409);
  const blockedCheckout = await write('post', '/attendance/check-out', employeeToken, {});
  expect(blockedCheckout.status).toBe(409);
  expect(blockedCheckout.body.error.message).toMatch(/daily report/i);
  const report = await write('post', '/daily-reports', employeeToken, {
    summary: 'Completed the employee dashboard workflow and verified attendance.',
    completedTasks: ['Employee dashboard workflow'],
    tomorrowPlan: 'Continue integration testing',
  });
  expect(report.status).toBe(201);
  const checkOut = await write('post', '/attendance/check-out', employeeToken, {});
  expect(checkOut.status).toBe(200);
  expect(checkOut.body.data.data.minutesWorked).toBeGreaterThanOrEqual(0);
  const employeeDashboard = await request(app).get('/api/v1/hrms/employee-dashboard').auth(employeeToken, { type: 'bearer' });
  expect(employeeDashboard.status).toBe(200);
  expect(employeeDashboard.body.data.dailyReport.status).toBe('Submitted');

  const adjusted = await write('post', '/leaves/adjustments', adminToken, {
    employee: String(employee._id),
    leaveType: 'annual',
    amount: 5,
    reason: 'Opening annual leave balance',
  });
  expect(adjusted.status).toBe(201);
  const requested = await write('post', '/leaves/requests', employeeToken, {
    leaveType: 'annual',
    startDate: '2026-12-10T00:00:00.000Z',
    endDate: '2026-12-11T00:00:00.000Z',
    reason: 'Family event',
  });
  expect(requested.status).toBe(201);
  const leaveId = requested.body.data._id;
  expect((await write('patch', `/leaves/requests/${leaveId}/approve`, adminToken, {})).status).toBe(200);
  const balance = await request(app).get('/api/v1/hrms/leaves/balance/me').auth(employeeToken, { type: 'bearer' });
  expect(balance.body.data).toEqual(expect.arrayContaining([{ leaveType: 'annual', balance: 3 }]));
  expect((await write('patch', `/leaves/requests/${leaveId}/cancel`, employeeToken, {})).status).toBe(200);
  const restored = await request(app).get('/api/v1/hrms/leaves/balance/me').auth(employeeToken, { type: 'bearer' });
  expect(restored.body.data).toEqual(expect.arrayContaining([{ leaveType: 'annual', balance: 5 }]));
});

test('candidate conversion is idempotent and payroll keeps calculation snapshots', async () => {
  const candidate = await write('post', '/candidates', adminToken, {
    title: 'Aman Verma',
    department: 'web_dev',
    status: 'Hired',
    data: { name: 'Aman Verma', email: 'aman@example.test' },
  });
  expect(candidate.status).toBe(201);
  const candidateId = candidate.body.data._id;
  const conversionBody = { designation: 'Developer', joiningDate: '2026-11-01', workLocation: 'Mumbai' };
  const converted = await write('post', `/candidates/${candidateId}/convert-to-employee`, adminToken, conversionBody);
  expect(converted.status).toBe(201);
  const repeated = await write('post', `/candidates/${candidateId}/convert-to-employee`, adminToken, conversionBody);
  expect(repeated.status).toBe(200);
  expect(String(repeated.body.data._id)).toBe(String(converted.body.data._id));
  expect(converted.body.data.status).toBe('Unassigned');
  expect(await User.exists({ email: 'aman@example.test' })).toBeNull();

  const riya = await User.findOne({ email: 'riya@example.test' });
  expect((await write('post', `/employees/${riya.id}/salary-assignments`, adminToken, {
    annualCTC: 600000,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    components: [{ name: 'PF', type: 'deduction', amount: 1800 }],
  })).status).toBe(201);
  const run = await write('post', '/payroll/runs', adminToken, { month: 10, year: 2026 });
  expect(run.status).toBe(201);
  const runId = run.body.data._id;
  const calculated = await write('post', `/payroll/runs/${runId}/calculate`, adminToken, {});
  expect(calculated.status).toBe(200);
  expect(calculated.body.data.data.employeeCount).toBeGreaterThan(0);
  const entries = await request(app).get(`/api/v1/hrms/payroll/runs/${runId}/entries`).auth(adminToken, { type: 'bearer' });
  expect(entries.body.data.items.length).toBeGreaterThan(0);
  expect((await write('post', `/payroll/runs/${runId}/approve`, adminToken, {})).status).toBe(409);

  await User.create({
    name: 'Payroll Checker', email: 'checker@example.test',
    passwordHash: await bcrypt.hash('CheckerPassword123', 12), role: 'admin',
  });
  const login = await request(app).post('/api/v1/auth/login').set('Origin', origin).send({ email: 'checker@example.test', password: 'CheckerPassword123' });
  const checkerToken = login.body.data.accessToken;
  expect((await write('post', `/payroll/runs/${runId}/approve`, checkerToken, {})).status).toBe(200);
  expect((await write('post', `/payroll/runs/${runId}/mark-paid`, checkerToken, { reference: 'PAY-2026-10' })).status).toBe(200);
  const payslip = await request(app).get(`/api/v1/hrms/payroll/payslips/${runId}/download`).auth(employeeToken, { type: 'bearer' });
  expect(payslip.status).toBe(200);
  expect(payslip.headers['content-type']).toContain('application/pdf');
  expect(payslip.headers['content-disposition']).toContain('.pdf');
});
