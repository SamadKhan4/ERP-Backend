import { afterAll, beforeAll, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';

let database, app, User, token;
const origin = 'http://localhost:5173';
const invoice = {
  invoiceDate: '2026-10-15', dueDate: '2026-10-30',
  client: { company: 'Acme Private Limited', contactPerson: 'Aman Verma', address: 'Nagpur, Maharashtra', contactNumber: '+91 9876543210', email: 'aman@acme.example' },
  paymentDetails: { bankName: 'Example Bank', accountNumber: '1234567890', ifscCode: 'EXAM0001234', branch: 'Nagpur' },
  items: [{ title: 'Website Development', amount: 35000 }, { title: 'SEO Services', amount: 10000 }],
  gstRate: 18, status: 'Draft',
};

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: database.getUri(), CLIENT_URL: origin, JWT_ACCESS_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64), COOKIE_SECURE: 'false', COOKIE_SAME_SITE: 'lax', RESET_DELIVERY: 'file' });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  await mongoose.connect(database.getUri());
  const admin = await User.create({ name: 'Invoice Admin', email: 'invoice@example.test', passwordHash: await bcrypt.hash('InvoicePassword123', 12), role: 'admin' });
  const login = await request(app).post('/api/v1/auth/login').set('Origin', origin).send({ email: admin.email, password: 'InvoicePassword123' });
  token = login.body.data.accessToken;
}, 120000);

afterAll(async () => { await mongoose.disconnect(); await database?.stop(); });

test('invoice CRUD calculates totals and produces the branded PDF', async () => {
  const created = await request(app).post('/api/v1/invoices').set('Origin', origin).auth(token, { type: 'bearer' }).send(invoice);
  expect(created.status).toBe(201);
  expect(created.body.data.invoiceNumber).toMatch(/^ADB-INV-\d{4}-0001$/);
  expect(created.body.data.subtotal).toBe(45000);
  expect(created.body.data.gstAmount).toBe(8100);
  expect(created.body.data.grandTotal).toBe(53100);
  const id = created.body.data._id;

  const listed = await request(app).get('/api/v1/invoices?search=Acme').auth(token, { type: 'bearer' });
  expect(listed.status).toBe(200);
  expect(listed.body.data.items).toHaveLength(1);

  const updated = await request(app).put(`/api/v1/invoices/${id}`).set('Origin', origin).auth(token, { type: 'bearer' }).send({ ...invoice, status: 'Sent', gstRate: 0 });
  expect(updated.status).toBe(200);
  expect(updated.body.data.grandTotal).toBe(45000);

  const pdf = await request(app).get(`/api/v1/invoices/${id}/download`).auth(token, { type: 'bearer' });
  expect(pdf.status).toBe(200);
  expect(pdf.headers['content-type']).toContain('application/pdf');

  expect((await request(app).delete(`/api/v1/invoices/${id}`).set('Origin', origin).auth(token, { type: 'bearer' })).status).toBe(200);
  expect((await request(app).get('/api/v1/invoices').auth(token, { type: 'bearer' })).body.data.items).toHaveLength(0);
});


test('invoice accepts blank or omitted email and rejects malformed email', async () => {
  for (const email of ['', undefined]) {
    const payload = { ...invoice, client: { ...invoice.client, email } };
    const result = await request(app).post('/api/v1/invoices').set('Origin', origin).auth(token, { type: 'bearer' }).send(payload);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.data.client.email).toBe('');
  }
  const invalid = await request(app).post('/api/v1/invoices').set('Origin', origin).auth(token, { type: 'bearer' }).send({ ...invoice, client: { ...invoice.client, email: 'invalid-email' } });
  expect(invalid.status).toBe(400);
});
