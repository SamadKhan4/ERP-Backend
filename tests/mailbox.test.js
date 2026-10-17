import { beforeAll, afterAll, test, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
const mocks = vi.hoisted(() => ({
  verify: vi.fn(async () => true),
  send: vi.fn(async () => ({ accepted: ['client@example.test'] })),
  append: vi.fn(async () => ({ uid: 2 })),
  flags: vi.fn(async () => true),
  move: vi.fn(async () => ({ destination: 'Archive' })),
  fetch: vi.fn(),
}));
vi.mock('../src/mailbox/mailProvider.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    testMailbox: mocks.verify,
    smtpClient: () => ({ sendMail: mocks.send, close: () => {} }),
    withImap: async (account, fn) =>
      fn({
        mailbox: { uidValidity: '1', uidNext: 2, exists: 1 },
        getMailboxLock: async () => ({ release: () => {} }),
        fetchOne: async () => ({ uid: 1 }),
        messageFlagsAdd: mocks.flags,
        messageFlagsRemove: mocks.flags,
        messageMove: mocks.move,
        messageDelete: async () => true,
        append: mocks.append,
        search: async () => [],
        list: async () => [
          { path: 'Sent', specialUse: '\\Sent', flags: new Set() },
        ],
      }),
  };
});
let db,
  app,
  users = {},
  tokens = {},
  accounts = {},
  messages = {},
  shared;
