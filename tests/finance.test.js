import { beforeAll, afterAll, expect, test } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
let database,
  app,
  users = {},
  tokens = {},
  client,
  invoice,
  payment;
const origin = 'http://localhost:5173';
const call = (
  method,
  path,
  actor = 'admin',
  body,
  key = 'finance_test_key_123456',
) => {
  const agent = request(app);
  return agent[method](`/api/v1/finance${path}`)
    .set('Origin', origin)
    .set('Idempotency-Key', key)
    .auth(tokens[actor], { type: 'bearer' })
    .send(body);
};
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: database.getUri(),
    CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 'f'.repeat(64),
    JWT_REFRESH_SECRET: 'g'.repeat(64),
    COOKIE_SECURE: 'false',
    MAIL_DELIVERY: 'disabled',
  });
  ({ app } = await import('../src/app.js'));
  await mongoose.connect(database.getUri());
  await Promise.all(
    Object.values(mongoose.models).map((Model) => Model.init()),
  );
  const { issueSession } = await import('../src/services/tokenService.js');
  for (const role of ['super_admin', 'admin', 'hr', 'employee']) {
    users[role] = await mongoose
      .model('User')
      .create({
        name: role,
        email: `${role}@finance.test`,
        role,
        passwordHash: 'unused',
      });
    tokens[role] = (await issueSession(users[role])).accessToken;
  }
  client = await mongoose
    .model('Client')
    .create({
      clientId: 'FIN-C1',
      companyName: 'Finance Client',
      contactPerson: 'Client Person',
      email: 'client@finance.test',
      leadSource: 'Website',
      originatingLead: new mongoose.Types.ObjectId(),
      createdBy: users.admin._id,
      assignedTo: users.admin._id,
      stateCode: '27',
      gstin: '27ABCDE1234F1Z5',
      address: { city: 'Nagpur' },
    });
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
test('finance settings, exact GST and concurrent invoice numbering/idempotency', async () => {
  expect((await call('get', '/dashboard', 'hr')).status).toBe(403);
  expect((await call('get', '/invoices', 'employee')).status).toBe(403);
  const settings = await call('patch', '/settings', 'admin', {
    companyName: 'AdBorn Solutions',
    address: 'Nagpur',
    stateCode: '27',
    gstin: '27ABCDE1234F1Z5',
    bankName: 'Test Bank',
    accountNumber: '1234',
    ifscCode: 'TEST0001',
    branch: 'Nagpur',
    requireExpenseApproval: true,
  });
  expect(settings.status).toBe(200);
  const body = {
    client: client.id,
    invoiceDate: '2026-01-01',
    dueDate: '2026-01-10',
    items: [
      { description: 'Service', quantity: '1', rate: '1000', taxRate: '18' },
    ],
    status: 'SENT',
  };
  const created = await call('post', '/invoices', 'admin', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  invoice = created.body.data;
  expect(invoice.totalMinor).toBe(118000);
  expect(invoice.cgstMinor).toBe(9000);
  expect(invoice.sgstMinor).toBe(9000);
  expect(invoice.igstMinor).toBe(0);
  expect(invoice.invoiceNumber).toMatch(/^ADB\/INV\/\d{4}-\d{2}\/\d{4}$/);
  const repeated = await call('post', '/invoices', 'admin', body);
  expect(repeated.body.data._id).toBe(invoice._id);
  const mismatch = await call('post', '/invoices', 'admin', {
    ...body,
    notes: 'Different input',
  });
  expect(mismatch.status).toBe(409);
  const { invoiceAmounts } = await import('../src/finance/financeMoney.js');
  expect(
    invoiceAmounts(
      [{ description: 'fraction', quantity: '3', rate: '0.10', taxRate: '18' }],
      'INTER_STATE',
    ).totalMinor,
  ).toBe(35);
  const multiple = await Promise.all(
    [1, 2].map((value) =>
      call('post', '/invoices', 'admin', body, `new_invoice_request_${value}`),
    ),
  );
  expect(multiple.every((row) => row.status === 201)).toBe(true);
  expect(new Set(multiple.map((row) => row.body.data.invoiceNumber)).size).toBe(
    2,
  );
});
test('partial/full payments, overpayment protection, reversal and request retries are atomic', async () => {
  const body = {
    invoice: invoice._id,
    paymentDate: '2026-02-01',
    amount: '400',
    method: 'BANK_TRANSFER',
  };
  const first = await call(
    'post',
    '/payments',
    'admin',
    body,
    'payment_1_123456789',
  );
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  payment = first.body.data;
  expect(
    (await call('post', '/payments', 'admin', body, 'payment_1_123456789')).body
      .data._id,
  ).toBe(payment._id);
  let detail = await call('get', `/invoices/${invoice._id}`);
  expect(detail.body.data.invoice.balanceMinor).toBe(78000);
  expect(detail.body.data.invoice.financeStatus).toBe('PARTIALLY_PAID');
  expect(
    (
      await call(
        'post',
        '/payments',
        'admin',
        { ...body, amount: '1000' },
        'overpay_1234567890',
      )
    ).status,
  ).toBe(409);
  const race = await Promise.all(
    [1, 2].map((value) =>
      call(
        'post',
        '/payments',
        'admin',
        { ...body, amount: '780' },
        `settle_final_${value}_key`,
      ),
    ),
  );
  expect(race.map((row) => row.status).sort()).toEqual([201, 409]);
  detail = await call('get', `/invoices/${invoice._id}`);
  expect(detail.body.data.invoice.financeStatus).toBe('PAID');
  const reversed = await call(
    'post',
    `/payments/${payment._id}/reverse`,
    'admin',
    { reason: 'Payment was returned' },
  );
  expect(reversed.status).toBe(200);
  expect(
    (await call('get', `/invoices/${invoice._id}`)).body.data.invoice
      .balanceMinor,
  ).toBe(40000);
  expect(
    (
      await call('post', `/invoices/${invoice._id}/cancel`, 'admin', {
        reason: 'Cannot cancel paid money',
      })
    ).status,
  ).toBe(409);
  const ledger = await call('get', `/ledger?client=${client.id}`);
  expect(ledger.status).toBe(200);
  expect(
    ledger.body.data.items.some((row) => row.particular === 'Payment reversal'),
  ).toBe(true);
});
test('expenses enforce approvals and generate honest cash/cost analytics', async () => {
  const created = await call('post', '/expenses', 'admin', {
    date: '2026-02-02',
    category: 'Software Subscription',
    vendor: 'Vendor',
    description: 'Design tools',
    amount: '100.10',
    tax: '18.02',
  });
  expect(created.status).toBe(201);
  let row = created.body.data;
  expect(row.totalMinor).toBe(11812);
  expect(
    (
      await call('post', `/expenses/${row._id}/action`, 'admin', {
        action: 'pay',
        revision: row.revision,
      })
    ).status,
  ).toBe(409);
  row = (
    await call('post', `/expenses/${row._id}/action`, 'admin', {
      action: 'submit',
      revision: row.revision,
    })
  ).body.data;
  row = (
    await call('post', `/expenses/${row._id}/action`, 'admin', {
      action: 'approve',
      revision: row.revision,
    })
  ).body.data;
  row = (
    await call('post', `/expenses/${row._id}/action`, 'admin', {
      action: 'pay',
      revision: row.revision,
    })
  ).body.data;
  expect(row.status).toBe('PAID');
  const dashboard = await call('get', '/dashboard');
  expect(dashboard.status, JSON.stringify(dashboard.body)).toBe(200);
  expect(dashboard.body.data.totals.expenseMinor).toBe(11812);
  expect(dashboard.body.data.totals.collectedMinor).toBe(78000);
  expect(dashboard.body.data.totals.billedMinor).toBe(354000);
  expect(dashboard.body.data.totals.outstandingMinor).toBe(276000);
  expect(
    (await call('get', '/outstanding?due=overdue')).body.data.items,
  ).toHaveLength(3);
});
test('recurring billing is period-idempotent, cancellation and exports remain protected', async () => {
  const created = await call('post', '/recurring', 'admin', {
    client: client.id,
    service: 'web',
    description: 'Monthly support',
    startDate: '2026-01-01',
    nextBillingDate: '2026-01-31',
    frequency: 'MONTHLY',
    amount: '100',
    taxRate: '18',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const body = { period: created.body.data.nextBillingDate };
  const first = await call(
    'post',
    `/recurring/${created.body.data._id}/generate`,
    'admin',
    body,
  );
  expect(first.status).toBe(201);
  const retry = await call(
    'post',
    `/recurring/${created.body.data._id}/generate`,
    'admin',
    body,
  );
  expect(retry.body.data._id).toBe(first.body.data._id);
  expect(
    (
      await call('post', `/invoices/${first.body.data._id}/cancel`, 'admin', {
        reason: 'Unused draft',
      })
    ).status,
  ).toBe(200);
  const pdf = await call('get', `/invoices/${invoice._id}/pdf`);
  expect(pdf.status).toBe(200);
  expect(pdf.headers['content-type']).toContain('application/pdf');
  const exported = await call('get', '/reports/invoices?format=csv');
  expect(exported.status).toBe(200);
  expect((await call('get', '/reports/invoices?format=csv', 'hr')).status).toBe(
    403,
  );
});
test('custom finance scopes, immutable settlements and role grants prevent bypasses', async () => {
  const Role = mongoose.model('Role');
  await Role.create({ name: 'employee', label: 'Scoped finance', financePermissions: ['finance.invoices.view','finance.invoices.export','finance.payments.view','finance.reports.view','finance.reports.export','finance.scope.own'] });
  expect((await call('get', `/invoices/${invoice._id}`, 'employee')).status).toBe(404);
  const own = await call('get', '/invoices', 'employee'); expect(own.body.data.items).toHaveLength(0);
  expect((await call('get', '/reports/invoices?format=csv', 'employee')).text).not.toContain(invoice.invoiceNumber);
  const legacyWrite = await request(app).put(`/api/v1/invoices/${invoice._id}`).set('Origin',origin).auth(tokens.admin,{type:'bearer'}).send({ invoiceDate:'2026-01-01', dueDate:'2026-01-10', client:{company:'Finance Client',contactPerson:'Client',address:'Nagpur',contactNumber:'12345678',email:'client@finance.test'}, paymentDetails:{bankName:'Bank',accountNumber:'123',ifscCode:'TEST',branch:'Nagpur'}, items:[{title:'Changed',amount:1}],gstRate:0,status:'Sent' });
  expect(legacyWrite.status).toBe(409);
  expect((await call('patch','/access/super_admin','super_admin',{permissions:[]})).status).toBe(400);
  await Role.deleteOne({name:'employee'});
});
test('recurring edits and IST fiscal/day arithmetic work without revision conflicts', async () => {
  const body = { client: client.id, service:'web', description:'Monthly edits', startDate:'2026-01-01', nextBillingDate:'2026-01-31', frequency:'MONTHLY', amount:'100',taxRate:'18' };
  const created = await call('post','/recurring','admin',body); expect(created.status).toBe(200);
  const edited = await call('patch',`/recurring/${created.body.data._id}`,'admin',{...body,description:'Updated plan',revision:created.body.data.revision}); expect(edited.status,JSON.stringify(edited.body)).toBe(200);
  const { nextBillingDate } = await import('../src/finance/financeService.js');
  expect(nextBillingDate(new Date('2026-01-31T00:00:00+05:30'),'MONTHLY').toISOString()).toBe('2026-02-27T18:30:00.000Z');
  const { invoiceAmounts } = await import('../src/finance/financeMoney.js');
  expect(invoiceAmounts([{description:'A',quantity:'1',rate:'0.10',taxRate:'0'},{description:'B',quantity:'1',rate:'0.20',taxRate:'0'}],'EXEMPT').totalMinor).toBe(30);
  expect(()=>invoiceAmounts([{description:'Bad',quantity:'1',rate:'0.001',taxRate:'0'}],'EXEMPT')).toThrow();
});
