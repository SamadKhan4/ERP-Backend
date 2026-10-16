import { beforeAll, afterAll, expect, test } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
let database,
  app,
  User,
  Lead,
  Role,
  EmployeeProfile,
  tokens = {},
  users = {},
  leadId;
const origin = 'http://localhost:5173';
const call = (method, path, role = 'admin', body) => {
  const agent = request(app);
  return agent[method](`/api/v1/crm${path}`)
    .set('Origin', origin)
    .auth(tokens[role] || 'invalid', { type: 'bearer' })
    .send(body);
};
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: database.getUri(),
    CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 'c'.repeat(64),
    JWT_REFRESH_SECRET: 'd'.repeat(64),
    COOKIE_SECURE: 'false',
  });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  ({ Lead } = await import('../src/models/Lead.js'));
  ({ Role } = await import('../src/models/Role.js'));
  ({ EmployeeProfile } = await import('../src/models/EmployeeProfile.js'));
  await mongoose.connect(database.getUri());
  const { crmPermissions } = await import('../../shared/crm.js');
  await Role.create({ name: 'lead_caller', label: 'Scoped CRM test role', permissions: crmPermissions.filter((permission) => !['crm.leads.view', 'crm.leads.view_own', 'crm.leads.delete', 'crm.settings.manage', 'crm.reports.export'].includes(permission)) });
  const { issueSession } = await import('../src/services/tokenService.js');
  for (const [key, role] of Object.entries({
    admin: 'admin',
    manager: 'manager',
    team: 'lead_caller',
    sales: 'executive',
    other: 'executive',
    hr: 'hr',
    employee: 'employee',
  })) {
    users[key] = await User.create({
      name: key,
      email: `${key}@crm.test`,
      role,
      department: 'web_dev',
      passwordHash: 'not-used-by-test',
    });
    tokens[key] = (await issueSession(users[key])).accessToken;
  }
  await EmployeeProfile.create({
    user: users.sales.id,
    employeeCode: 'CRM-SALES',
    manager: users.team.id,
  });
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

