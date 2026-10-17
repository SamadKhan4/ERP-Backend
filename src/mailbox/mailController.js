import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  MailAccount,
  MailMessage,
  SharedMailboxAccess,
  MailSendJob,
} from '../models/Mailbox.js';
import { User } from '../models/User.js';
import { AuditLog } from '../models/AuditLog.js';
import { AppError } from '../utils/errors.js';
import { env } from '../config/env.js';
import { connectSchema, parseCompose, attachment } from './mailValidator.js';
import { encryptMailSecret } from './mailCrypto.js';
import {
  authorizeAccount,
  authorizeMessage,
  allowedAccounts,
  accountView,
  hasMail,
  id,
} from './mailAccess.js';
import { sharedOperations } from './mailPermissions.js';
import {
  testMailbox,
  acquireAccount,
  withImap,
  loadSource,
  parseMail,
  safeHtml,
  folderFor,
  upsertProviderMessage,
} from './mailProvider.js';
import {
  enqueueSend,
  rawMessage,
  originalAttachments,
} from './mailSendService.js';
import {
  validateLinks,
  recordMailLinks,
  contactSearch,
} from './mailBusinessService.js';
const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });
const audit = (req, action, account, details = {}) =>
  AuditLog.create({
    user: req.user._id,
    action: `mail.${action}`,
    entityType: 'mailAccount',
    entityId: account._id,
    details,
  });
