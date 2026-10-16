import { beforeAll, afterAll, test, expect, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, access, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let database,
  app,
  User,
  issueSession,
  folder,
  admin,
  hr,
  other,
  superUser,
  tokens;
const origin = 'http://localhost:5173';
const model = (name) => mongoose.model(name);
const raw = async (name, data) => {
  const row = { _id: new mongoose.Types.ObjectId(), ...data };
  await model(name).collection.insertOne(row);
  return row;
};
const account = (email, role = 'employee') =>
  User.create({
    name: email,
    email,
    role,
    passwordHash: 'not-used',
    department: 'web_dev',
  });
const remove = (
  target,
  token = tokens.admin,
  path = 'hrms/employees',
  confirmation = target.email,
) =>
  request(app)
    .delete(`/api/v1/${path}/${target.id}/permanent`)
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send({ confirmation });
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'adborn-account-delete-'));
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: database.getUri(),
    CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 'a'.repeat(64),
    JWT_REFRESH_SECRET: 'b'.repeat(64),
    COOKIE_SECURE: 'false',
    ONBOARDING_UPLOAD_DIR: join(folder, 'onboarding'),
    CRM_UPLOAD_DIR: join(folder, 'crm'),
  });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  ({ issueSession } = await import('../src/services/tokenService.js'));
  await mongoose.connect(database.getUri());
  await Promise.all(
    Object.values(mongoose.models).map((Model) => Model.init()),
  );
  await mkdir(join(folder, 'crm'), { recursive: true });
  admin = await account('admin@delete.test', 'admin');
  hr = await account('hr@delete.test', 'hr');
  superUser = await account('super@delete.test', 'super_admin');
  other = await account('other@delete.test');
  tokens = {};
  for (const [key, user] of Object.entries({
    admin,
    hr,
    super: superUser,
    other,
  }))
    tokens[key] = (await issueSession(user)).accessToken;
}, 120000);
afterAll(async () => {
  vi.restoreAllMocks();
  await mongoose.disconnect();
  await database?.stop();
  if (folder?.startsWith(join(tmpdir(), 'adborn-account-delete-')))
    await rm(folder, { recursive: true, force: true });
});
test('permanent deletion enforces hierarchy, self protection and typed confirmation', async () => {
  expect((await remove(admin)).status).toBe(400);
  expect((await remove(superUser)).status).toBe(403);
  expect((await remove(admin, tokens.hr)).status).toBe(403);
  expect(
    (await remove(other, tokens.admin, 'hrms/employees', 'wrong@delete.test'))
      .status,
  ).toBe(400);
  expect((await remove(other, tokens.other)).status).toBe(403);
  expect(await User.exists({ _id: other.id })).toBeTruthy();
});
test('deletes the entire account graph and files, revokes access, preserves unrelated employees and recomputes shared totals', async () => {
  const target = await account('target@delete.test');
  const token = (await issueSession(target)).accessToken;
  await raw('EmployeeProfile', {
    user: target._id,
    employeeCode: 'DELETE-TARGET',
  });
  await raw('EmployeeProfile', {
    user: other._id,
    employeeCode: 'DELETE-OTHER',
    manager: target._id,
  });
  const attendance = await raw('HRMSRecord', {
    module: 'attendance',
    employee: target._id,
    createdBy: admin._id,
    deletedAt: null,
    data: { date: new Date() },
  });
  await raw('HRMSRecord', {
    module: 'attendance-regularizations',
    createdBy: admin._id,
    data: { attendanceId: String(attendance._id) },
  });
  const onboarding = await raw('HRMSRecord', {
    module: 'onboarding',
    employee: target._id,
    createdBy: admin._id,
  });
  await raw('OnboardingDocument', {
    onboarding: onboarding._id,
    employee: target._id,
    storedName: 'target.pdf',
    uploadedBy: admin._id,
  });
  await writeFile(join(folder, 'onboarding', 'target.pdf'), 'personal');
  await writeFile(join(folder, 'crm', 'target-attachment'), 'crm');
  await raw('LeaveLedger', { employee: target._id, createdBy: admin._id });
  const shared = await raw('HRMSRecord', {
    module: 'leave',
    employee: other._id,
    createdBy: target._id,
    data: {
      approvedBy: target.id,
      feedback: [
        { by: target.id, text: 'private' },
        { by: other.id, text: 'keep' },
      ],
    },
  });
  const run = await raw('HRMSRecord', {
    module: 'payroll-runs',
    createdBy: admin._id,
    data: { employeeCount: 2, grossAmount: 300, netAmount: 250 },
  });
  await raw('PayrollEntry', {
    run: run._id,
    employee: target._id,
    gross: 100,
    net: 80,
  });
  await raw('PayrollEntry', {
    run: run._id,
    employee: other._id,
    gross: 200,
    net: 170,
  });
  const lead = await raw('Lead', {
    leadId: 'DELETE-LEAD',
    companyKey: 'delete',
    assignedTo: target._id,
    createdBy: admin._id,
    attachments: [{ storageName: 'target-attachment', addedBy: target._id }],
  });
  const client = await raw('Client', {
    clientId: 'DELETE-CLIENT',
    originatingLead: lead._id,
    createdBy: other._id,
  });
  const quotation = await raw('Quotation', {
    quotationNumber: 'DELETE-QUOTE',
    clientRef: client._id,
    createdBy: other._id,
  });
  const project = await raw('Project', {
    projectId: 'DELETE-PROJECT',
    quotation: quotation._id,
    createdBy: other._id,
  });
  await raw('Invoice', {
    invoiceNumber: 'DELETE-INVOICE',
    project: project._id,
    createdBy: other._id,
  });
  const followup = await raw('CRMFollowUp', {
    followUpId: 'DELETE-FOLLOWUP',
    lead: lead._id,
    assignedTo: other._id,
    createdBy: admin._id,
  });
  await raw('LeadActivity', { lead: lead._id, performedBy: other._id });
  await raw('CRMImportBatch', { createdBy: target._id });
  const task = await raw('TeamTask', {
    taskId: 'DELETE-TASK',
    project: project._id,
    assignedTo: other._id,
  });
  await raw('TeamStandup', { employee: target._id, leader: admin._id });
  await raw('Notification', {
    recipient: other._id,
    createdBy: admin._id,
    entityId: followup._id,
  });
  await raw('AuditLog', {
    user: other._id,
    entityId: task._id,
    action: 'related',
  });
  const original = await raw('Lead', {
    leadId: 'ORIGIN-LEAD',
    companyKey: 'origin',
    createdBy: other._id,
  });
  await raw('Client', {
    clientId: 'OWNED-CLIENT',
    originatingLead: original._id,
    createdBy: target._id,
  });
  const survivor = await raw('Lead', {
    leadId: 'KEEP-LEAD',
    companyKey: 'keep',
    createdBy: other._id,
    assignedTo: other._id,
  });
  const response = await remove(target);
  expect(response.status).toBe(200);
  expect(response.body.data.cleanupPending).toBe(0);
  expect(await User.findById(target.id)).toBeNull();
  expect(
    (await request(app).get('/api/v1/auth/me').auth(token, { type: 'bearer' }))
      .status,
  ).toBe(401);
  for (const name of [
    'Session',
    'EmployeeProfile',
    'LeaveLedger',
    'PayrollEntry',
  ])
    expect(
      await model(name).countDocuments({
        [name === 'Session' || name === 'EmployeeProfile'
          ? 'user'
          : 'employee']: target._id,
      }),
    ).toBe(0);
  for (const name of [
    'OnboardingDocument',
    'Client',
    'Quotation',
    'Project',
    'Invoice',
    'CRMFollowUp',
    'LeadActivity',
    'CRMImportBatch',
    'TeamTask',
    'TeamStandup',
  ])
    expect(await model(name).countDocuments()).toBe(0);
  expect(await model('HRMSRecord').findById(attendance._id)).toBeNull();
  expect(await model('Lead').findById(lead._id)).toBeNull();
  expect(await model('Lead').findById(survivor._id)).toBeTruthy();
  expect(await model('Lead').findById(original._id)).toBeNull();
  const kept = await model('HRMSRecord').findById(shared._id).lean();
  expect(String(kept.employee)).toBe(other.id);
  expect(String(kept.createdBy)).toBe(admin.id);
  expect(kept.data.approvedBy).toBeUndefined();
  expect(kept.data.feedback).toEqual([{ by: other.id, text: 'keep' }]);
  expect(
    (await model('EmployeeProfile').findOne({ user: other._id })).manager,
  ).toBeUndefined();
  expect((await model('HRMSRecord').findById(run._id)).data).toMatchObject({
    employeeCount: 1,
    grossAmount: 200,
    netAmount: 170,
  });
  await expect(
    access(join(folder, 'onboarding', 'target.pdf')),
  ).rejects.toThrow();
  await expect(
    access(join(folder, 'crm', 'target-attachment')),
  ).rejects.toThrow();
});
test('a database failure rolls back the account, related records and file cleanup jobs', async () => {
  const target = await account('rollback@delete.test');
  const record = await raw('HRMSRecord', {
    module: 'leave',
    employee: target._id,
    createdBy: admin._id,
  });
  const failure = vi.spyOn(User, 'deleteMany').mockImplementationOnce(() => ({
    session: async () => {
      throw new Error('injected failure');
    },
  }));
  const response = await remove(target);
  failure.mockRestore();
  expect(response.status).toBe(500);
  expect(await User.findById(target.id)).toBeTruthy();
  expect(await model('HRMSRecord').findById(record._id)).toBeTruthy();
  expect(await model('FileDeletionJob').countDocuments()).toBe(0);
});
test('managed users use the same permanent deletion flow and failed disk cleanup retries', async () => {
  const target = await account('managed@delete.test', 'hr');
  expect((await remove(target, tokens.admin, 'user-management')).status).toBe(
    200,
  );
  expect(await User.findById(target.id)).toBeNull();
  const { cleanDeletedFiles } =
    await import('../src/services/fileDeletionService.js');
  await mkdir(join(folder, 'crm', 'retry-file'));
  const job = await raw('FileDeletionJob', { kind: 'crm', name: 'retry-file' });
  await cleanDeletedFiles({ _id: job._id });
  expect(await model('FileDeletionJob').findById(job._id)).toBeTruthy();
  await rmdir(join(folder, 'crm', 'retry-file'));
  await cleanDeletedFiles({ _id: job._id });
  expect(await model('FileDeletionJob').findById(job._id)).toBeNull();
});
