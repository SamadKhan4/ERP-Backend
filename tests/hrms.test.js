import { beforeAll, afterAll, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let database,
  app,
  User,
  EmployeeProfile,
  HRMSRecord,
  adminToken,
  employeeToken,
  uploadDirectory;
const origin = 'http://localhost:5173';
const adminCredentials = {
  email: 'hr-admin@example.test',
  password: 'StrongPassword123',
};

const write = (method, path, token, body) => {
  const agent = request(app);
  return agent[method](`/api/v1/hrms${path}`)
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send(body);
};

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

test('individual monitoring enforces roles and isolates employee records', async () => {
  const { issueSession } = await import('../src/services/tokenService.js');
  const passwordHash = await bcrypt.hash('MonitoringPass123', 4);
  const target = await User.create({
    name: 'Monitor Target',
    email: 'monitor-target@example.test',
    passwordHash,
    role: 'employee',
  });
  const other = await User.create({
    name: 'Other Target',
    email: 'monitor-other@example.test',
    passwordHash,
    role: 'employee',
  });
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  await HRMSRecord.create([
    {
      module: 'attendance',
      title: 'Target attendance',
      employee: target.id,
      status: 'Present',
      data: { date: today, checkIn: today, minutesWorked: 125 },
      createdBy: target.id,
    },
    {
      module: 'daily-reports',
      title: 'Private other report',
      employee: other.id,
      status: 'Submitted',
      data: { date: today, summary: 'Other employee confidential report' },
      createdBy: other.id,
    },
    {
      module: 'attendance',
      title: 'Deleted attendance',
      employee: target.id,
      status: 'Present',
      data: { date: today, minutesWorked: 999 },
      deletedAt: new Date(),
      createdBy: target.id,
    },
  ]);
  const path = `/api/v1/hrms/employees/${target.id}/monitoring`;
  expect((await request(app).get(path)).status).toBe(401);
  for (const role of [
    'super_admin',
    'admin',
    'manager',
    'hr',
    'team_leader',
    'employee',
    'executive',
    'customer',
    'lead_caller',
  ]) {
    const actor = await User.create({
      name: role,
      email: `monitor-${role}@example.test`,
      passwordHash,
      role,
      department: 'graphics',
    });
    const { accessToken } = await issueSession(actor);
    const response = await request(app)
      .get(path)
      .auth(accessToken, { type: 'bearer' });
    if (['super_admin', 'admin', 'manager', 'hr'].includes(role)) {
      expect(response.status).toBe(200);
      expect(response.body.data.summary.workedMinutes).toBe(125);
      expect(response.body.data.summary.missingReports).toBe(1);
      expect(response.body.data.attendance).toHaveLength(1);
      expect(response.body.data.reports).toHaveLength(0);
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
      expect(
        (
          await request(app)
            .get(`${path}?days=1000`)
            .auth(accessToken, { type: 'bearer' })
        ).status,
      ).toBe(400);
    } else expect(response.status).toBe(403);
  }
  await HRMSRecord.deleteMany({ employee: { $in: [target.id, other.id] } });
  await User.deleteMany({ email: /^monitor-/ });
});

test('employee lifecycle stores a separate profile and never returns password hashes', async () => {
  const onboarding = await write('post', '/onboarding', adminToken, {
    personal: {
      fullName: 'Riya Shah',
      email: 'riya@example.test',
      dateOfBirth: '1998-10-20',
      phone: '9876543210',
      gender: 'Female',
      bloodGroup: 'B+',
    },
    employment: {
      department: 'graphics',
      designation: 'Graphic Designer',
      employmentType: 'full_time',
      joiningDate: '2026-10-13',
      workLocation: 'Mumbai',
    },
    address: {
      current: 'Mumbai current address',
      permanent: 'Mumbai permanent address',
    },
    emergencyContact: {
      name: 'Raj Shah',
      phone: '9876543211',
      relationship: 'Father',
    },
    education: [
      { qualification: 'BFA', institute: 'Design Institute', year: 2020 },
    ],
    experience: [],
  });
  expect(onboarding.status).toBe(201);
  expect(onboarding.body.data.status).toBe('Unassigned');
  expect(await User.exists({ email: 'riya@example.test' })).toBeNull();
  const onboardingId = onboarding.body.data._id;
  expect(
    (
      await write(
        'post',
        `/onboarding/${onboardingId}/complete`,
        adminToken,
        {},
      )
    ).status,
  ).toBe(409);

  const created = await write(
    'post',
    `/employees/from-onboarding/${onboardingId}`,
    adminToken,
    { temporaryPassword: 'EmployeePass123' },
  );
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

  for (const type of [
    'identity_proof',
    'address_proof',
    'profile_photo',
    'education',
    'bank_proof',
  ]) {
    const uploaded = await request(app)
      .post('/api/v1/hrms/self/onboarding/documents')
      .set('Origin', origin)
      .auth(employeeToken, { type: 'bearer' })
      .field('type', type)
      .attach('file', Buffer.from('%PDF-1.4 onboarding test'), {
        filename: `${type}.pdf`,
        contentType: 'application/pdf',
      });
    expect(uploaded.status).toBe(201);
    expect(
      (
        await write(
          'patch',
          `/onboarding/${onboardingId}/documents/${uploaded.body.data._id}/verify`,
          adminToken,
          { status: 'Verified' },
        )
      ).status,
    ).toBe(200);
  }
  const ownOnboarding = await request(app)
    .get('/api/v1/hrms/self/onboarding')
    .auth(employeeToken, { type: 'bearer' });
  expect(ownOnboarding.status).toBe(200);
  expect(ownOnboarding.body.data.documents).toHaveLength(5);
  const completed = await write(
    'post',
    `/onboarding/${onboardingId}/complete`,
    adminToken,
    {},
  );
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
  expect(updated.body.data.profile.designation).toBe('Senior Graphic Designer');
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
  expect(directory.body.data.items.map((item) => item.role)).not.toContain(
    'super_admin',
  );
  expect(directory.body.data.items.map((item) => item.role)).not.toContain(
    'manager',
  );
  expect(directory.body.data.items.map((item) => item.role)).not.toContain(
    'hr',
  );
  expect(directory.body.data.items.map((item) => item.email)).not.toContain(
    hrUser.email,
  );
  expect(directory.body.data.items.map((item) => item.email)).not.toContain(
    otherHr.email,
  );
  expect(
    (
      await request(app)
        .get(`/api/v1/hrms/employees/${manager.id}`)
        .auth(hrToken, { type: 'bearer' })
    ).status,
  ).toBe(404);
  expect(
    (
      await write('patch', `/employees/${manager.id}`, hrToken, {
        name: 'Blocked update',
      })
    ).status,
  ).toBe(403);
  expect(
    (await write('delete', `/employees/${otherHr.id}`, hrToken)).status,
  ).toBe(403);
  const privileged = await write('post', '/employees', hrToken, {
    name: 'Unauthorized Manager',
    email: 'unauthorized-manager@example.test',
    temporaryPassword: 'EmployeePass123',
    role: 'manager',
  });
  expect(privileged.status).toBe(409);
  expect(
    await User.exists({ email: 'unauthorized-manager@example.test' }),
  ).toBeNull();

  const employee = await write('post', '/employees', hrToken, {
    name: 'Standard Employee',
    email: 'standard-employee@example.test',
    temporaryPassword: 'EmployeePass123',
  });
  expect(employee.status).toBe(409);
  expect(
    await User.exists({ email: 'standard-employee@example.test' }),
  ).toBeNull();
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

  const calendar = await request(app)
    .get('/api/v1/hrms/holidays/calendar-view?from=2026-11-01&to=2026-11-30')
    .auth(adminToken, { type: 'bearer' });
  expect(calendar.status).toBe(200);
  expect(calendar.body.data.items.map((item) => item.title)).toContain(
    'Diwali',
  );
  const duplicate = await write('post', '/holidays', adminToken, {
    title: 'Duplicate Diwali',
    status: 'Published',
    effectiveDate: '2026-11-08T00:00:00.000Z',
    data: { date: '2026-11-08T00:00:00.000Z', type: 'company' },
  });
  expect(duplicate.status).toBe(409);

  const reviewed = await write('patch', `/holidays/${id}/status`, adminToken, {
    status: 'Archived',
    note: 'Calendar updated',
  });
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
  const checkIn = await write(
    'post',
    '/attendance/check-in',
    employeeToken,
    {},
  );
  expect(checkIn.status).toBe(201);
  expect(
    (await write('post', '/attendance/check-in', employeeToken, {})).status,
  ).toBe(409);
  const blockedCheckout = await write(
    'post',
    '/attendance/check-out',
    employeeToken,
    {},
  );
  expect(blockedCheckout.status).toBe(409);
  expect(blockedCheckout.body.error.message).toMatch(/daily report/i);
  const report = await write('post', '/daily-reports', employeeToken, {
    summary:
      'Completed the employee dashboard workflow and verified attendance.',
    completedTasks: ['Employee dashboard workflow'],
    tomorrowPlan: 'Continue integration testing',
  });
  expect(report.status).toBe(201);
  const checkOut = await write(
    'post',
    '/attendance/check-out',
    employeeToken,
    {},
  );
  expect(checkOut.status).toBe(200);
  expect(checkOut.body.data.data.minutesWorked).toBeGreaterThanOrEqual(0);
  expect(['On Time', 'Late', 'Half Day']).toContain(
    checkOut.body.data.data.attendanceStatus,
  );
  const attendanceParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(checkOut.body.data.data.date));
  const attendancePart = (type) =>
    attendanceParts.find((item) => item.type === type).value;
  const attendanceDate = `${attendancePart('year')}-${attendancePart('month')}-${attendancePart('day')}`;
  const dailyAttendance = await request(app)
    .get(`/api/v1/hrms/attendance/daily?date=${attendanceDate}`)
    .auth(adminToken, { type: 'bearer' });
  expect(dailyAttendance.status).toBe(200);
  expect(dailyAttendance.body.data.items).toHaveLength(1);
  expect(dailyAttendance.body.data.items[0].employee.name).toBe('Riya Shah');
  const employeeDashboard = await request(app)
    .get('/api/v1/hrms/employee-dashboard')
    .auth(employeeToken, { type: 'bearer' });
  expect(employeeDashboard.status).toBe(200);
  expect(employeeDashboard.body.data.dailyReport.status).toBe('Submitted');
  expect(employeeDashboard.body.data.dailyReports).toHaveLength(1);
  expect(employeeDashboard.body.data.tasks.length).toBeGreaterThanOrEqual(3);
  expect(employeeDashboard.body.data.employee.profile.address.current).toBe(
    'Mumbai current address',
  );
  expect(employeeDashboard.body.data.assets).toEqual([]);
  expect(employeeDashboard.body.data.holidays).toEqual(expect.any(Array));

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
  expect(
    (
      await write(
        'patch',
        `/leaves/requests/${leaveId}/approve`,
        adminToken,
        {},
      )
    ).status,
  ).toBe(200);
  const balance = await request(app)
    .get('/api/v1/hrms/leaves/balance/me')
    .auth(employeeToken, { type: 'bearer' });
  expect(balance.body.data).toEqual(
    expect.arrayContaining([{ leaveType: 'annual', balance: 3 }]),
  );
  expect(
    (
      await write(
        'patch',
        `/leaves/requests/${leaveId}/cancel`,
        employeeToken,
        {},
      )
    ).status,
  ).toBe(200);
  const restored = await request(app)
    .get('/api/v1/hrms/leaves/balance/me')
    .auth(employeeToken, { type: 'bearer' });
  expect(restored.body.data).toEqual(
    expect.arrayContaining([{ leaveType: 'annual', balance: 5 }]),
  );

  const reviewRequest = await write('post', '/leaves/requests', employeeToken, {
    leaveType: 'casual',
    startDate: '2027-01-12T00:00:00.000Z',
    endDate: '2027-01-12T00:00:00.000Z',
    reason: 'Personal appointment',
  });
  const reviewId = reviewRequest.body.data._id;
  expect(
    (
      await write(
        'patch',
        `/leaves/requests/${reviewId}/reject`,
        adminToken,
        {},
      )
    ).status,
  ).toBe(400);
  const pending = await write(
    'patch',
    `/leaves/requests/${reviewId}/pending`,
    adminToken,
    { reason: 'Waiting for team schedule' },
  );
  expect(pending.body.data.status).toBe('Pending');
  expect(pending.body.data.data.reviewerNote).toBe('Waiting for team schedule');
  const rejected = await write(
    'patch',
    `/leaves/requests/${reviewId}/reject`,
    adminToken,
    { reason: 'Project delivery is scheduled on this date' },
  );
  expect(rejected.body.data.status).toBe('Rejected');
  expect(rejected.body.data.data.reviewerNote).toBe(
    'Project delivery is scheduled on this date',
  );

  const notifications = await request(app)
    .get('/api/v1/notifications')
    .auth(employeeToken, { type: 'bearer' });
  expect(notifications.status).toBe(200);
  expect(notifications.body.data.unreadCount).toBeGreaterThan(0);
  expect(notifications.body.data.items[0].message).toContain(
    'Project delivery is scheduled on this date',
  );
  const notificationId = notifications.body.data.items[0]._id;
  expect(
    (
      await request(app)
        .patch(`/api/v1/notifications/${notificationId}/read`)
        .set('Origin', origin)
        .auth(employeeToken, { type: 'bearer' })
    ).status,
  ).toBe(200);
});

