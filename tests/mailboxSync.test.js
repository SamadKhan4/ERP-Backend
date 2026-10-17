import { beforeAll, afterAll, test, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
const state = vi.hoisted(() => ({ boxes: new Map(), calls: 0 }));
vi.mock('../src/mailbox/mailProvider.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    withImap: async (account, fn) => {
      state.calls++;
      const box = state.boxes.get(String(account._id));
      const client = {
        mailbox: {},
        list: async () => [{ path: 'INBOX', flags: new Set() }],
        getMailboxLock: async () => {
          client.mailbox = {
            uidValidity: box.validity,
            uidNext: box.uidNext,
            exists: box.items.length,
          };
          return { release() {} };
        },
        fetch: async function* (range, query, options) {
          const [start, end] = String(range).split(':').map(Number);
          const items = options?.uid
            ? box.items.filter((r) => r.uid >= start && r.uid <= end)
            : box.items.slice(start - 1, end);
          for (const item of items)
            yield {
              uid: item.uid,
              id: `provider-${item.uid}`,
              flags: item.flags || new Set(),
              envelope: {
                subject: item.subject,
                messageId: item.header,
                from: [{ address: 'sender@example.test' }],
              },
              internalDate: new Date(),
              size: item.raw.length,
            };
        },
        fetchOne: async (uid) => {
          const item = box.items.find((r) => r.uid === uid);
          return item ? { uid, source: item.raw } : false;
        },
      };
      return fn(client);
    },
  };
});
let db,
  accounts = [],
  syncAccount;
const raw = (id, text, refs = '') =>
  Buffer.from(
    `From: Sender <sender@example.test>\r\nTo: Employee <a@adbornsolutions.com>\r\nSubject: Actual incoming ${id}\r\nMessage-ID: <${id}@mail.test>\r\n${refs ? `In-Reply-To: <${refs}@mail.test>\r\nReferences: <${refs}@mail.test>\r\n` : ''}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`,
  );
beforeAll(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: db.getUri(),
    CLIENT_URL: 'http://localhost:5173',
    JWT_ACCESS_SECRET: 'r'.repeat(64),
    JWT_REFRESH_SECRET: 's'.repeat(64),
    MAIL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    MAIL_SYNC_ENABLED: 'true',
    MAIL_DELIVERY: 'disabled',
  });
  await import('../src/app.js');
  await mongoose.connect(db.getUri());
  await Promise.all(Object.values(mongoose.models).map((M) => M.init()));
  const { encryptMailSecret } = await import('../src/mailbox/mailCrypto.js');
  ({ syncAccount } = await import('../src/mailbox/mailSyncService.js'));
  for (const name of ['a', 'b']) {
    const user = await mongoose
      .model('User')
      .create({
        name,
        email: `${name}@adbornsolutions.com`,
        role: 'employee',
        passwordHash: 'unused',
      });
    const account = await mongoose
      .model('MailAccount')
      .create({
        user: user._id,
        emailAddress: user.email,
        type: 'PERSONAL',
        encryptedPassword: encryptMailSecret('Secret!'),
      });
    accounts.push(account);
    state.boxes.set(String(account._id), {
      validity: '1',
      uidNext: 2,
      items: [
        {
          uid: 1,
          header: 'root',
          raw: raw('root', `Private ${name} incoming`),
        },
      ],
    });
  }
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  await db?.stop();
});
test('incremental sync keeps equal provider UIDs isolated, preserves threading and avoids duplicate cache rows', async () => {
  for (const a of accounts) await syncAccount(a);
  const Model = mongoose.model('MailMessage');
  expect(await Model.countDocuments()).toBe(2);
  const a = await Model.findOne({ mailAccount: accounts[0]._id }).select(
    '+textBody',
  );
  const b = await Model.findOne({ mailAccount: accounts[1]._id }).select(
    '+textBody',
  );
  expect(a.textBody).toBe('Private a incoming');
  expect(b.textBody).toBe('Private b incoming');
  expect(a.threadKey).not.toBe(b.threadKey);
  const box = state.boxes.get(String(accounts[0]._id));
  box.items.push({
    uid: 2,
    header: 'reply',
    raw: raw('reply', 'Actual reply', 'root'),
  });
  box.uidNext = 3;
  await syncAccount(accounts[0]);
  await syncAccount(accounts[0]);
  expect(await Model.countDocuments({ mailAccount: accounts[0]._id })).toBe(2);
  const reply = await Model.findOne({ mailAccount: accounts[0]._id, uid: 2 });
  expect(reply.threadKey).toBe(a.threadKey);
});
test('provider flag changes, expunges and UIDVALIDITY resets reconcile without exposing stale content', async () => {
  const box = state.boxes.get(String(accounts[0]._id));
  box.items[0].flags = new Set(['\\Seen', '\\Flagged']);
  box.items = box.items.filter((r) => r.uid === 1);
  await new Promise((r) => setTimeout(r, 5));
  await syncAccount(accounts[0]);
  const Model = mongoose.model('MailMessage');
  expect(
    (await Model.findOne({ mailAccount: accounts[0]._id, uid: 1 })).isStarred,
  ).toBe(true);
  expect(
    (await Model.findOne({ mailAccount: accounts[0]._id, uid: 2 }))
      .providerPresent,
  ).toBe(false);
  box.validity = '2';
  box.uidNext = 2;
  box.items = [
    { uid: 1, header: 'fresh', raw: raw('fresh', 'New validity message') },
  ];
  await syncAccount(accounts[0]);
  const visible = await Model.find({
    mailAccount: accounts[0]._id,
    providerPresent: true,
  }).select('+textBody');
  expect(visible).toHaveLength(1);
  expect(visible[0].textBody).toBe('New validity message');
});
test('authentication errors stop retries and notify only the personal owner', async () => {
  const { syncFailure, runMailboxSync } =
    await import('../src/mailbox/mailSyncService.js');
  const { AppError } = await import('../src/utils/errors.js');
  await syncFailure(accounts[0], new AppError(422, 'Authentication failed'));
  expect(
    (await mongoose.model('MailAccount').findById(accounts[0]._id)).syncStatus,
  ).toBe('REAUTH_REQUIRED');
  const notifications = await mongoose
    .model('Notification')
    .find({ entityId: accounts[0]._id });
  expect(notifications).toHaveLength(1);
  expect(String(notifications[0].recipient)).toBe(String(accounts[0].user));
  const before = state.calls;
  await mongoose
    .model('MailAccount')
    .updateMany({}, { $set: { nextSyncAt: new Date(Date.now() + 3600000) } });
  await runMailboxSync();
  expect(state.calls).toBe(before);
});
