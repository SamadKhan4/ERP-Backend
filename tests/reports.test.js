import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
const { sendMail } = vi.hoisted(() => ({
  sendMail: vi.fn().mockResolvedValue({ accepted: ['test@example.test'] }),
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));
let database,
  app,
  User,
  Role,
  EmployeeProfile,
  registry,
  users = {},
  tokens = {},
  employeeTask,
  otherTask;
const origin = 'http://localhost:5173';
const call = (method, path, actor = 'super_admin', body) => {
  const agent = request(app);
  return agent[method](`/api/v1/reports${path}`)
    .set('Origin', origin)
    .auth(tokens[actor], { type: 'bearer' })
    .send(body);
};
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: database.getUri(),
    CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 'r'.repeat(64),
    JWT_REFRESH_SECRET: 's'.repeat(64),
    COOKIE_SECURE: 'false',
    MAIL_DELIVERY: 'smtp',
    SMTP_HOST: 'smtp.test',
    SMTP_USER: 'sender@test.example',
    SMTP_PASS: 'not-real',
    MAIL_FROM: 'sender@test.example',
  });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  ({ Role } = await import('../src/models/Role.js'));
  ({ EmployeeProfile } = await import('../src/models/EmployeeProfile.js'));
  ({ reportRegistry: registry } =
    await import('../src/reports/reportRegistry.js'));
  await mongoose.connect(database.getUri());
  await Promise.all(
    Object.values(mongoose.models).map((Model) => Model.init()),
  );
  const { issueSession } = await import('../src/services/tokenService.js');
  for (const [key, role] of Object.entries({
    super_admin: 'super_admin',
    admin: 'admin',
    hr: 'hr',
    manager: 'manager',
    team_leader: 'team_leader',
    employee: 'employee',
    other: 'employee',
    sales: 'executive',
    finance: 'customer',
    project_manager: 'customer',
    head: 'customer',
    viewer: 'customer',
  })) {
    users[key] = await User.create({
      name: key,
      email: `${key}@reports.test`,
      role,
      department: key === 'other' ? 'seo' : 'web_dev',
      passwordHash: 'unused',
    });
    tokens[key] = (await issueSession(users[key])).accessToken;
  }
  await EmployeeProfile.create({
    user: users.employee._id,
    employeeCode: 'REP001',
    department: 'web_dev',
    designation: 'Developer',
    manager: users.manager._id,
    joiningDate: new Date('2026-01-01'),
  });
  const Task = mongoose.model('TeamTask');
  employeeTask = await Task.create({
    taskId: 'REP-T1',
    leader: users.team_leader._id,
    title: '=OWN task',
    assignedTo: users.employee._id,
    status: 'DONE',
  });
  otherTask = await Task.create({
    taskId: 'REP-T2',
    leader: users.other._id,
    title: 'Other department task',
    assignedTo: users.other._id,
    status: 'BLOCKED',
  });
  await mongoose.model('HRMSRecord').create([
    {
      module: 'attendance',
      title: 'Own attendance',
      employee: users.employee._id,
      department: 'web_dev',
      status: 'Present',
      effectiveDate: new Date('2026-10-17T04:00:00Z'),
      data: { date: '2026-10-17', minutesWorked: 480 },
      createdBy: users.admin._id,
    },
    {
      module: 'attendance',
      title: 'Other attendance',
      employee: users.other._id,
      department: 'seo',
      status: 'Late',
      effectiveDate: new Date('2026-10-17T04:00:00Z'),
      data: { date: '2026-10-17', minutesWorked: 420 },
      createdBy: users.admin._id,
    },
  ]);
  await mongoose.model('Lead').create([
    {
      leadId: 'REP-L1',
      companyName: 'Own CRM',
      companyKey: 'own crm',
      leadSource: 'Website',
      assignedTo: users.sales._id,
      createdBy: users.sales._id,
      estimatedBudget: 100,
      stage: 'NEW',
    },
    {
      leadId: 'REP-L2',
      companyName: 'Other CRM',
      companyKey: 'other crm',
      leadSource: 'Website',
      assignedTo: users.other._id,
      createdBy: users.admin._id,
      estimatedBudget: 200,
      stage: 'WON',
    },
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
test('every supported report executes; unavailable sources are explicit and never fabricated', async () => {
  for (const report of registry) {
    const result = await call('get', `/${report.key}`);
    expect(result.status, `${report.key}: ${JSON.stringify(result.body)}`).toBe(
      200,
    );
    expect(result.body.data.rows).toBeInstanceOf(Array);
    if (report.unavailable) expect(result.body.data.unavailable).toBeTruthy();
  }
}, 60000);
test('employee filters and exports cannot broaden own data or expose payroll/auth secrets', async () => {
  const own = await call('get', '/task_summary', 'employee');
  expect(own.body.data.scope).toBe('OWN');
  expect(own.body.data.rows.map((row) => row.taskId)).toEqual([
    employeeTask.taskId,
  ]);
  const attempted = await call(
    'get',
    `/task_summary?employee=${users.other.id}`,
    'employee',
  );
  expect(attempted.body.data.rows).toHaveLength(0);
  expect((await call('get', '/payroll_summary', 'employee')).status).toBe(403);
  expect((await call('get', '/invoice_register', 'hr')).status).toBe(403);
  expect((await call('get', '/user_list', 'employee')).status).toBe(403);
  const exported = await call('post', '/task_summary/export', 'employee', {
    format: 'csv',
    filters: {},
  });
  expect(exported.status).toBe(200);
  expect(exported.text).toContain("'=OWN task");
  expect(exported.text).not.toContain(otherTask.title);
  const forged = await call('post', '/task_summary/export', 'employee', {
    format: 'csv',
    columns: ['passwordHash'],
    filters: {},
  });
  expect(forged.status).toBe(400);
  expect(
    (await call('get', '/task_summary?scope=ALL', 'employee')).status,
  ).toBe(400);
  expect(
    (await call('get', '/task_summary?sort=passwordHash', 'employee')).status,
  ).toBe(400);
});
test('manager/team and executive CRM are constrained to hierarchy and ownership', async () => {
  const team = await call('get', '/task_summary', 'manager');
  expect(team.body.data.rows).toHaveLength(1);
  const sales = await call('get', '/total_leads', 'sales');
  expect(sales.body.data.rows.map((row) => row.companyName)).toEqual([
    'Own CRM',
  ]);
  const wrong = await call(
    'get',
    `/total_leads?employee=${users.other.id}`,
    'sales',
  );
  expect(wrong.body.data.rows).toHaveLength(0);
  const catalog = await call('get', '/', 'employee');
  expect(
    catalog.body.data.categories.map((category) => category.key).sort(),
  ).toEqual(['hr', 'projects']);
  expect(JSON.stringify(catalog.body)).not.toContain('payroll_summary');
  const privateFields = await call('get', '/employee_master', 'hr');
  expect(JSON.stringify(privateFields.body)).not.toMatch(
    /passwordHash|resetHash|salaryAssignment|emergencyContact/,
  );
});
test('configurable finance/project/department/viewer grants enforce independent boundaries', async () => {
  const permissions = [
    'reports.view',
    'reports.generate',
    'reports.export',
    'reports.finance.export',
    'reports.finance.view',
    'reports.finance.invoices',
    'reports.finance.all',
  ];
  await Role.create({
    name: 'customer',
    label: 'Custom Finance',
    reportPermissions: permissions,
  });
  expect((await call('get', '/invoice_register', 'finance')).status).toBe(200);
  expect((await call('get', '/payroll_summary', 'finance')).status).toBe(403);
  await Role.updateOne(
    { name: 'customer' },
    {
      reportPermissions: [
        'reports.view',
        'reports.projects.view',
        'reports.projects.assigned',
      ],
    },
  );
  const p1 = new mongoose.Types.ObjectId(),
    p2 = new mongoose.Types.ObjectId();
  await mongoose.model('Project').collection.insertMany([
    {
      _id: p1,
      projectId: 'REP-P1',
      title: 'Assigned project',
      assignedTo: users.project_manager._id,
      status: 'Active',
      createdAt: new Date(),
    },
    {
      _id: p2,
      projectId: 'REP-P2',
      title: 'Unrelated project',
      assignedTo: users.other._id,
      status: 'Active',
      createdAt: new Date(),
    },
  ]);
  const assigned = await call('get', '/project_list', 'project_manager');
  expect(assigned.body.data.rows.map((row) => row.projectId)).toEqual([
    'REP-P1',
  ]);
  await Role.updateOne(
    { name: 'customer' },
    {
      reportPermissions: [
        'reports.view',
        'reports.departments.view',
        'reports.departments.department',
        'reports.hr.attendance',
      ],
    },
  );
  const head = await call('get', '/department_attendance', 'head');
  expect(head.body.data.rows.every((row) => row.label === 'web_dev')).toBe(
    true,
  );
  const wrongDepartment = await call(
    'get',
    '/department_attendance?department=seo',
    'head',
  );
  expect(wrongDepartment.body.data.rows).toHaveLength(0);
  await Role.updateOne(
    { name: 'customer' },
    { reportPermissions: ['reports.view', 'reports.projects.view'] },
  );
  expect(
    (await call('post', '/task_summary/export', 'viewer', { format: 'csv' }))
      .status,
  ).toBe(403);
});
test('saved views store configuration; private scope and ownership survive sharing', async () => {
  const saved = await call('post', '/saved', 'employee', {
    name: 'My task view',
    reportKey: 'task_summary',
    columns: ['taskId', 'title'],
    filters: {},
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.data.scope).toBe('OWN');
  expect((await call('get', '/saved', 'other')).body.data).toHaveLength(0);
  expect(
    (await call('delete', `/saved/${saved.body.data._id}`, 'other')).status,
  ).toBe(404);
  expect(
    (
      await call('post', '/saved', 'employee', {
        name: 'Global view',
        reportKey: 'task_summary',
        columns: ['title'],
        visibility: 'GLOBAL',
      })
    ).status,
  ).toBe(403);
});
test('exports support XLSX/PDF, record real generations, and reject unsupported sources', async () => {
  for (const format of ['xlsx', 'pdf']) {
    const result = await call('post', '/task_summary/export', 'super_admin', {
      format,
      filters: {},
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-disposition']).toContain(`.${format}`);
  }
  expect(
    (await call('post', '/profitability/export', 'super_admin', {})).status,
  ).toBe(409);
  const recent = await call('get', '/recent');
  expect(recent.body.data.length).toBeGreaterThan(0);
  const raw = await call('get', '/user_list?search[$ne]=x');
  expect(raw.status).toBe(400);
});
test('schedules deliver real scoped files and recheck revoked permissions', async () => {
  const body = {
    name: 'My tasks daily',
    reportKey: 'task_summary',
    format: 'csv',
    frequency: 'DAILY',
    filters: {},
    recipients: [users.employee.email],
  };
  expect(
    (
      await call('post', '/scheduled', 'employee', {
        ...body,
        recipients: [users.other.email],
      })
    ).status,
  ).toBe(403);
  const created = await call('post', '/scheduled', 'employee', body);
  expect(created.status).toBe(200);
  const Schedule = mongoose.model('ScheduledReport');
  await Schedule.updateOne(
    { _id: created.body.data._id },
    { nextRunAt: new Date(0) },
  );
  const { processReportSchedules } =
    await import('../src/reports/reportScheduleService.js');
  await processReportSchedules();
  const mail = sendMail.mock.calls.at(-1)[0];
  expect(mail.to).toBe(users.employee.email);
  expect(mail.attachments[0].content.toString()).not.toContain(otherTask.title);
  await Role.create({
    name: 'employee',
    label: 'Employee override',
    reportPermissions: [],
  });
  await Schedule.updateOne(
    { _id: created.body.data._id },
    { nextRunAt: new Date(0) },
  );
  const calls = sendMail.mock.calls.length;
  await processReportSchedules();
  expect(sendMail.mock.calls.length).toBe(calls);
  expect((await Schedule.findById(created.body.data._id)).status).toBe(
    'PAUSED',
  );
  await Role.deleteOne({ name: 'employee' });
});
test('only permitted administrators change report access; Super Admin remains immutable', async () => {
  expect((await call('get', '/access', 'employee')).status).toBe(403);
  expect(
    (
      await call('patch', '/access/super_admin', 'super_admin', {
        permissions: [],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call('patch', '/access/hr', 'super_admin', {
        permissions: [
          'reports.view',
          'reports.hr.view',
          'reports.hr.attendance',
        ],
      })
    ).status,
  ).toBe(200);
  expect((await call('get', '/employee_master', 'hr')).status).toBe(403);
  expect((await call('get', '/employee_attendance', 'hr')).status).toBe(200);
});
test('finance separates billing/paid values, excludes drafts and payroll remains separately protected', async () => {
  const collection = mongoose.model('Invoice').collection;
  const base = {
    createdBy: users.admin._id,
    updatedBy: users.admin._id,
    invoiceDate: new Date('2026-10-17T05:00:00Z'),
    dueDate: new Date('2026-09-01T00:00:00Z'),
    client: { company: 'Report Client' },
    deletedAt: null,
    createdAt: new Date(),
  };
  await collection.insertMany([
    {
      ...base,
      invoiceNumber: 'REP-I1',
      status: 'Sent',
      grandTotal: 100,
      subtotal: 90,
      gstAmount: 10,
    },
    {
      ...base,
      invoiceNumber: 'REP-I2',
      status: 'Paid',
      grandTotal: 200,
      subtotal: 180,
      gstAmount: 20,
    },
    {
      ...base,
      invoiceNumber: 'REP-I3',
      status: 'Draft',
      grandTotal: 999,
      subtotal: 900,
      gstAmount: 99,
    },
    {
      ...base,
      invoiceNumber: 'REP-I4',
      status: 'Cancelled',
      grandTotal: 888,
      subtotal: 800,
      gstAmount: 88,
    },
  ]);
  const billed = await call(
    'get',
    '/billed_revenue?from=2026-10-17&to=2026-10-17',
  );
  expect(billed.body.data.rows[0].amount).toBe(300);
  const paid = await call('get', '/collected_revenue');
  expect(paid.body.data.rows[0].amount).toBe(200);
  const outstanding = await call('get', '/outstanding_aging');
  expect(outstanding.body.data.rows.map((row) => row.outstanding)).toEqual([
    100,
  ]);
  const run = await mongoose.model('HRMSRecord').create({
    module: 'payroll-runs',
    title: 'Report payroll',
    status: 'Approved',
    effectiveDate: new Date('2026-10-01'),
    data: { month: 10, year: 2026 },
    createdBy: users.admin._id,
  });
  await mongoose.model('PayrollEntry').create({
    run: run._id,
    employee: users.employee._id,
    employeeName: users.employee.name,
    department: 'web_dev',
    gross: 30000,
    deductions: 1000,
    net: 29000,
  });
  expect((await call('get', '/payroll_summary')).body.data.rows[0].net).toBe(
    29000,
  );
  expect(
    (await call('get', '/employee_master')).body.data.rows.every(
      (row) => !Object.hasOwn(row, 'net') && !Object.hasOwn(row, 'gross'),
    ),
  ).toBe(true);
  expect((await call('get', '/payroll_summary', 'employee')).status).toBe(403);
});
test('library pagination and category/search filters execute on the server without changing access counts', async () => {
  const first = await call('get', '/?status=available&limit=12&page=1');
  expect(first.body.data.items).toHaveLength(12);
  expect(first.body.data.pagination.total).toBe(
    registry.filter((report) => !report.unavailable).length,
  );
  const second = await call('get', '/?status=available&limit=12&page=2');
  expect(second.body.data.items[0].key).not.toBe(first.body.data.items[0].key);
  const searched = await call(
    'get',
    '/?category=projects&search=task&sort=name&status=available',
  );
  expect(
    searched.body.data.items.every(
      (report) =>
        report.category === 'projects' &&
        `${report.title} ${report.description}`.toLowerCase().includes('task'),
    ),
  ).toBe(true);
  const own = await call('get', '/?limit=200', 'employee');
  expect(
    own.body.data.libraryCategories.map((category) => category.key).sort(),
  ).toEqual(['hr', 'projects']);
  expect((await call('get', '/?limit=9999')).status).toBe(400);
});
test('Super Admin can manage another user’s saved/scheduled settings without changing ownership', async () => {
  const view = await call('post', '/saved', 'employee', {
    name: 'Employee settings',
    reportKey: 'task_summary',
    columns: ['title'],
    filters: {},
  });
  const changed = await call(
    'patch',
    `/saved/${view.body.data._id}`,
    'super_admin',
    {
      name: 'Reviewed settings',
      reportKey: 'task_summary',
      columns: ['title'],
      filters: {},
    },
  );
  expect(changed.status).toBe(200);
  expect(changed.body.data.owner).toBe(users.employee.id);
  const created = await call('post', '/scheduled', 'employee', {
    name: 'Employee schedule',
    reportKey: 'task_summary',
    format: 'csv',
    frequency: 'DAILY',
    filters: {},
    recipients: [users.employee.email],
  });
  const paused = await call(
    'patch',
    `/scheduled/${created.body.data._id}`,
    'super_admin',
    {
      name: 'Paused by Super Admin',
      reportKey: 'task_summary',
      format: 'csv',
      frequency: 'DAILY',
      status: 'PAUSED',
      filters: {},
      recipients: [users.employee.email],
    },
  );
  expect(paused.status).toBe(200);
  expect(paused.body.data.createdBy).toBe(users.employee.id);
  expect(paused.body.data.recipients).toEqual([users.employee.email]);
});