test('attendance automation closes open punches and marks missed workdays on leave', async () => {
  const passwordHash = await bcrypt.hash('EmployeePass123', 12);
  const [missingEmployee, openEmployee] = await User.create([
    {
      name: 'Missing Employee',
      email: 'missing-attendance@example.test',
      passwordHash,
      role: 'employee',
      department: 'graphics',
    },
    {
      name: 'Open Attendance',
      email: 'open-attendance@example.test',
      passwordHash,
      role: 'employee',
      department: 'web_dev',
    },
  ]);
  await User.collection.updateMany(
    { _id: { $in: [missingEmployee._id, openEmployee._id] } },
    { $set: { createdAt: new Date('2020-01-01T00:00:00.000Z') } },
  );
  await HRMSRecord.create({
    module: 'attendance',
    title: 'Daily attendance',
    employee: openEmployee._id,
    department: openEmployee.department,
    status: 'Present',
    effectiveDate: new Date('2026-10-15T00:00:00+05:30'),
    data: {
      date: new Date('2026-10-15T00:00:00+05:30'),
      checkIn: new Date('2026-10-15T09:30:00+05:30'),
      attendanceStatus: 'On Time',
    },
    createdBy: openEmployee._id,
    updatedBy: openEmployee._id,
  });
  const { runAttendanceAutomation } =
    await import('../src/services/attendanceAutomationService.js');
  const now = new Date('2026-10-16T00:05:00+05:30');
  const result = await runAttendanceAutomation({ now });
  expect(result.autoCheckedOut).toBeGreaterThanOrEqual(1);
  expect(result.markedOnLeave).toBeGreaterThanOrEqual(1);

  const closed = await HRMSRecord.findOne({
    module: 'attendance',
    employee: openEmployee._id,
  });
  expect(closed.data.autoCheckedOut).toBe(true);
  expect(closed.data.checkOut.toISOString()).toBe('2026-10-15T18:29:59.000Z');
  const automaticLeave = await HRMSRecord.findOne({
    module: 'attendance',
    employee: missingEmployee._id,
    'data.date': new Date('2026-10-15T00:00:00+05:30'),
  });
  expect(automaticLeave.status).toBe('Leave');
  expect(automaticLeave.data.attendanceStatus).toBe('On Leave');
  expect(automaticLeave.data.automaticLeave).toBe(true);

  await runAttendanceAutomation({ now });
  expect(
    await HRMSRecord.countDocuments({
      module: 'attendance',
      employee: missingEmployee._id,
      'data.date': new Date('2026-10-15T00:00:00+05:30'),
    }),
  ).toBe(1);

  const sundayResult = await runAttendanceAutomation({
    now: new Date('2026-10-19T00:05:00+05:30'),
  });
  expect(sundayResult.skipped).toBe('sunday');
  expect(
    await HRMSRecord.exists({
      module: 'attendance',
      employee: missingEmployee._id,
      'data.date': new Date('2026-10-18T00:00:00+05:30'),
    }),
  ).toBeNull();

  const admin = await User.findOne({ email: adminCredentials.email });
  await HRMSRecord.create({
    module: 'holidays',
    title: 'Automation Holiday',
    status: 'Published',
    effectiveDate: new Date('2026-10-20T00:00:00+05:30'),
    data: { date: new Date('2026-10-20T00:00:00+05:30'), type: 'company' },
    createdBy: admin._id,
    updatedBy: admin._id,
  });
  const holidayResult = await runAttendanceAutomation({
    now: new Date('2026-10-21T00:05:00+05:30'),
  });
  expect(holidayResult.skipped).toBe('holiday');
  expect(
    await HRMSRecord.exists({
      module: 'attendance',
      employee: missingEmployee._id,
      'data.date': new Date('2026-10-20T00:00:00+05:30'),
    }),
  ).toBeNull();
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
  const conversionBody = {
    designation: 'Developer',
    joiningDate: '2026-11-01',
    workLocation: 'Mumbai',
  };
  const converted = await write(
    'post',
    `/candidates/${candidateId}/convert-to-employee`,
    adminToken,
    conversionBody,
  );
  expect(converted.status).toBe(201);
  const repeated = await write(
    'post',
    `/candidates/${candidateId}/convert-to-employee`,
    adminToken,
    conversionBody,
  );
  expect(repeated.status).toBe(200);
  expect(String(repeated.body.data._id)).toBe(String(converted.body.data._id));
  expect(converted.body.data.status).toBe('Unassigned');
  expect(await User.exists({ email: 'aman@example.test' })).toBeNull();

  const riya = await User.findOne({ email: 'riya@example.test' });
  const salaryLeave = await write('post', '/leaves/requests', employeeToken, {
    leaveType: 'unpaid',
    startDate: '2027-02-10T00:00:00.000Z',
    endDate: '2027-02-11T00:00:00.000Z',
    reason: 'Personal travel',
  });
  expect(
    (
      await write(
        'patch',
        `/leaves/requests/${salaryLeave.body.data._id}/approve`,
        adminToken,
        {},
      )
    ).status,
  ).toBe(200);
  const preview = await request(app)
    .get(
      `/api/v1/hrms/payroll/employee-calculation?employeeId=${riya.id}&month=2027-02&baseAmount=28000`,
    )
    .auth(adminToken, { type: 'bearer' });
  expect(preview.status).toBe(200);
  expect(preview.body.data.totalLeaveDays).toBe(2);
  expect(preview.body.data.perDayAmount).toBe(1000);
  expect(preview.body.data.professionalTax).toBe(200);
  expect(preview.body.data.autoPayableAmount).toBe(25800);
  const thresholdPreview = await request(app)
    .get(
      `/api/v1/hrms/payroll/employee-calculation?employeeId=${riya.id}&month=2027-02&baseAmount=10000`,
    )
    .auth(adminToken, { type: 'bearer' });
  expect(thresholdPreview.body.data.professionalTax).toBe(0);
  const manualPayslip = await write(
    'post',
    '/payroll/employee-payslips',
    adminToken,
    {
      employeeId: riya.id,
      month: '2027-02',
      baseAmount: 28000,
      payableAmount: 25500,
      manualOverride: true,
      note: 'Manual performance adjustment',
    },
  );
  expect(manualPayslip.status).toBe(201);
  expect(manualPayslip.body.data.entry.net).toBe(25500);
  expect(manualPayslip.body.data.entry.snapshot.professionalTax).toBe(200);
  expect(manualPayslip.body.data.entry.snapshot.manualAdjustment).toBe(-300);
  const manualRunId = manualPayslip.body.data.payrollRun._id;
  const manualDownload = await request(app)
    .get(`/api/v1/hrms/payroll/payslips/${manualRunId}/download`)
    .auth(employeeToken, { type: 'bearer' });
  expect(manualDownload.status).toBe(200);
  expect(manualDownload.headers['content-type']).toContain('application/pdf');
  expect(manualDownload.headers['content-disposition']).toMatch(/^attachment;/);
  expect(manualDownload.body.subarray(0, 4).toString()).toBe('%PDF');
  const manualPreview = await request(app)
    .get(
      `/api/v1/hrms/payroll/payslips/${manualRunId}/download?disposition=inline`,
    )
    .auth(employeeToken, { type: 'bearer' });
  expect(manualPreview.status).toBe(200);
  expect(manualPreview.headers['content-disposition']).toMatch(/^inline;/);
  const salaryDashboard = await request(app)
    .get('/api/v1/hrms/employee-dashboard')
    .auth(employeeToken, { type: 'bearer' });
  expect(salaryDashboard.body.data.payslips[0].payrollRun.data).toMatchObject({
    month: 2,
    year: 2027,
  });
  expect(salaryDashboard.body.data.payslips[0].entry.net).toBe(25500);

  const automaticTaxPayslip = await write(
    'post',
    '/payroll/employee-payslips',
    adminToken,
    {
      employeeId: riya.id,
      month: '2027-03',
      baseAmount: 20000,
      payableAmount: 20000,
      manualOverride: false,
    },
  );
  expect(automaticTaxPayslip.body.data.entry.net).toBe(19800);
  expect(automaticTaxPayslip.body.data.entry.snapshot.professionalTax).toBe(
    200,
  );
  expect(automaticTaxPayslip.body.data.entry.snapshot.manualAdjustment).toBe(0);

  expect(
    (
      await write(
        'post',
        `/employees/${riya.id}/salary-assignments`,
        adminToken,
        {
          annualCTC: 600000,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          components: [{ name: 'PF', type: 'deduction', amount: 1800 }],
        },
      )
    ).status,
  ).toBe(201);
  const run = await write('post', '/payroll/runs', adminToken, {
    month: 10,
    year: 2026,
  });
  expect(run.status).toBe(201);
  const runId = run.body.data._id;
  const calculated = await write(
    'post',
    `/payroll/runs/${runId}/calculate`,
    adminToken,
    {},
  );
  expect(calculated.status).toBe(200);
  expect(calculated.body.data.data.employeeCount).toBeGreaterThan(0);
  const entries = await request(app)
    .get(`/api/v1/hrms/payroll/runs/${runId}/entries`)
    .auth(adminToken, { type: 'bearer' });
  expect(entries.body.data.items.length).toBeGreaterThan(0);
  const riyaPayrollEntry = entries.body.data.items.find(
    (item) => String(item.employee?._id || item.employee) === String(riya.id),
  );
  expect(riyaPayrollEntry.snapshot.professionalTax).toBe(200);
  expect(riyaPayrollEntry.deductions).toBe(2000);
  expect(
    (await write('post', `/payroll/runs/${runId}/approve`, adminToken, {}))
      .status,
  ).toBe(409);

  await User.create({
    name: 'Payroll Checker',
    email: 'checker@example.test',
    passwordHash: await bcrypt.hash('CheckerPassword123', 12),
    role: 'admin',
  });
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ email: 'checker@example.test', password: 'CheckerPassword123' });
  const checkerToken = login.body.data.accessToken;
  expect(
    (await write('post', `/payroll/runs/${runId}/approve`, checkerToken, {}))
      .status,
  ).toBe(200);
  expect(
    (
      await write('post', `/payroll/runs/${runId}/mark-paid`, checkerToken, {
        reference: 'PAY-2026-10',
      })
    ).status,
  ).toBe(200);
  const payslip = await request(app)
    .get(`/api/v1/hrms/payroll/payslips/${runId}/download`)
    .auth(employeeToken, { type: 'bearer' });
  expect(payslip.status).toBe(200);
  expect(payslip.headers['content-type']).toContain('application/pdf');
  expect(payslip.headers['content-disposition']).toContain('.pdf');
});