test('CRM phase 1: validation, atomic numbering, scoped CRUD, duplicate detection and dynamic grants', async () => {
  expect((await call('get', '/leads', 'employee')).status).toBe(403);
  expect((await call('get', '/leads', 'hr')).status).toBe(403);
  expect((await call('get', '/leads', 'missing')).status).toBe(401);
  expect(
    (
      await call('post', '/leads', 'sales', {
        companyName: 'Invalid',
        leadSource: 'Website',
        estimatedBudget: -1,
      })
    ).status,
  ).toBe(400);
  const created = await call('post', '/leads', 'sales', {
    companyName: 'Acme CRM',
    phone: '+91 9988776655',
    email: 'acme@crm.test',
    leadSource: 'Website',
    interestedServices: ['web'],
    estimatedBudget: 80000,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  leadId = created.body.data._id;
  expect(created.body.data.leadId).toMatch(/^ADB\/LEAD\/\d{4}$/);
  expect((await call('get', `/leads/${leadId}`, 'other')).status).toBe(404);
  expect((await call('get', `/leads/${leadId}`, 'team')).status).toBe(200);
  expect((await call('get', `/leads/${leadId}`, 'manager')).status).toBe(200);
  expect(
    (
      await call('patch', `/leads/${leadId}`, 'manager', {
        notes: 'Cannot edit by default',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('patch', `/leads/${leadId}`, 'sales', {
        notes: 'Call scheduled',
      })
    ).status,
  ).toBe(200);
  const duplicate = await call('post', '/leads', 'admin', {
    companyName: 'Other',
    phone: '+919988776655',
    leadSource: 'Google',
  });
  expect(duplicate.status).toBe(409);
  const sameCompany = await call('post', '/leads', 'admin', {
    companyName: 'Acme CRM',
    leadSource: 'Google',
  });
  expect(sameCompany.status).toBe(201);
  const concurrent = await Promise.all(
    [1, 2, 3].map((value) =>
      call('post', '/leads', 'sales', {
        companyName: `Concurrent ${value}`,
        leadSource: 'Referral',
      }),
    ),
  );
  expect(concurrent.every((response) => response.status === 201)).toBe(true);
  expect(
    new Set(concurrent.map((response) => response.body.data.leadId)).size,
  ).toBe(3);
  const listed = await call(
    'get',
    '/leads?search=Acme&limit=1&page=1&source=Website',
    'sales',
  );
  expect(listed.body.data.items).toHaveLength(1);
  expect(listed.body.data.pagination.total).toBe(1);
  expect(
    (await call('get', '/leads/duplicates?companyName=Acme%20CRM', 'sales'))
      .body.data.items,
  ).toHaveLength(1);
  await Role.create({
    name: 'employee',
    label: 'Employee',
    permissions: ['crm.leads.view_own', 'crm.leads.create'],
  });
  expect((await call('get', '/leads', 'employee')).status).toBe(200);
  const me = await request(app)
    .get('/api/v1/auth/me')
    .auth(tokens.employee, { type: 'bearer' });
  expect(me.body.data.permissions).toContain('crm.leads.view_own');
});

test('CRM phase 2: activities and follow-up lifecycle preserve scope and the next schedule', async () => {
  expect(
    (
      await call('post', `/leads/${leadId}/activities`, 'other', {
        type: 'CALL',
        title: 'Unauthorized call',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('post', `/leads/${leadId}/activities`, 'sales', {
        type: 'CALL',
        title: 'Discovery call',
        description: 'Discussed website requirements',
      })
    ).status,
  ).toBe(201);
  const first = await call('post', `/leads/${leadId}/follow-ups`, 'sales', {
    type: 'CALL',
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    notes: 'Discuss proposal',
  });
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  const followUpId = first.body.data._id;
  expect(
    (
      await call('post', `/follow-ups/${followUpId}/complete`, 'other', {
        outcome: 'Unauthorized',
      })
    ).status,
  ).toBe(404);
  const rescheduled = await call(
    'post',
    `/follow-ups/${followUpId}/reschedule`,
    'sales',
    { scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString() },
  );
  expect(rescheduled.status).toBe(200);
  expect(
    (
      await call('post', `/follow-ups/${followUpId}/complete`, 'sales', {
        outcome: 'Old schedule',
      })
    ).status,
  ).toBe(409);
  const pending = await call(
    'get',
    `/leads/${leadId}/follow-ups?tab=all`,
    'sales',
  );
  const next = pending.body.data.items.find(
    (item) => item.status === 'PENDING',
  );
  expect(next).toBeTruthy();
  expect(
    (
      await call('post', `/follow-ups/${next._id}/complete`, 'sales', {
        outcome: 'Proposal requested',
        nextFollowUpAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      })
    ).status,
  ).toBe(200);
  expect(
    new Date((await Lead.findById(leadId)).nextFollowUpAt).getTime(),
  ).toBeGreaterThan(Date.now() + 2 * 86400000);
  const activities = await call('get', `/leads/${leadId}/activities`, 'sales');
  expect(activities.status).toBe(200);
  expect(activities.body.data.items.some((item) => item.type === 'CALL')).toBe(
    true,
  );
  expect(
    (await call('get', '/activities', 'other')).body.data.items,
  ).toHaveLength(0);
});

test('CRM phase 3: pipeline moves, lost reasons and audited assignment are enforced', async () => {
  expect(
    (
      await call('post', `/leads/${leadId}/change-stage`, 'other', {
        stage: 'QUALIFIED',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('post', `/leads/${leadId}/change-stage`, 'sales', {
        stage: 'LOST',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call('post', `/leads/${leadId}/change-stage`, 'sales', {
        stage: 'LOST',
        lostReason: 'Other',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call('post', `/leads/${leadId}/change-stage`, 'sales', {
        stage: 'LOST',
        lostReason: 'Budget',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('post', `/leads/${leadId}/change-stage`, 'sales', {
        stage: 'QUALIFIED',
      })
    ).status,
  ).toBe(200);
  const pipeline = await call('get', '/pipeline', 'team');
  expect(
    pipeline.body.data.stages.some((item) => item._id.stage === 'QUALIFIED'),
  ).toBe(true);
  expect(
    (
      await call('post', `/leads/${leadId}/assign`, 'sales', {
        assignedTo: users.other.id,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('post', `/leads/${leadId}/assign`, 'team', {
        assignedTo: users.other.id,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('post', '/leads/bulk-assign', 'admin', {
        ids: [leadId],
        assignedTo: users.other.id,
      })
    ).status,
  ).toBe(200);
  expect((await call('get', `/leads/${leadId}`, 'sales')).status).toBe(404);
  expect(
    (
      await call('post', `/leads/${leadId}/assign`, 'admin', {
        assignedTo: users.sales.id,
      })
    ).status,
  ).toBe(200);
});

test('CRM phase 4: quotation, atomic conversion, projects and invoice references stay connected', async () => {
  const quotationInput = {
    services: ['web'],
    title: 'CRM Website proposal',
    client: {
      company: 'Acme CRM',
      contactPerson: 'Buyer',
      contactNumber: '9988776655',
      email: 'acme@crm.test',
    },
    items: [
      { service: 'web', description: 'Website implementation', amount: 80000 },
    ],
    status: 'Sent',
  };
  expect(
    (await call('post', `/leads/${leadId}/quotations`, 'sales', quotationInput))
      .status,
  ).toBe(403);
  const quotation = await call(
    'post',
    `/leads/${leadId}/quotations`,
    'admin',
    quotationInput,
  );
  expect(quotation.status, JSON.stringify(quotation.body)).toBe(201);
  expect(quotation.body.data.lead).toBe(leadId);
  const lead = await Lead.findById(leadId).lean();
  const client = Object.fromEntries(
    [
      'companyName',
      'contactPerson',
      'phone',
      'whatsapp',
      'email',
      'website',
      'address',
      'industry',
      'leadSource',
      'interestedServices',
    ].map((key) => [key, lead[key]]),
  );
  const conversions = await Promise.all([
    call('post', `/leads/${leadId}/convert`, 'admin', { client }),
    call('post', `/leads/${leadId}/convert`, 'admin', { client }),
  ]);
  expect(conversions.map((response) => response.status).sort()).toEqual([
    201, 409,
  ]);
  const converted = conversions.find((response) => response.status === 201).body
    .data;
  const { Client } = await import('../src/models/Client.js');
  expect(await Client.countDocuments({ originatingLead: leadId })).toBe(1);
  expect(
    (await call('get', `/clients/${converted.client._id}`, 'other')).status,
  ).toBe(404);
  expect(
    (
      await call('post', `/leads/${leadId}/change-stage`, 'admin', {
        stage: 'NEW',
      })
    ).status,
  ).toBe(409);
  const project = await call(
    'post',
    `/clients/${converted.client._id}/projects`,
    'admin',
    {
      lead: leadId,
      title: 'Website build',
      service: 'web',
      quotation: quotation.body.data._id,
      billingType: 'ONE_TIME',
      amount: 80000,
    },
  );
  expect(project.status, JSON.stringify(project.body)).toBe(201);
  const invoice = await request(app)
    .post('/api/v1/invoices')
    .set('Origin', origin)
    .auth(tokens.admin, { type: 'bearer' })
    .send({
      invoiceDate: '2026-10-16',
      dueDate: '2026-11-16',
      client: { ...quotationInput.client, address: 'Mumbai India' },
      paymentDetails: {
        bankName: 'Test Bank',
        accountNumber: '123456789',
        ifscCode: 'BANK0000123',
        branch: 'Mumbai',
      },
      items: [{ title: 'Website build', amount: 80000 }],
      quotation: quotation.body.data._id,
      project: project.body.data._id,
    });
  expect(invoice.status).toBe(201);
  expect(invoice.body.data.lead).toBe(leadId);
  expect(invoice.body.data.clientRef).toBe(converted.client._id);
  expect((await call('delete', `/leads/${leadId}`)).status).toBe(409);
  const quotes = await call('get', `/leads/${leadId}/quotations`);
  expect(quotes.body.data.items[0].clientRef).toBe(converted.client._id);
  const upload = await request(app)
    .post(`/api/v1/crm/leads/${leadId}/documents`)
    .set('Origin', origin)
    .auth(tokens.admin, { type: 'bearer' })
    .attach('file', Buffer.from('%PDF-1.4\nCRM test document'), 'crm.pdf');
  expect(upload.status).toBe(201);
  const document = (await Lead.findById(leadId)).attachments[0];
  const download = await call(
    'get',
    `/leads/${leadId}/documents/${document._id}`,
    'other',
  );
  expect(download.status).toBe(404);
  const { unlink } = await import('node:fs/promises');
  await unlink(
    new URL(`../.crm-files/${document.storageName}`, import.meta.url),
  );
});

test('CRM phase 5: scoped dashboard, reports, settings and deduplicated reminders', async () => {
  const dashboard = await call('get', '/dashboard', 'sales');
  expect(dashboard.status, JSON.stringify(dashboard.body)).toBe(200);
  expect(dashboard.body.data.totals.total).toBe(
    await Lead.countDocuments({ assignedTo: users.sales.id, deletedAt: null }),
  );
  expect(dashboard.body.data.totals.won).toBe(1);
  const otherDashboard = await call('get', '/dashboard', 'other');
  expect(otherDashboard.body.data.totals.won).toBe(0);
  for (const kind of [
    'lead-source',
    'conversion',
    'pipeline',
    'won-lost',
    'performance',
    'service-interest',
    'aging',
    'followup',
  ])
    expect((await call('get', `/reports/${kind}`, 'manager')).status).toBe(200);
  expect((await call('get', '/reports/export', 'sales')).status).toBe(403);
  const csv = await call('get', '/reports/export', 'admin');
  expect(csv.status).toBe(200);
  expect(csv.text).toContain('ADB/LEAD/');
  expect((await call('get', '/settings', 'sales')).status).toBe(403);
  const settings = await call('get', '/settings', 'admin');
  expect(settings.status).toBe(200);
  const { stages, label } = await import('../../shared/crm.js');
  expect(
    (
      await call('patch', '/settings', 'admin', {
        sources: [...settings.body.data.settings.sources, 'Conference'],
        lostReasons: settings.body.data.settings.lostReasons,
        tags: ['Enterprise'],
        stageLabels: Object.fromEntries(
          stages.map((stage) => [stage, label(stage)]),
        ),
        defaultFollowUpDays: 2,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('post', '/leads', 'sales', {
        companyName: 'Conference Prospect',
        leadSource: 'Conference',
      })
    ).status,
  ).toBe(201);
  const { CRMFollowUp } = await import('../src/models/CRMFollowUp.js');
  await CRMFollowUp.updateOne(
    { lead: leadId, status: 'PENDING' },
    {
      $set: {
        scheduledAt: new Date(Date.now() - 3600000),
        overdueNotifiedAt: null,
      },
    },
  );
  const { sendCRMReminders } =
    await import('../src/services/crmReminderService.js');
  const { Notification } = await import('../src/models/Notification.js');
  await sendCRMReminders();
  const count = await Notification.countDocuments({
    type: 'crm_followup_overdue',
  });
  expect(count).toBeGreaterThan(0);
  await sendCRMReminders();
  expect(
    await Notification.countDocuments({ type: 'crm_followup_overdue' }),
  ).toBe(count);
  expect(
    (
      await call('patch', '/settings/roles/hr', 'admin', {
        permissions: ['crm.leads.view_own', 'crm.dashboard.view'],
      })
    ).status,
  ).toBe(200);
  expect((await call('get', '/leads', 'hr')).status).toBe(200);
});

test('Excel lead import maps columns, rejects invalid rows, enforces access and retries idempotently', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Leads');
  sheet.addRow([
    'Business',
    'Mobile',
    'Email Address',
    'Services',
    'Source',
    'Owner Email',
  ]);
  sheet.addRow([
    'Imported Alpha',
    '+919911223344',
    'import-alpha@example.test',
    'Website Development, SEO',
    'Google',
    users.sales.email,
  ]);
  sheet.addRow([
    'Invalid Email',
    '+919911223355',
    'bad email',
    'web',
    'Google',
    '',
  ]);
  sheet.addRow(['Existing Contact', '+919988776655', '', 'web', 'Google', '']);
  sheet.addRow([
    'Workbook Duplicate',
    '+919911223344',
    '',
    'web',
    'Google',
    '',
  ]);
  sheet.addRow([
    'Imported Beta',
    '09911223366',
    'import-beta@example.test',
    'SEO',
    '',
    '',
  ]);
  sheet.addRow([
    { formula: '"Formula company"', result: 'Formula company' },
    '',
    '',
    '',
    '',
    '',
  ]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  expect(
    (
      await request(app)
        .post('/api/v1/crm/leads/import/preview')
        .set('Origin', origin)
        .auth(tokens.sales, { type: 'bearer' })
        .attach('file', bytes, 'leads.xlsx')
    ).status,
  ).toBe(403);
  const preview = await request(app)
    .post('/api/v1/crm/leads/import/preview')
    .set('Origin', origin)
    .auth(tokens.admin, { type: 'bearer' })
    .attach('file', bytes, 'leads.xlsx');
  expect(preview.status, JSON.stringify(preview.body)).toBe(201);
  const batch = preview.body.data;
  expect(batch.total).toBe(6);
  expect(batch.mapping.companyName).toBe(0);
  expect(batch.mapping.phone).toBe(1);
  const config = {
    mapping: batch.mapping,
    defaults: {
      leadSource: 'Website',
      priority: 'MEDIUM',
      temperature: 'WARM',
    },
  };
  const validation = await call(
    'post',
    `/leads/import/${batch.batchId}/validate`,
    'admin',
    config,
  );
  expect(validation.status, JSON.stringify(validation.body)).toBe(200);
  expect(validation.body.data.valid).toBe(2);
  expect(validation.body.data.invalid).toBe(4);
  expect(
    (
      await call(
        'post',
        `/leads/import/${batch.batchId}/validate`,
        'team',
        config,
      )
    ).status,
  ).toBe(404);
  const imported = await call(
    'post',
    `/leads/import/${batch.batchId}/commit`,
    'admin',
    { ...config, rows: [2, 6] },
  );
  expect(imported.status, JSON.stringify(imported.body)).toBe(200);
  expect(
    imported.body.data.results.every((row) => row.status === 'IMPORTED'),
  ).toBe(true);
  expect(
    (
      await Lead.findOne({ email: 'import-alpha@example.test' })
    ).assignedTo.toString(),
  ).toBe(users.sales.id);
  expect(
    (await Lead.findOne({ email: 'import-beta@example.test' })).phone,
  ).toBe('09911223366');
  const retried = await call(
    'post',
    `/leads/import/${batch.batchId}/commit`,
    'admin',
    { ...config, rows: [2, 6] },
  );
  expect(
    retried.body.data.results.every(
      (row) => row.message === 'Already imported',
    ),
  ).toBe(true);
  expect(
    await Lead.countDocuments({ importKey: { $regex: `^${batch.batchId}:` } }),
  ).toBe(2);
  const malformed = await request(app)
    .post('/api/v1/crm/leads/import/preview')
    .set('Origin', origin)
    .auth(tokens.admin, { type: 'bearer' })
    .attach('file', Buffer.from('not an Excel file'), 'fake.xlsx');
  expect(malformed.status).toBe(400);
});