export async function accounts(req, res) {
  const shared = await SharedMailboxAccess.find({
    user: req.user._id,
    active: true,
  }).lean();
  const rows = await MailAccount.find({
    $or: [
      { type: 'PERSONAL', user: req.user._id },
      ...(hasMail(req, 'shared.use')
        ? [{ type: 'SHARED', _id: { $in: shared.map((r) => r.mailAccount) } }]
        : []),
    ],
  }).sort({ isDefault: -1, emailAddress: 1 });
  ok(res, {
    items: rows.map((r) =>
      accountView(
        r,
        r.type === 'PERSONAL'
          ? sharedOperations
          : shared.find((s) => String(s.mailAccount) === String(r._id))
              ?.permissions || [],
      ),
    ),
    permissions: req.mailPermissions,
    configured: Boolean(env.MAIL_CREDENTIAL_ENCRYPTION_KEY),
    provider: {
      imapHost: env.MAIL_IMAP_HOST,
      imapPort: 993,
      smtpHost: env.MAIL_SMTP_HOST,
      smtpPort: 465,
      secure: true,
    },
  });
}
export async function account(req, res) {
  const row = await authorizeAccount(req, req.params.id, 'READ', {
    inactive: true,
  });
  ok(res, accountView(row));
}
export async function connect(req, res) {
  const input = connectSchema.parse(req.body);
  if (!env.MAIL_CREDENTIAL_ENCRYPTION_KEY)
    throw new AppError(
      503,
      'Mailbox encryption key must be configured by deployment admin',
    );
  if (!input.emailAddress.endsWith(`@${env.MAIL_ALLOWED_DOMAIN.toLowerCase()}`))
    throw new AppError(400, 'Use your company work email');
  if (input.type === 'PERSONAL') {
    if (!hasMail(req, 'personal.connect'))
      throw new AppError(403, 'Personal mailbox connection denied');
    if (
      await User.exists({
        email: input.emailAddress,
        _id: { $ne: req.user._id },
      })
    )
      throw new AppError(403, 'This work email belongs to another ERP user');
  } else {
    if (!hasMail(req, 'admin.accounts.manage'))
      throw new AppError(
        403,
        'Shared mailbox creation requires administrator permission',
      );
    if (await User.exists({ email: input.emailAddress }))
      throw new AppError(
        403,
        'An employee work email cannot be connected as a shared mailbox',
      );
  }
  const existing = await MailAccount.findOne({
    emailAddress: input.emailAddress,
  });
  if (
    existing &&
    (existing.type !== input.type ||
      (input.type === 'PERSONAL' && String(existing.user) !== req.user.id))
  )
    throw new AppError(409, 'Mailbox already belongs to another account');
  if (existing?.isActive && existing.syncStatus !== 'REAUTH_REQUIRED')
    throw new AppError(
      409,
      'Mailbox is already connected. Disconnect before reconnecting.',
    );
  const encryptedPassword = encryptMailSecret(input.password);
  await testMailbox(input, input.password);
  let row;
  if (existing) {
    row = await MailAccount.findOneAndUpdate(
      {
        _id: existing._id,
        isActive: existing.isActive,
        revision: existing.revision,
      },
      {
        $set: {
          encryptedPassword,
          displayName: input.displayName,
          isActive: true,
          syncStatus: 'PENDING',
          syncError: '',
          nextSyncAt: new Date(),
          attempts: 0,
          updatedBy: req.user._id,
        },
        $inc: { revision: 1 },
      },
      { new: true },
    );
    if (!row) throw new AppError(409, 'Mailbox state changed; retry');
  } else
    row = await MailAccount.create({
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      type: input.type,
      ...(input.type === 'PERSONAL' ? { user: req.user._id } : {}),
      encryptedPassword,
      createdBy: req.user._id,
    });
  await audit(req, 'connected', row, { type: row.type });
  ok(res, accountView(row), 201);
}
export async function test(req, res) {
  const account = await authorizeAccount(req, req.params.id, 'READ');
  await acquireAccount(account._id, (row) => testMailbox(row, undefined));
  ok(res, { connected: true });
}
export async function sync(req, res) {
  const account = await authorizeAccount(req, req.params.id, 'READ');
  const { older, folder } = z
    .object({
      older: z.boolean().default(false),
      folder: z
        .enum([
          'INBOX',
          'SENT',
          'DRAFTS',
          'ARCHIVE',
          'TRASH',
          'SPAM',
          'STARRED',
        ])
        .default('INBOX'),
    })
    .strict()
    .parse(req.body || {});
  if (account.syncStatus === 'REAUTH_REQUIRED')
    throw new AppError(422, 'Reconnect your mailbox first');
  await MailAccount.updateOne(
    { _id: account._id },
    {
      $set: {
        nextSyncAt: new Date(),
        backfillRequested: older,
        backfillKind: folder === 'STARRED' ? 'INBOX' : folder,
      },
    },
  );
  ok(res, { queued: true }, 202);
}
export async function disconnect(req, res) {
  const row = await authorizeAccount(req, req.params.id, 'READ', {
    inactive: true,
  });
  if (row.type !== 'PERSONAL' || !hasMail(req, 'personal.disconnect'))
    throw new AppError(403, 'Only the personal owner can disconnect here');
  await MailAccount.updateOne(
    { _id: row._id },
    {
      $set: { isActive: false, syncStatus: 'DISCONNECTED', syncError: '' },
      $unset: { encryptedPassword: '' },
      $inc: { revision: 1 },
    },
  );
  await MailSendJob.updateMany(
    { mailAccount: row._id, status: 'PENDING' },
    { $set: { status: 'CANCELLED' }, $unset: { payload: '' } },
  );
  await audit(req, 'disconnected', row);
  ok(res, { disconnected: true });
}
export async function settings(req, res) {
  const row = await authorizeAccount(req, req.params.id, 'READ');
  if (row.type === 'SHARED' && !hasMail(req, 'admin.accounts.manage'))
    throw new AppError(403, 'Shared mailbox settings require administration');
  const input = z
    .object({
      signature: z.string().max(4000),
      displayName: z
        .string()
        .trim()
        .max(120)
        .regex(/^[^\r\n]*$/),
    })
    .strict()
    .parse(req.body);
  await MailAccount.updateOne(
    { _id: row._id },
    { $set: { ...input, updatedBy: req.user._id } },
  );
  ok(res, { saved: true });
}
const listSchema = z
  .object({
    mailAccountId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    folder: z
      .enum([
        'INBOX',
        'SENT',
        'DRAFTS',
        'ARCHIVE',
        'TRASH',
        'SPAM',
        'STARRED',
        'ALL',
      ])
      .default('INBOX'),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    search: z.string().trim().max(100).default(''),
    unread: z.enum(['true', 'false']).optional(),
    label: z.string().trim().max(50).optional(),
  })
  .strict();
