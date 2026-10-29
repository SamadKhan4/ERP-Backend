import { afterAll, beforeAll, expect, test } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';

let database, app, User, token;
const origin = 'http://localhost:5173';
const invoice = {
  invoiceDate: '2026-10-15',
  dueDate: '2026-10-30',
  client: {
    company: 'Acme Private Limited',
    contactPerson: 'Aman Verma',
    address: 'Nagpur, Maharashtra',
    contactNumber: '+91 9876543210',
    email: 'aman@acme.example',
  },
  paymentDetails: {
    bankName: 'Example Bank',
    accountNumber: '1234567890',
    ifscCode: 'EXAM0001234',
    branch: 'Nagpur',
  },
  items: [
    { title: 'Website Development', amount: 35000 },
    { title: 'SEO Services', amount: 10000 },
  ],
  gstRate: 18,
  status: 'Draft',
  paymentTerms: 'Payment is due by the invoice due date.',
};

beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: database.getUri(),
    CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 'a'.repeat(64),
    JWT_REFRESH_SECRET: 'b'.repeat(64),
    COOKIE_SECURE: 'false',
    COOKIE_SAME_SITE: 'lax',
    RESET_DELIVERY: 'file',
  });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  await mongoose.connect(database.getUri());
  const admin = await User.create({
    name: 'Invoice Admin',
    email: 'invoice@example.test',
    passwordHash: await bcrypt.hash('InvoicePassword123', 12),
    role: 'admin',
  });
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ email: admin.email, password: 'InvoicePassword123' });
  token = login.body.data.accessToken;
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

test('invoice CRUD calculates totals and produces the branded PDF', async () => {
  const created = await request(app)
    .post('/api/v1/invoices')
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send(invoice);
  expect(created.status).toBe(201);
  expect(created.body.data.invoiceNumber).toMatch(/^ADB-INV-\d{4}-0001$/);
  expect(created.body.data.paymentTerms).toBe(invoice.paymentTerms);
  expect(created.body.data.subtotal).toBe(45000);
  expect(created.body.data.gstAmount).toBe(8100);
  expect(created.body.data.grandTotal).toBe(53100);
  const id = created.body.data._id;

  const listed = await request(app)
    .get('/api/v1/invoices?search=Acme')
    .auth(token, { type: 'bearer' });
  expect(listed.status).toBe(200);
  expect(listed.body.data.items).toHaveLength(1);

  const updated = await request(app)
    .put(`/api/v1/invoices/${id}`)
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send({ ...invoice, status: 'Sent', gstRate: 0 });
  expect(updated.status).toBe(200);
  expect(updated.body.data.paymentTerms).toBe(invoice.paymentTerms);
  expect(updated.body.data.grandTotal).toBe(45000);

  const pdf = await request(app)
    .get(`/api/v1/invoices/${id}/download`)
    .auth(token, { type: 'bearer' });
  expect(pdf.status).toBe(200);
  expect(pdf.headers['content-type']).toContain('application/pdf');

  expect(
    (
      await request(app)
        .delete(`/api/v1/invoices/${id}`)
        .set('Origin', origin)
        .auth(token, { type: 'bearer' })
    ).status,
  ).toBe(200);
  expect(
    (await request(app).get('/api/v1/invoices').auth(token, { type: 'bearer' }))
      .body.data.items,
  ).toHaveLength(0);
});

test('invoice accepts blank or omitted email and rejects malformed email', async () => {
  for (const email of ['', undefined]) {
    const payload = { ...invoice, client: { ...invoice.client, email } };
    const result = await request(app)
      .post('/api/v1/invoices')
      .set('Origin', origin)
      .auth(token, { type: 'bearer' })
      .send(payload);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.data.client.email).toBe('');
  }
  const invalid = await request(app)
    .post('/api/v1/invoices')
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send({
      ...invoice,
      client: { ...invoice.client, email: 'invalid-email' },
    });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.details).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: 'client.email',
        message: expect.any(String),
      }),
    ]),
  );
});

