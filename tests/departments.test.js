import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
let database,
  app,
  User,
  Department,
  EmployeeProfile,
  HRMSRecord,
  AuditLog,
  employee,
  hod,
  tokens = {},
  deptA,
  deptB;
const origin = 'http://localhost:5173';
const call = (method, path, actor = 'admin', body) => {
  const agent = request(app);
  return agent[method](`/api/v1${path}`)
    .set('Origin', origin)
    .auth(tokens[actor] || 'invalid', { type: 'bearer' })
    .send(body);
};

beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: database.getUri(),
    CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 'd'.repeat(64),
    JWT_REFRESH_SECRET: 'e'.repeat(64),
    COOKIE_SECURE: 'false',
  });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  ({ Department } = await import('../src/models/Department.js'));
  ({ EmployeeProfile } = await import('../src/models/EmployeeProfile.js'));
  ({ HRMSRecord } = await import('../src/models/HRMSRecord.js'));
  ({ AuditLog } = await import('../src/models/AuditLog.js'));
  await mongoose.connect(database.getUri());
  await Promise.all(
    Object.values(mongoose.models).map((Model) => Model.init()),
  );
  const { issueSession } = await import('../src/services/tokenService.js');
  for (const [key, role] of Object.entries({
    admin: 'admin',
    hr: 'hr',
    manager: 'manager',
    employee: 'employee',
    hod: 'team_leader',
  })) {
    const user = await User.create({
      name: key,
      email: `${key}@departments.test`,
      passwordHash: 'unused',
      role,
      department: 'web_dev',
    });
    tokens[key] = (await issueSession(user)).accessToken;
    if (key === 'employee') employee = user;
    if (key === 'hod') hod = user;
  }
  await User.create({
    name: 'Other employee',
    email: 'other@departments.test',
    passwordHash: 'unused',
    role: 'employee',
    department: 'graphics',
  });
  await EmployeeProfile.create({
    user: employee._id,
    employeeCode: 'DEPT-EMP-1',
    department: 'web_dev',
    designation: 'Developer',
    employmentType: 'full_time',
    manager: hod._id,
  });
}, 120000);
afterAll(async () => {
  vi.restoreAllMocks();
  await mongoose.disconnect();
  await database?.stop();
});
test('dictionary compatibility and direct API role restrictions', async () => {
  expect((await request(app).get('/api/v1/departments')).status).toBe(401);
  const options = await call('get', '/departments', 'employee');
  expect(options.status).toBe(200);
  expect(options.body.data.map((row) => row.id)).toContain('web_dev');
  expect(options.body.data[0]).not.toHaveProperty('createdBy');
  expect((await call('get', '/departments?search=', 'employee')).status).toBe(
    403,
  );
  expect(
    (
      await call('post', '/departments', 'manager', {
        name: 'Blocked',
        code: 'BLOCK',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('post', '/departments', 'employee', {
        name: 'Blocked',
        code: 'BLOCK',
      })
    ).status,
  ).toBe(403);
  const list = await call('get', '/departments?search=Web', 'manager');
  expect(list.status).toBe(200);
  expect(list.body.data.items[0].employeeCount).toBeGreaterThan(0);
});
test('create generates unique IDs; validates names, codes, heads and cycles', async () => {
  const result = await call('post', '/departments', 'hr', {
    name: 'Product Engineering',
    code: 'PROD',
    departmentHead: hod.id,
    reportingManager: hod.id,
    location: 'Mumbai',
  });
  expect(result.status).toBe(201);
  deptA = result.body.data;
  expect(deptA.departmentId).toMatch(/^ADB\/DEPT\/\d{3,}$/);
  expect(
    (
      await call('post', '/departments', 'admin', {
        name: 'product engineering',
        code: 'OTHER',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('post', '/departments', 'admin', {
        name: 'Duplicate Code',
        code: 'prod',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('post', '/departments', 'admin', {
        name: 'Invalid Head',
        code: 'HEAD',
        departmentHead: new mongoose.Types.ObjectId().toString(),
      })
    ).status,
  ).toBe(400);
  expect(
    (await call('post', '/departments', 'admin', { name: '', code: '?' }))
      .status,
  ).toBe(400);
  const created = await call('post', '/departments', 'admin', {
    name: 'Design Studio',
    code: 'DS',
    parentDepartment: deptA._id,
  });
  expect(created.status).toBe(201);
  deptB = created.body.data;
  expect(
    (
      await call('patch', `/departments/${deptA._id}`, 'admin', {
        parentDepartment: deptA._id,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call('patch', `/departments/${deptA._id}`, 'admin', {
        parentDepartment: deptB._id,
      })
    ).status,
  ).toBe(400);
  const edited = await call('patch', `/departments/${deptB._id}`, 'hr', {
    description: 'Dynamic department',
    departmentHead: hod.id,
  });
  expect(edited.status).toBe(200);
  expect(
    await AuditLog.exists({
      entityId: deptB._id,
      action: 'DEPARTMENT_HEAD_CHANGED',
    }),
  ).toBeTruthy();
});
test('concurrent creates do not collide in department numbering', async () => {
  const responses = await Promise.all(
    [0, 1, 2].map((index) =>
      call('post', '/departments', 'admin', {
        name: `Concurrent ${index}`,
        code: `CON${index}`,
      }),
    ),
  );
  expect(responses.map((row) => row.status)).toEqual([201, 201, 201]);
  expect(new Set(responses.map((row) => row.body.data.departmentId)).size).toBe(
    3,
  );
});
test('assign/transfer updates one employee and profile, records history and blocks reporting cycles', async () => {
  const total = await User.countDocuments();
  const assigned = await call(
    'post',
    `/departments/${deptA._id}/employees`,
    'hr',
    { employee: employee.id, designation: 'Senior Developer', manager: hod.id },
  );
  expect(assigned.status).toBe(200);
  expect(await User.countDocuments()).toBe(total);
  expect(String((await User.findById(employee.id)).departmentId)).toBe(
    deptA._id,
  );
  expect((await User.findById(employee.id)).department).toBe(deptA.key);
  expect(
    String(
      (await EmployeeProfile.findOne({ user: employee._id })).departmentId,
    ),
  ).toBe(deptA._id);
  expect(
    await AuditLog.exists({
      entityId: deptA._id,
      action: 'EMPLOYEE_TRANSFERRED',
    }),
  ).toBeTruthy();
  expect(
    (
      await call('post', `/departments/${deptA._id}/employees`, 'hr', {
        employee: employee.id,
        designation: 'Developer',
        manager: employee.id,
      })
    ).status,
  ).toBe(400);
  const transferred = await call(
    'patch',
    `/employees/${employee.id}/department`,
    'admin',
    { department: deptB._id, designation: 'Designer', manager: hod.id },
  );
  expect(transferred.status).toBe(200);
  const listing = await call(
    'get',
    `/departments/${deptB._id}/employees?search=employee&active=true&limit=1`,
    'manager',
  );
  expect(listing.status).toBe(200);
  expect(listing.body.data.items).toHaveLength(1);
  expect(listing.body.data.items[0].profile.employeeCode).toBe('DEPT-EMP-1');
  expect(JSON.stringify(listing.body)).not.toContain('passwordHash');
  expect(
    await AuditLog.exists({ entityId: deptA._id, action: 'EMPLOYEE_REMOVED' }),
  ).toBeTruthy();
  expect(
    (
      await call('post', `/departments/${deptA._id}/employees`, 'manager', {
        employee: employee.id,
        designation: 'Developer',
      })
    ).status,
  ).toBe(403);
  const admin = await User.findOne({ role: 'admin' });
  expect(
    (
      await call('post', `/departments/${deptA._id}/employees`, 'hr', {
        employee: admin.id,
        designation: 'Admin',
      })
    ).status,
  ).toBe(403);
});
test('inactive departments retain history and reject assignment across direct and legacy employee APIs', async () => {
  expect(
    (
      await call('patch', `/departments/${deptA._id}/status`, 'hr', {
        status: 'INACTIVE',
      })
    ).status,
  ).toBe(200);
  const before = await User.findById(employee.id);
  expect(
    (
      await call('post', `/departments/${deptA._id}/employees`, 'hr', {
        employee: employee.id,
        designation: 'Developer',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('patch', `/hrms/employees/${employee.id}`, 'admin', {
        department: deptA.key,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('post', '/hrms/employees', 'admin', {
        name: 'Inactive Assign',
        email: 'inactive@departments.test',
        temporaryPassword: 'VeryStrongPassword123',
        department: deptA.key,
      })
    ).status,
  ).toBe(409);
  expect((await User.findById(employee.id)).department).toBe(before.department);
  expect(
    (await call('delete', `/departments/${deptA._id}`, 'admin')).status,
  ).toBe(409);
  expect((await call('delete', `/departments/${deptB._id}`, 'hr')).status).toBe(
    403,
  );
});
test('analytics derive unique attendance, approved leave, WFH and project/task memberships', async () => {
  const today = new Date(
    `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())}T00:00:00+05:30`,
  );
  const dept = await Department.findOne({ key: 'web_dev' });
  const admin = await User.findOne({ role: 'admin' });
  for (const employeeId of [admin._id, admin._id])
    await HRMSRecord.create({
      module: 'attendance',
      title: 'Attendance',
      employee: employeeId,
      status: 'Present',
      department: 'web_dev',
      data: { date: today, checkIn: today, attendanceStatus: 'Late' },
      createdBy: admin._id,
    });
  await HRMSRecord.create({
    module: 'leave',
    title: 'WFH',
    employee: hod._id,
    status: 'Approved',
    department: 'web_dev',
    data: { startDate: today, endDate: today, leaveType: 'work_from_home' },
    createdBy: admin._id,
  });
  const { Project } = await import('../src/models/Project.js');
  await Project.collection.insertOne({
    projectId: 'DEPT-PROJECT',
    title: 'Department project',
    assignedTo: admin._id,
    status: 'Active',
  });
  const { TeamTask } = await import('../src/models/TeamWork.js');
  await TeamTask.collection.insertOne({
    taskId: 'DEPT-TASK',
    title: 'Scoped task',
    assignedTo: admin._id,
    status: 'TODO',
    deletedAt: null,
  });
  const result = await call(
    'get',
    `/departments/${dept.id}/summary`,
    'manager',
  );
  expect(result.status).toBe(200);
  expect(result.body.data).toMatchObject({
    present: 1,
    late: 1,
    wfh: 1,
    projects: { Active: 1 },
    tasks: { TODO: 1 },
  });
  const projects = await call(
    'get',
    `/departments/${dept.id}/projects`,
    'manager',
  );
  expect(projects.body.data.items[0].title).toBe('Department project');
  expect(projects.body.data.items[0]).not.toHaveProperty('amount');
  expect(
    (await call('get', `/departments/${dept.id}/summary`, 'employee')).status,
  ).toBe(403);
  const attendance = await call(
    'get',
    `/hrms/attendance/daily?date=${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(today)}&department=web_dev`,
    'admin',
  );
  expect(attendance.status).toBe(200);
});
test('empty department can be deleted, dependent/historical departments cannot', async () => {
  const created = await call('post', '/departments', 'admin', {
    name: 'Empty Department',
    code: 'EMPTY',
  });
  expect(created.status).toBe(201);
  expect(
    (await call('delete', `/departments/${created.body.data._id}`, 'admin'))
      .status,
  ).toBe(200);
  expect(await Department.findById(created.body.data._id)).toBeNull();
  expect(
    (await call('get', `/departments/${deptA._id}/activity`, 'manager')).body
      .data.items.length,
  ).toBeGreaterThan(0);
});
test('transfer rollback preserves employee/profile/history on database failure', async () => {
  const original = await User.findById(employee.id);
  const count = await AuditLog.countDocuments();
  const spy = vi
    .spyOn(HRMSRecord, 'create')
    .mockRejectedValueOnce(new Error('Injected failure'));
  const result = await call(
    'post',
    `/departments/${deptB._id}/employees`,
    'admin',
    { employee: employee.id, designation: 'Should rollback', manager: hod.id },
  );
  spy.mockRestore();
  expect(result.status).toBe(500);
  expect((await User.findById(employee.id)).department).toBe(
    original.department,
  );
  expect(
    (await EmployeeProfile.findOne({ user: employee._id })).designation,
  ).toBe('Designer');
  expect(await AuditLog.countDocuments()).toBe(count);
});

test('dynamic departments support ordinary onboarding employee creation and designation lookup', async () => {
  const response = await call('post', '/hrms/onboarding', 'admin', {
    personal: {
      fullName: 'New Dynamic Employee',
      email: 'dynamic-new@departments.test',
      dateOfBirth: '1998-01-01',
      phone: '9876543210',
    },
    employment: {
      department: deptB.key,
      designation: 'Product Designer',
      employmentType: 'full_time',
      joiningDate: '2026-10-01',
      workLocation: 'Mumbai',
    },
    address: {
      current: 'Mumbai current address',
      permanent: 'Mumbai permanent address',
    },
    emergencyContact: {
      name: 'Contact',
      phone: '9876543210',
      relationship: 'Parent',
    },
    education: [],
    experience: [],
  });
  expect(response.status).toBe(201);
  const create = await call(
    'post',
    `/hrms/employees/from-onboarding/${response.body.data._id}`,
    'admin',
    { temporaryPassword: 'VeryStrongPassword123', role: 'employee' },
  );
  expect(create.status).toBe(201);
  const created = await User.findById(create.body.data.employee._id);
  expect(String(created.departmentId)).toBe(deptB._id);
  expect(created.department).toBe(deptB.key);
  await HRMSRecord.create({
    module: 'designations',
    title: 'Product Designer',
    department: deptB.key,
    status: 'Active',
    data: { level: 'employee' },
    createdBy: created._id,
  });
  const designations = await call(
    'get',
    `/departments/${deptB._id}/designations`,
    'manager',
  );
  expect(designations.body.data.items.map((row) => row.title)).toContain(
    'Product Designer',
  );
  expect(
    (await call('get', '/hrms/departments?search=Design', 'manager')).body.data
      .items[0]._id,
  ).toBe(deptB._id);
});
test('existing inactive onboarding cannot produce a new login and custom role grants remain server-enforced', async () => {
  const admin = await User.findOne({ role: 'admin' });
  const record = await HRMSRecord.create({
    module: 'onboarding',
    title: 'Inactive Department Employee',
    department: deptA.key,
    status: 'Unassigned',
    data: {
      personal: {
        fullName: 'Inactive Department Employee',
        email: 'blocked-login@departments.test',
      },
      employment: { department: deptA.key, designation: 'Engineer' },
    },
    createdBy: admin._id,
  });
  const response = await call(
    'post',
    `/hrms/employees/from-onboarding/${record.id}`,
    'admin',
    { temporaryPassword: 'VeryStrongPassword123', role: 'employee' },
  );
  expect(response.status).toBe(409);
  expect(
    await User.exists({ email: 'blocked-login@departments.test' }),
  ).toBeNull();
  const { Role } = await import('../src/models/Role.js');
  await Role.updateOne(
    { name: 'manager' },
    { $set: { label: 'Manager', permissions: ['departments.edit'] } },
    { upsert: true },
  );
  expect(
    (
      await call('patch', `/departments/${deptB._id}`, 'manager', {
        description: 'Allowed by stored grant',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('patch', `/departments/${deptB._id}`, 'manager', {
        departmentHead: employee.id,
      })
    ).status,
  ).toBe(403);
});
test('migration backfills custom legacy keys and can be repeated without duplicate masters', async () => {
  const id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: id,
    name: 'Legacy Employee',
    email: 'legacy@departments.test',
    role: 'employee',
    active: true,
    department: 'legacy_support',
    passwordHash: 'unused',
  });
  const { migrateDepartmentReferences } =
    await import('../src/services/departmentMasterService.js');
  await migrateDepartmentReferences();
  await migrateDepartmentReferences();
  const master = await Department.findOne({ key: 'legacy_support' });
  expect(master).toBeTruthy();
  expect(await Department.countDocuments({ key: 'legacy_support' })).toBe(1);
  expect(String((await User.findById(id)).departmentId)).toBe(master.id);
});

test('BDE master is added to existing installations once and supports executive membership', async () => {
  const { Counter } = await import('../src/models/Counter.js');
  await Department.deleteOne({ key: 'bde' });
  await Counter.deleteOne({ _id: 'department-bde-initialized' });
  const { ensureDepartmentMasters } = await import('../src/services/departmentMasterService.js');
  await ensureDepartmentMasters();
  await ensureDepartmentMasters();
  const bde = await Department.findOne({ key: 'bde' });
  expect(bde.code).toBe('BDE');
  expect(await Department.countDocuments({ key: 'bde' })).toBe(1);
  const executive = await User.create({ name: 'BDE Executive', email: 'bde@departments.test', role: 'executive', department: 'bde', passwordHash: 'unused' });
  expect(String(executive.departmentId)).toBe(bde.id);
});