export async function list(req, res) {
  const q = listSchema.parse(req.query);
  let ids;
  if (q.mailAccountId) {
    await authorizeAccount(req, q.mailAccountId);
    ids = [id(q.mailAccountId)];
  } else ids = await allowedAccounts(req.user);
  if (!hasMail(req, 'shared.use'))
    ids = await MailAccount.distinct('_id', {
      _id: { $in: ids },
      type: 'PERSONAL',
      user: req.user._id,
    });
  const filter = {
    mailAccount: { $in: ids },
    providerPresent: true,
    ...(q.folder === 'STARRED'
      ? { isStarred: true }
      : q.folder === 'ALL'
        ? {}
        : { folderKind: q.folder }),
    ...(q.unread ? { isRead: q.unread !== 'true' } : {}),
    ...(q.label ? { labels: q.label } : {}),
  };
  if (q.search) {
    const regex = q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      'subject',
      'snippet',
      'from.address',
      'from.name',
      'to.address',
      'attachments.fileName',
    ].map((key) => ({ [key]: { $regex: regex, $options: 'i' } }));
  }
  const [items, total, counts] = await Promise.all([
    MailMessage.find(filter)
      .select(
        'mailAccount from to subject snippet receivedAt isRead isStarred attachments.fileName attachments.size folderKind linkedLead linkedClient linkedProject linkedQuotation linkedInvoice labels threadKey',
      )
      .sort({ receivedAt: -1, _id: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    MailMessage.countDocuments(filter),
    MailMessage.aggregate([
      { $match: { mailAccount: { $in: ids }, providerPresent: true } },
      {
        $group: {
          _id: '$folderKind',
          total: { $sum: 1 },
          unread: { $sum: { $cond: ['$isRead', 0, 1] } },
        },
      },
    ]),
  ]);
  ok(res, {
    items,
    total,
    page: q.page,
    totalPages: Math.ceil(total / q.limit),
    counts,
  });
}
export async function message(req, res) {
  const { row } = await authorizeMessage(req, req.params.id);
  const output = row.toObject();
  output.htmlBody = safeHtml(output.htmlBody, false);
  const activity = await AuditLog.find({
    entityType: 'mailMessage',
    entityId: row._id,
    user: req.user._id,
  })
    .select('action createdAt')
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  ok(res, { ...output, activity });
}
export async function html(req, res) {
  const { row } = await authorizeMessage(req, req.params.id);
  const { remote } = z
    .object({ remote: z.enum(['true', 'false']).default('false') })
    .strict()
    .parse(req.query);
  ok(res, { html: safeHtml(row.htmlBody, remote === 'true') });
}
export async function thread(req, res) {
  const { mailAccountId } = z
    .object({ mailAccountId: z.string().regex(/^[a-f\d]{24}$/i) })
    .strict()
    .parse(req.query);
  await authorizeAccount(req, mailAccountId);
  if (!/^[a-f\d]{64}$/.test(req.params.key))
    throw new AppError(400, 'Invalid thread');
  const rows = await MailMessage.find({
    mailAccount: id(mailAccountId),
    threadKey: req.params.key,
    providerPresent: true,
  })
    .select('subject from to receivedAt folderKind')
    .sort({ receivedAt: 1 })
    .limit(100)
    .lean();
  ok(res, { items: rows });
}
export async function send(req, res) {
  ok(res, await enqueueSend(req, parseCompose(req), 'SEND'), 202);
}
export async function reply(req, res) {
  const { row } = await authorizeMessage(req, req.params.id, 'REPLY');
  const input = parseCompose(req);
  if (input.mailAccountId !== String(row.mailAccount))
    throw new AppError(403, 'Sender mailbox does not match the source');
  input.sourceMessage = String(row._id);
  if (req.params.mode === 'reply-all' && !input.to.length) {
    const own = (await authorizeAccount(req, row.mailAccount, 'REPLY'))
      .emailAddress;
    input.to = [
      ...new Set(
        [
          ...(row.replyTo.length ? row.replyTo : [row.from]),
          ...row.to,
          ...row.cc,
        ]
          .filter((a) => a?.address && a.address !== own)
          .map((a) => a.address),
      ),
    ];
  }
  ok(res, await enqueueSend(req, input, 'REPLY'), 202);
}
export async function forward(req, res) {
  const { row } = await authorizeMessage(req, req.params.id, 'FORWARD');
  const input = parseCompose(req);
  if (input.mailAccountId !== String(row.mailAccount))
    throw new AppError(403, 'Sender mailbox does not match the source');
  input.sourceMessage = String(row._id);
  ok(res, await enqueueSend(req, input, 'FORWARD'), 202);
}
export async function jobs(req, res) {
  const { mailAccountId } = z
    .object({ mailAccountId: z.string().regex(/^[a-f\d]{24}$/i) })
    .strict()
    .parse(req.query);
  await authorizeAccount(req, mailAccountId, 'SEND');
  ok(res, {
    items: await MailSendJob.find({
      mailAccount: id(mailAccountId),
      user: req.user._id,
    })
      .select('status sentAt lastError createdAt sentCopySaved')
      .sort({ createdAt: -1 })
      .limit(30)
      .lean(),
  });
}
export async function flags(req, res) {
  const { row, account } = await authorizeMessage(req, req.params.id);
  const value = z.object({ value: z.boolean() }).strict().parse(req.body).value;
  await acquireAccount(account._id, (locked) =>
    withImap(locked, async (client) => {
      const lock = await client.getMailboxLock(row.folder);
      try {
        if (
          String(client.mailbox.uidValidity) !== row.uidValidity ||
          !(await client.fetchOne(row.uid, { uid: true }, { uid: true }))
        )
          throw new AppError(404, 'Message removed at provider');
        const flag = req.params.flag === 'read' ? '\\Seen' : '\\Flagged';
        await client[value ? 'messageFlagsAdd' : 'messageFlagsRemove'](
          row.uid,
          [flag],
          { uid: true },
        );
        row[req.params.flag === 'read' ? 'isRead' : 'isStarred'] = value;
        await row.save();
      } finally {
        lock.release();
      }
    }),
  );
  ok(res, { updated: true });
}
export async function move(req, res) {
  const action = req.params.action.toUpperCase();
  const { row, account } = await authorizeMessage(
    req,
    req.params.id,
    action === 'ARCHIVE' ? 'ARCHIVE' : 'TRASH',
  );
  await acquireAccount(account._id, (locked) =>
    withImap(locked, async (client) => {
      const destination = await folderFor(
        client,
        account._id,
        action === 'ARCHIVE'
          ? 'ARCHIVE'
          : action === 'SPAM'
            ? 'SPAM'
            : action === 'RESTORE'
              ? 'INBOX'
              : 'TRASH',
      );
      const lock = await client.getMailboxLock(row.folder);
      try {
        if (String(client.mailbox.uidValidity) !== row.uidValidity)
          throw new AppError(404, 'Message removed at provider');
        const result = await client.messageMove(row.uid, destination.path, {
          uid: true,
        });
        if (!result) throw new AppError(404, 'Message removed at provider');
        await MailMessage.updateOne(
          { _id: row._id, mailAccount: account._id },
          { $set: { providerPresent: false } },
        );
        await MailAccount.updateOne(
          { _id: account._id },
          { $set: { nextSyncAt: new Date() } },
        );
      } finally {
        lock.release();
      }
    }),
  );
  await audit(req, 'moved', account, { action });
  ok(res, { moved: true });
}
export async function download(req, res) {
  const { row, account } = await authorizeMessage(req, req.params.id);
  if (!hasMail(req, 'download_attachment'))
    throw new AppError(403, 'Attachment download denied');
  const part = row.attachments.id(id(req.params.attachmentId));
  if (!part) throw new AppError(404, 'Attachment unavailable');
  const parsed = await acquireAccount(account._id, (locked) =>
    withImap(locked, async (client) =>
      parseMail(await loadSource(client, row)),
    ),
  );
  const original = parsed.attachments[part.partIndex];
  if (!original) throw new AppError(404, 'Attachment unavailable');
  const safe = attachment({
    originalname: original.filename,
    buffer: original.content,
  });
  await audit(req, 'attachment_downloaded', account, { message: row._id });
  res
    .type('application/octet-stream')
    .set('X-Content-Type-Options', 'nosniff')
    .attachment(safe.fileName)
    .send(original.content);
}
export async function draft(req, res) {
  const input = parseCompose(req);
  if (!hasMail(req, 'compose')) throw new AppError(403, 'Compose denied');
  const account = await authorizeAccount(req, input.mailAccountId, 'SEND');
  await validateLinks(req, input.links);
  if (input.draftMessage) {
    const { row } = await authorizeMessage(req, input.draftMessage, 'SEND');
    if (!row.isDraft || String(row.mailAccount) !== String(account._id))
      throw new AppError(403, 'Draft access denied');
    input.attachments.push(...(await originalAttachments(account, row)));
    if (
      input.attachments.reduce((sum, a) => sum + (a.size || 0), 0) >
      env.MAX_FILE_SIZE
    )
      throw new AppError(
        413,
        'Combined attachments exceed configured size limit',
      );
  }
  await acquireAccount(account._id, (locked) =>
    withImap(locked, async (client) => {
      const folder = await folderFor(client, account._id, 'DRAFTS');
      const raw = await rawMessage(
        account,
        input,
        `<${randomUUID()}@${env.MAIL_ALLOWED_DOMAIN}>`,
      );
      const appended = await client.append(folder.path, raw, ['\\Draft']);
      if (appended?.uid && appended.uidValidity) {
        const row = await upsertProviderMessage(
          account,
          {
            path: folder.path,
            uidValidity: String(appended.uidValidity),
            kind: 'DRAFTS',
          },
          {
            uid: appended.uid,
            flags: new Set(['\\Draft']),
            internalDate: new Date(),
          },
          raw,
        );
        for (const [kind, value] of Object.entries(input.links))
          row[`linked${kind[0].toUpperCase() + kind.slice(1)}`] = id(value);
        await row.save();
      }
      if (input.draftMessage) {
        const old = await MailMessage.findOne({
          _id: input.draftMessage,
          mailAccount: account._id,
        });
        const lock = await client.getMailboxLock(old.folder);
        try {
          if (String(client.mailbox.uidValidity) === old.uidValidity)
            await client.messageDelete(old.uid, { uid: true });
          await MailMessage.updateOne(
            { _id: old._id },
            { $set: { providerPresent: false } },
          );
        } finally {
          lock.release();
        }
      }
    }),
  );
  await MailAccount.updateOne(
    { _id: account._id },
    { $set: { nextSyncAt: new Date() } },
  );
  ok(res, { saved: true }, 201);
}
export async function link(req, res) {
  const { row } = await authorizeMessage(req, req.params.id);
  const { links } = z
    .object({
      links: z
        .object({
          lead: z.string().optional(),
          client: z.string().optional(),
          project: z.string().optional(),
          quotation: z.string().optional(),
          invoice: z.string().optional(),
        })
        .strict(),
    })
    .strict()
    .parse(req.body);
  await validateLinks(req, links);
  await recordMailLinks(req, row, links);
  ok(res, { linked: true });
}
export async function labels(req, res) {
  const { row } = await authorizeMessage(req, req.params.id);
  const { labels } = z
    .object({ labels: z.array(z.string().trim().min(1).max(40)).max(15) })
    .strict()
    .parse(req.body);
  await MailMessage.updateOne(
    { _id: row._id, mailAccount: row.mailAccount },
    { $set: { labels } },
  );
  ok(res, { saved: true });
}
export async function related(req, res) {
  const { row } = await authorizeMessage(req, req.params.id);
  const output = {};
  for (const key of ['lead', 'client', 'project', 'quotation', 'invoice']) {
    const value = row[`linked${key[0].toUpperCase() + key.slice(1)}`];
    if (!value) continue;
    try {
      const records = await validateLinks(req, { [key]: String(value) });
      const r = records[key];
      output[key] =
        key === 'invoice'
          ? { _id: r._id, name: r.invoiceNumber }
          : key === 'quotation'
            ? { _id: r._id, name: r.quotationNumber }
            : key === 'project'
              ? { _id: r._id, name: r.title, projectId: r.projectId }
              : {
                  _id: r._id,
                  name: r.companyName,
                  ...(key === 'client'
                    ? { email: r.email, phone: r.phone }
                    : {}),
                };
    } catch (error) {
      if (![403, 404].includes(error.status)) throw error;
    }
  }
  ok(res, output);
}
export async function contacts(req, res) {
  const { search } = z
    .object({ search: z.string().trim().min(2).max(100) })
    .strict()
    .parse(req.query);
  ok(res, { items: await contactSearch(req, search) });
}
export async function adminAccounts(req, res) {
  const { page } = z
    .object({ page: z.coerce.number().int().min(1).default(1) })
    .strict()
    .parse(req.query);
  const [items, total] = await Promise.all([
    MailAccount.find()
      .select(
        'user emailAddress type isActive syncStatus lastSyncAt lastSuccessfulSyncAt syncError',
      )
      .populate('user', 'name')
      .sort({ emailAddress: 1 })
      .skip((page - 1) * 30)
      .limit(30)
      .lean(),
    MailAccount.countDocuments(),
  ]);
  ok(res, { items, total, page, totalPages: Math.ceil(total / 30) });
}
export async function adminUpdate(req, res) {
  const input = z
    .object({ isActive: z.boolean().optional(), retry: z.boolean().optional() })
    .strict()
    .parse(req.body);
  if (input.retry && !hasMail(req, 'admin.sync.retry'))
    throw new AppError(403, 'Sync retry denied');
  const row = await MailAccount.findById(id(req.params.id));
  if (!row) throw new AppError(404, 'Mailbox not found');
  if (
    input.isActive === true &&
    row.type === 'PERSONAL' &&
    !(await User.exists({ _id: row.user, active: true }))
  )
    throw new AppError(409, 'Personal owner must be active');
  if (input.isActive === true && row.syncStatus === 'DISCONNECTED')
    throw new AppError(409, 'Owner must reconnect the mailbox');
  const fields = {
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.retry && row.syncStatus !== 'REAUTH_REQUIRED'
      ? { nextSyncAt: new Date() }
      : {}),
    updatedBy: req.user._id,
  };
  await MailAccount.updateOne(
    { _id: row._id },
    { $set: fields, $inc: { revision: 1 } },
  );
  await audit(req, 'admin_configuration_changed', row, {
    isActive: input.isActive,
    retry: input.retry,
  });
  ok(res, { updated: true });
}
export async function grants(req, res) {
  const row = await MailAccount.findById(id(req.params.id));
  if (!row || row.type !== 'SHARED')
    throw new AppError(403, 'Only shared mailboxes can be delegated');
  if (req.method === 'GET')
    return ok(res, {
      items: await SharedMailboxAccess.find({ mailAccount: row._id })
        .populate('user', 'name email')
        .lean(),
      users: await User.find({ active: true })
        .select('name email')
        .limit(200)
        .lean(),
    });
  const input = z
    .object({
      user: z.string().regex(/^[a-f\d]{24}$/i),
      permissions: z
        .array(z.enum(sharedOperations))
        .max(sharedOperations.length),
      active: z.boolean().default(true),
    })
    .strict()
    .parse(req.body);
  if (!(await User.exists({ _id: input.user, active: true })))
    throw new AppError(400, 'Choose an active ERP user');
  const grant = await SharedMailboxAccess.findOneAndUpdate(
    { mailAccount: row._id, user: input.user },
    {
      $set: {
        permissions: [...new Set(input.permissions)],
        active: input.active,
        updatedBy: req.user._id,
      },
    },
    { upsert: true, new: true },
  );
  await audit(req, 'shared_permissions_updated', row, {
    user: input.user,
    permissions: input.permissions,
    active: input.active,
  });
  ok(res, { _id: grant._id });
}
export async function reconnect(req, res) {
  const { password } = z
    .object({ password: z.string().min(1).max(500) })
    .strict()
    .parse(req.body);
  const row = await MailAccount.findById(id(req.params.id));
  if (!row) throw new AppError(404, 'Mailbox not found');
  if (row.type === 'PERSONAL') {
    if (String(row.user) !== req.user.id || !hasMail(req, 'personal.connect'))
      throw new AppError(403, 'Only the personal mailbox owner can reconnect');
  } else if (!hasMail(req, 'admin.accounts.manage'))
    throw new AppError(403, 'Shared mailbox reconnect requires administration');
  if (
    row.type === 'PERSONAL' &&
    !(await User.exists({ _id: row.user, active: true }))
  )
    throw new AppError(403, 'Mailbox owner is inactive');
  const encryptedPassword = encryptMailSecret(password);
  await testMailbox(row, password);
  const updated = await MailAccount.findOneAndUpdate(
    { _id: row._id, revision: row.revision },
    {
      $set: {
        encryptedPassword,
        isActive: true,
        syncStatus: 'PENDING',
        syncError: '',
        attempts: 0,
        nextSyncAt: new Date(),
        updatedBy: req.user._id,
      },
      $inc: { revision: 1 },
    },
    { new: true },
  );
  if (!updated) throw new AppError(409, 'Mailbox changed; refresh and retry');
  await audit(req, 'reconnected', row);
  ok(res, { reconnected: true });
}