const origin = 'http://localhost:5173';
const call = (
  method,
  path,
  actor = 'a',
  body,
  key = 'mailbox_request_key_12345',
) => {
  const agent = request(app);
  return agent[method](`/api/v1/mail${path}`)
    .set('Origin', origin)
    .set('Idempotency-Key', key)
    .auth(tokens[actor], { type: 'bearer' })
    .send(body);
};
beforeAll(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: db.getUri(),
    CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 'm'.repeat(64),
    JWT_REFRESH_SECRET: 'n'.repeat(64),
    COOKIE_SECURE: 'false',
    MAIL_DELIVERY: 'disabled',
    MAIL_ALLOWED_DOMAIN: 'adbornsolutions.com',
    MAIL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    MAIL_SYNC_ENABLED: 'false',
  });
  ({ app } = await import('../src/app.js'));
  await mongoose.connect(db.getUri());
  await Promise.all(
    Object.values(mongoose.models).map((Model) => Model.init()),
  );
  const { issueSession } = await import('../src/services/tokenService.js');
  for (const [name, role] of Object.entries({
    a: 'employee',
    b: 'employee',
    admin: 'admin',
    super: 'super_admin',
  })) {
    users[name] = await mongoose.model('User').create({
      name,
      email: `${name}@adbornsolutions.com`,
      role,
      passwordHash: 'unused',
    });
    tokens[name] = (await issueSession(users[name])).accessToken;
  }
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  await db?.stop();
});
test('connection validates immutable ownership and encrypts credentials without disclosure', async () => {
  for (const actor of ['a', 'b']) {
    const r = await call('post', '/accounts/connect', actor, {
      emailAddress: users[actor].email,
      password: 'Provider-password!',
      type: 'PERSONAL',
    });
    expect(r.status, r.text).toBe(201);
    accounts[actor] = r.body.data;
    expect(r.text).not.toContain('Provider-password');
    expect(r.text).not.toContain('encryptedPassword');
    const stored = await mongoose
      .model('MailAccount')
      .findById(accounts[actor]._id)
      .select('+encryptedPassword');
    expect(stored.encryptedPassword).not.toContain('Provider-password');
    const { decryptMailSecret } = await import('../src/mailbox/mailCrypto.js');
    expect(decryptMailSecret(stored.encryptedPassword)).toBe(
      'Provider-password!',
    );
    expect(() =>
      decryptMailSecret(stored.encryptedPassword + 'tampered'),
    ).toThrow();
  }
  expect(
    (
      await call('post', '/accounts/connect', 'a', {
        emailAddress: users.b.email,
        password: 'wrong',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('post', '/accounts/connect', 'admin', {
        emailAddress: users.b.email,
        password: 'wrong',
        type: 'SHARED',
      })
    ).status,
  ).toBe(403);
  for (const actor of ['a', 'b'])
    messages[actor] = await mongoose.model('MailMessage').create({
      mailAccount: accounts[actor]._id,
      uid: 1,
      uidValidity: '1',
      folder: 'INBOX',
      folderKind: 'INBOX',
      messageIdHeader: `<${actor}@example.test>`,
      threadKey: actor.repeat(64),
      from: { address: 'sender@example.test', name: 'Sender' },
      to: [{ address: users[actor].email }],
      subject: `Private ${actor} subject`,
      textBody: `Private ${actor} body`,
      htmlBody:
        '<p>Hello</p><script>alert(1)</script><img src="https://tracker.test/pixel"><a href="javascript:alert(1)">bad</a>',
      isRead: false,
      providerPresent: true,
      isDraft: false,
      attachments: [
        {
          fileName: 'private.pdf',
          mime: 'application/pdf',
          size: 12,
          partIndex: 0,
        },
      ],
      receivedAt: new Date(),
      linkedProject: new mongoose.Types.ObjectId(),
    });
});
test('direct APIs deny cross-user content, metadata, search, drafts, threads, downloads and operations for employee/admin/super', async () => {
  const b = accounts.b._id,
    m = messages.b._id,
    attachment = messages.b.attachments[0]._id;
  for (const actor of ['a', 'admin', 'super']) {
    for (const path of [
      `/accounts/${b}`,
      `/messages?mailAccountId=${b}&folder=DRAFTS`,
      `/messages?mailAccountId=${b}&search=Private`,
      `/messages/${m}`,
      `/messages/${m}/html`,
      `/messages/${m}/related`,
      `/attachments/${m}/${attachment}`,
      `/threads/${'b'.repeat(64)}?mailAccountId=${b}`,
    ]) {
      const r = await call('get', path, actor);
      expect(r.status, `${actor} ${path}: ${r.text}`).toBe(403);
      expect(r.text).not.toContain('Private b');
    }
    for (const [path, body] of [
      [`/accounts/${b}/sync`, {}],
      [
        `/messages/${m}/reply`,
        {
          mailAccountId: b,
          to: ['client@example.test'],
          subject: 'x',
          text: 'x',
        },
      ],
      [
        `/messages/${m}/forward`,
        { mailAccountId: b, to: ['client@example.test'], text: 'x' },
      ],
      [`/send`, { mailAccountId: b, to: ['client@example.test'], text: 'x' }],
      [`/drafts`, { mailAccountId: b, to: [], text: 'x' }],
      [`/messages/${m}/archive`, {}],
      [
        `/messages/${m}/link`,
        { links: { project: String(new mongoose.Types.ObjectId()) } },
      ],
    ])
      expect(
        (await call('post', path, actor, body)).status,
        `${actor}: ${path}`,
      ).toBe(403);
    expect(
      (await call('patch', `/messages/${m}/star`, actor, { value: true }))
        .status,
    ).toBe(403);
    expect((await call('get', '/messages', actor)).text).not.toContain(
      'Private b',
    );
  }
  expect((await call('get', '/messages?userId=' + users.b._id)).status).toBe(
    400,
  );
});
test('owner mail is scoped; HTML blocks execution and remote images by default; admin metadata has no contents', async () => {
  let r = await call('get', `/messages/${messages.a._id}`);
  expect(r.status, r.text).toBe(200);
  expect(r.body.data.textBody).toBe('Private a body');
  expect(r.body.data.htmlBody).not.toMatch(/script|<img|javascript:/);
  r = await call('get', `/messages/${messages.a._id}/html?remote=true`);
  expect(r.body.data.html).toContain('<img');
  expect(r.body.data.html).not.toMatch(/script|javascript:/);
  r = await call('get', '/admin/accounts', 'admin');
  expect(r.status).toBe(200);
  expect(r.text).not.toMatch(
    /Private|encryptedPassword|signature|messageCount/,
  );
  expect(
    (
      await call('patch', `/messages/${messages.a._id}/read`, 'a', {
        value: true,
      })
    ).status,
  ).toBe(200);
  expect(mocks.flags).toHaveBeenCalled();
});
test('shared grants are explicit; READ cannot send; SEND cannot read or manage grants; admins are not implicit members', async () => {
  let r = await call('post', '/accounts/connect', 'admin', {
    emailAddress: 'sales@adbornsolutions.com',
    password: 'SharedPassword!',
    type: 'SHARED',
  });
  expect(r.status, r.text).toBe(201);
  shared = r.body.data;
  expect((await call('get', `/accounts/${shared._id}`, 'admin')).status).toBe(
    403,
  );
  expect((await call('get', `/accounts/${shared._id}`, 'super')).status).toBe(
    403,
  );
  expect(
    (
      await call('put', `/admin/accounts/${accounts.a._id}/access`, 'admin', {
        user: String(users.b._id),
        permissions: ['READ'],
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('put', `/admin/accounts/${shared._id}/access`, 'admin', {
        user: String(users.a._id),
        permissions: ['READ'],
      })
    ).status,
  ).toBe(200);
  expect((await call('get', `/accounts/${shared._id}`)).status).toBe(200);
  expect(
    (
      await call('post', '/send', 'a', {
        mailAccountId: shared._id,
        to: ['client@example.test'],
        subject: 'Shared',
        text: 'No send permission',
      })
    ).status,
  ).toBe(403);
  await call('put', `/admin/accounts/${shared._id}/access`, 'admin', {
    user: String(users.b._id),
    permissions: ['SEND'],
  });
  expect(
    (await call('get', `/messages?mailAccountId=${shared._id}`, 'b')).status,
  ).toBe(403);
  expect(
    (
      await call('put', `/admin/accounts/${shared._id}/access`, 'b', {
        user: String(users.b._id),
        permissions: ['READ', 'SEND'],
      })
    ).status,
  ).toBe(403);
});
test('SMTP sender is derived, send is idempotent, queued authorization is rechecked, and injection is rejected', async () => {
  const body = {
    mailAccountId: accounts.a._id,
    to: ['client@example.test'],
    subject: 'Actual own mailbox',
    text: 'Body for the provider',
  };
  let r = await call('post', '/send', 'a', { ...body, from: users.b.email });
  expect(r.status).toBe(400);
  expect(
    (
      await call('post', '/send', 'a', {
        ...body,
        subject: 'x\r\nBcc: other@example.test',
      })
    ).status,
  ).toBe(400);
  r = await call('post', '/send', 'a', body, 'mail_send_unique_key_1111');
  expect(r.status, r.text).toBe(202);
  const job = r.body.data;
  expect(
    (await call('post', '/send', 'a', body, 'mail_send_unique_key_1111')).body
      .data._id,
  ).toBe(job._id);
  const { runMailSend } = await import('../src/mailbox/mailSendService.js');
  await runMailSend();
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0][0].envelope.from).toBe(users.a.email);
  expect(mocks.send.mock.calls[0][0].raw.toString()).toContain(
    'From: a@adbornsolutions.com',
  );
  expect(
    (await mongoose.model('MailSendJob').findById(job._id).select('+payload'))
      .payload,
  ).toBeUndefined();
  await call('put', `/admin/accounts/${shared._id}/access`, 'admin', {
    user: String(users.a._id),
    permissions: ['READ', 'SEND'],
  });
  r = await call(
    'post',
    '/send',
    'a',
    { ...body, mailAccountId: shared._id },
    'mail_send_revoked_key_2222',
  );
  expect(r.status, r.text).toBe(202);
  await call('put', `/admin/accounts/${shared._id}/access`, 'admin', {
    user: String(users.a._id),
    permissions: [],
    active: false,
  });
  await runMailSend();
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(
    (await mongoose.model('MailSendJob').findById(r.body.data._id)).status,
  ).toBe('FAILED');
});
test('account disabling blocks personal access without changing ownership or delegating content', async () => {
  expect(
    (
      await call('patch', `/admin/accounts/${accounts.a._id}`, 'admin', {
        isActive: false,
      })
    ).status,
  ).toBe(200);
  expect((await call('get', `/messages/${messages.a._id}`)).status).toBe(409);
  const stored = await mongoose.model('MailAccount').findById(accounts.a._id);
  expect(String(stored.user)).toBe(String(users.a._id));
  expect(
    await mongoose.model('MailMessage').exists({ _id: messages.a._id }),
  ).toBeTruthy();
  expect(
    (await call('get', `/messages/${messages.a._id}`, 'super')).status,
  ).toBe(403);
});
test('linking a personal message to a shared project never grants project collaborators mailbox content', async () => {
  const project = await mongoose.model('Project').create({
    projectId: 'MAIL-PROJECT-1',
    title: 'Shared operational project',
    assignedTo: users.b._id,
    teamMembers: [
      { employee: users.a._id, status: 'ACTIVE' },
      { employee: users.b._id, status: 'ACTIVE' },
    ],
    createdBy: users.b._id,
  });
  const r = await call('post', `/messages/${messages.b._id}/link`, 'b', {
    links: { project: String(project._id) },
  });
  expect(r.status, r.text).toBe(200);
  const activity = await mongoose
    .model('AuditLog')
    .find({ entityType: 'project', entityId: project._id })
    .lean();
  expect(activity.some((a) => a.action === 'project.EMAIL_LINKED')).toBe(true);
  expect(JSON.stringify(activity)).not.toMatch(
    /Private b|sender@example|client@example/,
  );
  expect((await call('get', `/messages/${messages.b._id}`, 'a')).status).toBe(
    403,
  );
  expect(
    (await call('get', `/messages/${messages.b._id}/related`, 'a')).status,
  ).toBe(403);
  expect(
    (await call('get', `/messages/${messages.b._id}/related`, 'b')).body.data
      .project.name,
  ).toBe(project.title);
});
