import { beforeAll, afterAll, test, expect } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
let db,
  app,
  users = {},
  tokens = {},
  department,
  client,
  project,
  task,
  milestone;
const origin = 'http://localhost:5173';
const call = (method, path, actor = 'admin', body) => {
  const agent = request(app);
  return agent[method](`/api/v1/projects${path}`)
    .set('Origin', origin)
    .auth(tokens[actor], { type: 'bearer' })
    .send(body);
};
beforeAll(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: db.getUri(),
    CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 'p'.repeat(64),
    JWT_REFRESH_SECRET: 'q'.repeat(64),
    COOKIE_SECURE: 'false',
    MAIL_DELIVERY: 'disabled',
    STORAGE_DRIVER: 'local',
  });
  ({ app } = await import('../src/app.js'));
  await mongoose.connect(db.getUri());
  await Promise.all(Object.values(mongoose.models).map((M) => M.init()));
  const { issueSession } = await import('../src/services/tokenService.js');
  for (const role of [
    'super_admin',
    'admin',
    'manager',
    'hr',
    'employee',
    'executive',
    'team_leader',
  ]) {
    users[role] = await mongoose.model('User').create({
      name: role,
      email: `${role}@projects.test`,
      role,
      passwordHash: 'unused',
      ...(role === 'team_leader' ? { department: 'web_dev' } : {}),
    });
    tokens[role] = (await issueSession(users[role])).accessToken;
  }
  department = await mongoose.model('Department').create({
    departmentId: 'PRJDEP1',
    key: 'project-test',
    name: 'Project test',
    nameKey: 'project test',
    code: 'PRJT',
    status: 'ACTIVE',
    departmentHead: users.hr._id,
  });
  await mongoose.model('EmployeeProfile').create({
    user: users.employee._id,
    employeeCode: 'PRJEMP1',
    departmentId: department._id,
  });
  client = await mongoose.model('Client').create({
    clientId: 'PRJC1',
    companyName: 'Project Client',
    contactPerson: 'Test',
    leadSource: 'Website',
    originatingLead: new mongoose.Types.ObjectId(),
    createdBy: users.admin._id,
  });
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  await db?.stop();
});
const body = () => ({
  title: 'Direct client project',
  clientRef: String(client._id),
  primaryDepartment: String(department._id),
  projectManager: String(users.admin._id),
  startDate: '2026-01-01',
  deadline: '2026-01-10',
});
test('direct and internal creation, optional references, numbering, validation and financial redaction', async () => {
  expect((await call('get', '/', 'hr')).status).toBe(403);
  expect((await call('post', '/', 'employee', body())).status).toBe(403);
  const r = await call('post', '/', 'admin', body());
  expect(r.status, r.text).toBe(201);
  project = r.body.data;
  expect(project.projectId).toMatch(/^ADB\/PRJ\/\d{4}/);
  expect(project.status).toBe('UPCOMING');
  expect(project.delayed).toBe(true);
  expect(
    (await call('post', '/', 'admin', { ...body(), deadline: '2025-01-01' }))
      .status,
  ).toBe(400);
  const internal = await call('post', '/', 'admin', {
    ...body(),
    title: 'Internal work',
    clientRef: undefined,
    projectType: 'Internal Project',
  });
  expect(internal.status, internal.text).toBe(201);
  expect(internal.body.data.projectId).not.toBe(project.projectId);
  expect((await call('get', `/${project._id}`, 'employee')).status).toBe(404);
});
test('team membership limits visibility and task assignments reflect in employee work', async () => {
  const r = await call('post', `/${project._id}/team`, 'admin', {
    employee: String(users.employee._id),
    roleInProject: 'Developer',
    allocationPercentage: 75,
  });
  expect(r.status, r.text).toBe(200);
  const detail = await call('get', `/${project._id}`, 'employee');
  expect(detail.status, detail.text).toBe(200);
  expect(detail.body.data.amount).toBeUndefined();
  expect(
    (await call('get', `/${project._id}/financials`, 'employee')).status,
  ).toBe(403);
  const result = await call('post', `/${project._id}/tasks`, 'admin', {
    title: 'Build actual feature',
    assignedTo: String(users.employee._id),
    dueDate: '2026-01-09',
    estimatedHours: 8,
  });
  expect(result.status, result.text).toBe(201);
  task = result.body.data;
  const work = await request(app)
    .get('/api/v1/team/my-work')
    .auth(tokens.employee, { type: 'bearer' });
  expect(work.status, work.text).toBe(200);
  expect(work.body.data.tasks.some((t) => t._id === task._id)).toBe(true);
  expect(
    (
      await call('post', `/${project._id}/tasks`, 'admin', {
        title: 'Wrong assignee',
        assignedTo: String(users.executive._id),
      })
    ).status,
  ).toBe(400);
  expect((await call('get', `/${project._id}`, 'executive')).status).toBe(404);
});
test('task progress and milestone lifecycle guard completion and closed history', async () => {
  let r = await call('patch', `/${project._id}/tasks/${task._id}`, 'employee', {
    title: task.title,
    assignedTo: task.assignedTo,
    description: task.description,
    priority: task.priority,
    estimatedHours: 8,
    actualHours: 7,
    status: 'COMPLETED',
    version: task.version,
  });
  expect(r.status, r.text).toBe(200);
  r = await call('get', `/${project._id}`);
  project = r.body.data;
  expect(project.progress).toBe(100);
  r = await call('post', `/${project._id}/milestones`, 'admin', {
    title: 'Client delivery',
    dueDate: '2026-01-10',
  });
  expect(r.status, r.text).toBe(200);
  milestone = r.body.data;
  project = (await call('get', `/${project._id}`)).body.data;
  for (const status of ['ONGOING', 'REVIEW']) {
    r = await call('patch', `/${project._id}/status`, 'admin', {
      status,
      revision: project.revision,
    });
    expect(r.status, r.text).toBe(200);
    project = r.body.data;
  }
  expect(
    (
      await call('post', `/${project._id}/complete`, 'admin', {
        revision: project.revision,
      })
    ).status,
  ).toBe(409);
  r = await call(
    'patch',
    `/${project._id}/milestones/${milestone._id}`,
    'admin',
    {
      title: milestone.title,
      dueDate: '2026-01-10',
      status: 'COMPLETED',
      revision: milestone.revision,
    },
  );
  expect(r.status, r.text).toBe(200);
  project = (await call('get', `/${project._id}`)).body.data;
  r = await call('post', `/${project._id}/complete`, 'admin', {
    revision: project.revision,
    completionNotes: 'Delivered',
    deliveryNotes: 'Accepted',
  });
  expect(r.status, r.text).toBe(200);
  project = r.body.data;
  expect(project.completedAt).toBeTruthy();
  expect(
    (
      await call('post', `/${project._id}/tasks`, 'admin', {
        title: 'After closure',
      })
    ).status,
  ).toBe(409);
  r = await call('post', `/${project._id}/reopen`, 'admin', {
    revision: project.revision,
  });
  expect(r.status, r.text).toBe(200);
  project = r.body.data;
  expect(project.status).toBe('ONGOING');
  expect(
    (await call('get', `/${project._id}/activity`)).body.data.items.some(
      (r) => r.action === 'project.PROJECT_REOPENED',
    ),
  ).toBe(true);
});
test('scoped department grants, reports, private files and archive preserve history', async () => {
  await mongoose.model('Role').create({
    name: 'hr',
    label: 'HR',
    projectPermissions: [
      'projects.view',
      'projects.view_department',
      'projects.tasks.view',
    ],
  });
  expect((await call('get', `/${project._id}`, 'hr')).status).toBe(200);
  expect(
    (await call('get', '/dashboard', 'hr')).body.data.total,
  ).toBeGreaterThan(0);
  let r = await call('get', '/reports/summary?format=csv');
  expect(r.status, r.text).toBe(200);
  expect(r.text).toContain('Direct client project');
  expect(
    (await call('get', '/reports/summary?format=csv', 'employee')).status,
  ).toBe(403);
  const pdf = Buffer.from('%PDF-1.4\nproject-file');
  r = await request(app)
    .post(`/api/v1/projects/${project._id}/files`)
    .set('Origin', origin)
    .auth(tokens.employee, { type: 'bearer' })
    .field('category', 'Documents')
    .attach('file', pdf, {
      filename: 'project.pdf',
      contentType: 'application/pdf',
    });
  expect(r.status, r.text).toBe(201);
  const file = r.body.data;
  expect(
    (
      await call(
        'get',
        `/${project._id}/files/${file._id}/download`,
        'executive',
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await call(
        'get',
        `/${project._id}/files/${file._id}/download`,
        'employee',
      )
    ).status,
  ).toBe(200);
  expect((await call('delete', `/${project._id}`)).status).toBe(200);
  expect(
    await mongoose.model('TeamTask').exists({ _id: task._id }),
  ).toBeTruthy();
  expect((await call('get', `/${project._id}`)).status).toBe(200);
  expect(
    (await call('get', '/')).body.data.items.some((p) => p._id === project._id),
  ).toBe(false);
});
test('source-backed financial summary and profitability keep missing cost coverage explicit', async () => {
  let r = await call('post', '/', 'admin', {
    ...body(),
    title: 'Financial source project',
    service: 'web',
  });
  expect(r.status, r.text).toBe(201);
  const p = r.body.data;
  await mongoose.model('Invoice').create({
    invoiceNumber: 'PRJ-TEST-INV',
    project: p._id,
    clientRef: client._id,
    invoiceDate: new Date(),
    dueDate: new Date(),
    client: {
      company: 'Project Client',
      contactPerson: 'Test',
      address: 'Nagpur',
      contactNumber: '1234567890',
      email: 'test@project.test',
    },
    paymentDetails: {
      bankName: 'Test bank',
      accountNumber: '1234',
      ifscCode: 'TEST0001234',
      branch: 'Nagpur',
    },
    items: [{ title: 'Website', amount: 1000 }],
    subtotal: 1000,
    gstRate: 18,
    gstAmount: 180,
    grandTotal: 1180,
    totalMinor: 118000,
    taxableMinor: 100000,
    paidMinor: 18000,
    status: 'Partially Paid',
    createdBy: users.admin._id,
    updatedBy: users.admin._id,
  });
  r = await call('get', `/${p._id}/financials`);
  expect(r.status, r.text).toBe(200);
  expect(r.body.data.billedMinor).toBe(118000);
  expect(r.body.data.outstandingMinor).toBe(100000);
  expect(r.body.data.collectedMinor).toBe(0);
  expect(r.body.data.directExpensesMinor).toBeNull();
  await mongoose.model('FinanceExpense').create({
    expenseId: 'PRJ-TEST-EXP',
    project: p._id,
    date: new Date(),
    amountMinor: 20000,
    totalMinor: 20000,
    status: 'APPROVED',
    createdBy: users.admin._id,
  });
  r = await call('get', '/reports/profitability');
  expect(r.status, r.text).toBe(200);
  const record = r.body.data.items.find((r) => r.projectId === p.projectId);
  expect(record.directContributionMinor).toBe(80000);
  expect(record.coverage).toBe('DIRECT_COST_ONLY');
  expect(
    (await call('get', '/reports/manager')).body.data.items.some(
      (row) => row.name === 'admin',
    ),
  ).toBe(true);
  expect(
    (await call('get', '/?search=Project%20Client')).body.data.pagination.total,
  ).toBeGreaterThan(0);
});
test('optional converted lead and accepted quotation links validate client ownership', async () => {
  const lead = await mongoose
    .model('Lead')
    .create({
      leadId: 'PRJ-ORIGIN-1',
      companyKey: 'project client',
      companyName: 'Project Client',
      leadSource: 'Website',
      createdBy: users.admin._id,
      convertedClientId: client._id,
    });
  await mongoose
    .model('Client')
    .updateOne({ _id: client._id }, { $set: { originatingLead: lead._id } });
  const quote = await mongoose
    .model('Quotation')
    .create({
      quotationNumber: 'PRJ-QUOTE-1',
      lead: lead._id,
      clientRef: client._id,
      service: 'web',
      services: ['web'],
      title: 'Accepted Website',
      client: {
        company: 'Project Client',
        contactPerson: 'Test',
        contactNumber: '1234567890',
        email: 'test@project.test',
      },
      items: [{ service: 'web', description: 'Website', amount: 1000 }],
      subtotal: 1000,
      gstAmount: 180,
      grandTotal: 1180,
      status: 'Accepted',
      createdBy: users.admin._id,
      updatedBy: users.admin._id,
    });
  let r = await call('post', '/', 'admin', {
    ...body(),
    title: 'Converted source project',
    lead: String(lead._id),
    quotation: String(quote._id),
    service: 'web',
  });
  expect(r.status, r.text).toBe(201);
  const detail = await call('get', `/${r.body.data._id}`);
  expect(detail.body.data.lead.leadId).toBe(lead.leadId);
  expect(detail.body.data.quotation.quotationNumber).toBe(
    quote.quotationNumber,
  );
  const wrong = await call('post', '/', 'admin', {
    ...body(),
    quotation: String(new mongoose.Types.ObjectId()),
  });
  expect(wrong.status).toBe(400);
  r = await call('get', `/metadata?client=${client._id}`);
  expect(r.status, r.text).toBe(200);
  expect(r.body.data.quotations.some((q) => q._id === String(quote._id))).toBe(
    true,
  );
  const { runProjectReminders } =
    await import('../src/projects/projectAutomation.js');
  await runProjectReminders();
  const count = await mongoose
    .model('Notification')
    .countDocuments({ type: /^project\..*\.2026/ });
  await runProjectReminders();
  expect(
    await mongoose
      .model('Notification')
      .countDocuments({ type: /^project\..*\.2026/ }),
  ).toBe(count);
});