test('invoice update validates fields and atomically records Paid in Finance', async () => {
  const created = await request(app)
    .post('/api/v1/invoices')
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send(invoice);
  expect(created.status).toBe(201);
  const update = (payload) =>
    request(app)
      .put(`/api/v1/invoices/${created.body.data._id}`)
      .set('Origin', origin)
      .auth(token, { type: 'bearer' })
      .send(payload);
  const invalid = await update({ ...invoice, dueDate: '2026-10-01' });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.details).toContainEqual({
    field: 'dueDate',
    message: 'Due date must be on or after invoice date',
  });
  const paid = await update({ ...invoice, status: 'Paid' });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  expect(paid.body.data.status).toBe('Paid');
  expect(paid.body.data.totalMinor).toBe(5310000);
  expect(paid.body.data.paidMinor).toBe(5310000);
  const { FinancePayment } = await import('../src/models/Finance.js');
  const receipts = await FinancePayment.find({
    invoice: created.body.data._id,
  });
  expect(receipts).toHaveLength(1);
  expect(receipts[0].amountMinor).toBe(5310000);
  expect(receipts[0].status).toBe('POSTED');
  const retry = await update({ ...invoice, status: 'Paid' });
  expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  expect(
    await FinancePayment.countDocuments({ invoice: created.body.data._id }),
  ).toBe(1);
  const changed = await update({ ...invoice, status: 'Sent' });
  expect(changed.status).toBe(409);
  const { invoiceState } = await import('../src/finance/financeMoney.js');
  expect(invoiceState(paid.body.data).balanceMinor).toBe(0);
});

test.each(['GST', 'NON_GST'])(
  'invoice accepts omitted or blank fields for %s',
  async (invoiceType) => {
    for (const fields of [
      {},
      {
        invoiceDate: '',
        dueDate: '',
        client: {
          company: '',
          contactPerson: '',
          address: '',
          contactNumber: '',
        },
        paymentDetails: {},
        items: [{}],
      },
    ]) {
      const result = await request(app)
        .post('/api/v1/invoices')
        .set('Origin', origin)
        .auth(token, { type: 'bearer' })
        .send({ invoiceType, ...fields });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      expect(result.body.data.grandTotal).toBe(0);
      expect(result.body.data.issuerBrand).toBe(
        invoiceType === 'GST' ? 'ABCO' : 'ADBORN',
      );
      const pdf = await request(app)
        .get(`/api/v1/invoices/${result.body.data._id}/download`)
        .auth(token, { type: 'bearer' });
      expect(pdf.status).toBe(200);
    }
  },
);

test('concurrent Paid saves post one receipt and preserve the settled amount', async () => {
  const created = await request(app)
    .post('/api/v1/invoices')
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send(invoice);
  const id = created.body.data._id;
  const save = () =>
    request(app)
      .put(`/api/v1/invoices/${id}`)
      .set('Origin', origin)
      .auth(token, { type: 'bearer' })
      .send({ ...invoice, status: 'Paid' });
  const results = await Promise.all([save(), save()]);
  for (const result of results)
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  const { FinancePayment } = await import('../src/models/Finance.js');
  expect(await FinancePayment.countDocuments({ invoice: id })).toBe(1);
  const changed = await request(app)
    .put(`/api/v1/invoices/${id}`)
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send({
      ...invoice,
      status: 'Paid',
      items: [{ title: 'Changed', amount: 1 }],
    });
  expect(changed.status).toBe(409);
  const stored = await request(app)
    .get(`/api/v1/invoices/${id}`)
    .auth(token, { type: 'bearer' });
  expect(stored.body.data.paidMinor).toBe(5310000);
});

test.each([
  { status: 'Cancelled' },
  { invoiceDate: '2099-01-01', dueDate: '2099-01-02' },
])('invalid Paid transitions leave no payment behind: %j', async (fields) => {
  const created = await request(app)
    .post('/api/v1/invoices')
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send({ ...invoice, ...fields });
  expect(created.status).toBe(201);
  const id = created.body.data._id;
  const result = await request(app)
    .put(`/api/v1/invoices/${id}`)
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send({ ...invoice, ...fields, status: 'Paid' });
  expect([400, 409]).toContain(result.status);
  const { FinancePayment } = await import('../src/models/Finance.js');
  expect(await FinancePayment.countDocuments({ invoice: id })).toBe(0);
});