test('employee directory summary covers the full filtered directory independently of pagination and status', async () => {
  await User.create([
    {
      name: 'Directory One',
      email: 'directory-one@test.example',
      role: 'employee',
      active: true,
      passwordHash: 'unused',
      department: 'web_dev',
    },
    {
      name: 'Directory Two',
      email: 'directory-two@test.example',
      role: 'employee',
      active: false,
      passwordHash: 'unused',
      department: 'web_dev',
    },
    {
      name: 'Directory Leader',
      email: 'directory-leader@test.example',
      role: 'team_leader',
      active: true,
      passwordHash: 'unused',
      department: 'web_dev',
    },
  ]);
  const result = await request(app)
    .get(
      '/api/v1/hrms/employees?search=Directory&department=web_dev&active=true&limit=1',
    )
    .auth(adminToken, { type: 'bearer' });
  expect(result.status).toBe(200);
  expect(result.body.data.items).toHaveLength(1);
  expect(result.body.data.pagination.total).toBe(2);
  expect(result.body.data.summary).toEqual({
    total: 3,
    active: 2,
    inactive: 1,
    teamLeaders: 1,
  });
  const inactive = await User.findOne({ email: 'directory-two@test.example' });
  expect(
    (
      await write('patch', `/employees/${inactive.id}`, adminToken, {
        active: true,
      })
    ).status,
  ).toBe(200);
  expect((await User.findById(inactive.id)).active).toBe(true);
});
