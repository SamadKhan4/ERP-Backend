import { afterAll, beforeAll, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';

let database, app, User, token;
const origin = 'http://localhost:5173';
const quotation = {
  services: ['web', 'seo'],
  title: 'Website Development',
  client: {
    company: 'Acme Private Limited',
    contactPerson: 'Aman Verma',
    contactNumber: '+91 9876543210',
    email: 'aman@acme.example',
  },
  items: [
    { service: 'web', description: 'Responsive website', amount: 20000 },
    { service: 'seo', description: 'SEO optimization', amount: 15000 },
  ],
  terms: ['Advance payment is required.'],
  gstRate: 18,
  status: 'Draft',
};

beforeAll(async () => {
  database = await MongoMemoryServer.create();
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
    name: 'Quotation Admin',
    email: 'quotation@example.test',
    passwordHash: await bcrypt.hash('QuotationPassword123', 12),
    role: 'admin',
  });
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ email: admin.email, password: 'QuotationPassword123' });
  token = login.body.data.accessToken;
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

test('quotation CRUD calculates totals and produces the branded PDF', async () => {
  const created = await request(app)
    .post('/api/v1/quotations')
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send(quotation);
  expect(created.status).toBe(201);
  expect(created.body.data.quotationNumber).toMatch(/^ADB-Q-\d{4}-0001$/);
  expect(created.body.data.services).toEqual(['web', 'seo']);
  expect(created.body.data.subtotal).toBe(35000);
  expect(created.body.data.gstAmount).toBe(6300);
  expect(created.body.data.grandTotal).toBe(41300);
  const id = created.body.data._id;

  const listed = await request(app)
    .get('/api/v1/quotations?search=Acme')
    .auth(token, { type: 'bearer' });
  expect(listed.status).toBe(200);
  expect(listed.body.data.items).toHaveLength(1);

  const updated = await request(app)
    .put(`/api/v1/quotations/${id}`)
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send({ ...quotation, status: 'Sent', gstRate: 0 });
  expect(updated.status).toBe(200);
  expect(updated.body.data.grandTotal).toBe(35000);

  const pdf = await request(app)
    .get(`/api/v1/quotations/${id}/download`)
    .auth(token, { type: 'bearer' });
  expect(pdf.status).toBe(200);
  expect(pdf.headers['content-type']).toContain('application/pdf');
  expect(pdf.headers['content-disposition']).toContain('.pdf');

  const archived = await request(app)
    .delete(`/api/v1/quotations/${id}`)
    .set('Origin', origin)
    .auth(token, { type: 'bearer' });
  expect(archived.status).toBe(200);
  expect(
    (
      await request(app)
        .get('/api/v1/quotations')
        .auth(token, { type: 'bearer' })
    ).body.data.items,
  ).toHaveLength(0);
});

test('quotation accepts blank or omitted email and rejects malformed email', async () => {
  for (const email of ['', undefined]) {
    const payload = { ...quotation, client: { ...quotation.client, email } };
    const result = await request(app)
      .post('/api/v1/quotations')
      .set('Origin', origin)
      .auth(token, { type: 'bearer' })
      .send(payload);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.data.client.email).toBe('');
  }
  const invalid = await request(app)
    .post('/api/v1/quotations')
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send({
      ...quotation,
      client: { ...quotation.client, email: 'invalid-email' },
    });
  expect(invalid.status).toBe(400);
});

test('custom services retain manual totals independently of optional row amounts', async () => {
  const payload = {
    ...quotation,
    services: ['Brand strategy', 'Launch support'],
    serviceTotals: [
      { service: 'Brand strategy', total: 12500 },
      { service: 'Launch support', total: 0 },
    ],
    items: [
      { service: 'Brand strategy', description: 'Discovery workshop' },
      { service: 'Launch support', description: 'Launch review', amount: 0 },
    ],
  };
  payload.items.unshift(
    ...Array.from({ length: 12 }, (_, index) => ({
      service: 'Brand strategy',
      description: `Extra row ${index + 1}`,
    })),
  );
  const created = await request(app)
    .post('/api/v1/quotations')
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send(payload);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.serviceTotals).toEqual(payload.serviceTotals);
  expect(created.body.data.items[0]).not.toHaveProperty('amount');
  expect(created.body.data.items).toHaveLength(14);
  expect(created.body.data.items.at(-1).amount).toBe(0);
  const updated = await request(app)
    .put(`/api/v1/quotations/${created.body.data._id}`)
    .set('Origin', origin)
    .auth(token, { type: 'bearer' })
    .send({
      ...payload,
      services: ['Campaign planning'],
      items: [
        { service: 'Campaign planning', description: 'Planning', amount: 10 },
      ],
      serviceTotals: [{ service: 'Campaign planning', total: 9000 }],
    });
  expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  expect(updated.body.data.services).toEqual(['Campaign planning']);
  expect(updated.body.data.serviceTotals).toEqual([
    { service: 'Campaign planning', total: 9000 },
  ]);
  for (const serviceTotals of [
    [{ service: 'Brand strategy', total: -1 }],
    [{ service: 'Brand strategy', total: 1 }],
    [
      { service: 'Unknown service', total: 1 },
      { service: 'Launch support', total: 2 },
    ],
  ]) {
    const invalid = await request(app)
      .post('/api/v1/quotations')
      .set('Origin', origin)
      .auth(token, { type: 'bearer' })
      .send({ ...payload, serviceTotals });
    expect(invalid.status).toBe(400);
  }
});
