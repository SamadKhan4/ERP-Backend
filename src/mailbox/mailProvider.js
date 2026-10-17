import { randomUUID, createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import {
  MailAccount,
  MailMessage,
  MailFolder,
  MailSendJob,
} from '../models/Mailbox.js';
import { env } from '../config/env.js';
import { decryptMailSecret } from './mailCrypto.js';
import { AppError } from '../utils/errors.js';
export const safeHtml = (html, images = false) =>
  sanitizeHtml(String(html || ''), {
    allowedTags: [
      'p',
      'br',
      'div',
      'span',
      'b',
      'strong',
      'i',
      'em',
      'u',
      'ul',
      'ol',
      'li',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
      'blockquote',
      'pre',
      'code',
      'h1',
      'h2',
      'h3',
      'h4',
      'hr',
      'a',
      ...(images ? ['img'] : []),
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        target: '_blank',
        rel: 'noopener noreferrer',
      }),
    },
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: true,
  });
export const safeFilename = (name) =>
  String(name || 'attachment')
    .split('')
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? '_' : c))
    .join('')
    .replace(/[\\/<>:"|?*]/g, '_')
    .slice(0, 160) || 'attachment';
export const providerError = (error) =>
  new AppError(
    error?.authenticationFailed ||
      error?.code === 'EAUTH' ||
      /AUTHENTICATIONFAILED|Invalid credentials/i.test(
        error?.serverResponse || '',
      )
      ? 422
      : 502,
    error?.authenticationFailed ||
      error?.code === 'EAUTH' ||
      /AUTHENTICATIONFAILED|Invalid credentials/i.test(
        error?.serverResponse || '',
      )
      ? 'Mailbox authentication failed. Reconnect your work email.'
      : 'Hostinger is unavailable. Please retry later.',
  );
export function imapClient(account, password) {
  const client = new ImapFlow({
    host: env.MAIL_IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: account.emailAddress, pass: password },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableAutoIdle: true,
    emitLogs: false,
  });
  client.on('error', () => {});
  return client;
}
export function smtpClient(account, password) {
  return nodemailer.createTransport({
    host: env.MAIL_SMTP_HOST,
    port: 465,
    secure: true,
    auth: { user: account.emailAddress, pass: password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}
export async function withImap(account, fn) {
  const client = imapClient(
    account,
    decryptMailSecret(account.encryptedPassword),
  );
  try {
    await client.connect();
    return await fn(client);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw providerError(error);
  } finally {
    try {
      if (client.usable) await client.logout();
      else client.close();
    } catch {
      client.close();
    }
  }
}
export async function testMailbox(account, password) {
  password = password ?? decryptMailSecret(account.encryptedPassword);
  const client = imapClient(account, password),
    smtp = smtpClient(account, password);
  try {
    await client.connect();
    await smtp.verify();
  } catch (error) {
    throw providerError(error);
  } finally {
    try {
      if (client.usable) await client.logout();
      else client.close();
    } catch {
      client.close();
    }
    smtp.close();
  }
}
export async function acquireAccount(accountId, fn) {
  const lease = randomUUID();
  const row = await MailAccount.findOneAndUpdate(
    {
      _id: accountId,
      isActive: true,
      $or: [{ lockedUntil: { $lt: new Date() } }, { lockedUntil: null }],
    },
    { $set: { lockedUntil: new Date(Date.now() + 300000), lease } },
    { new: true },
  ).select('+encryptedPassword');
  if (!row) throw new AppError(409, 'Mailbox is busy. Try again shortly.');
  const heartbeat = setInterval(() => {
    MailAccount.updateOne(
      { _id: row._id, lease },
      { $set: { lockedUntil: new Date(Date.now() + 300000) } },
    ).catch(() => {});
  }, 30000);
  heartbeat.unref();
  try {
    return await fn(row);
  } finally {
    clearInterval(heartbeat);
    await MailAccount.updateOne(
      { _id: row._id, lease },
      { $unset: { lockedUntil: '', lease: '' } },
    );
  }
}
const addresses = (v) =>
  (v?.value || [])
    .filter((a) => a.address)
    .map((a) => ({
      address: a.address.toLowerCase(),
      name: String(a.name || '').slice(0, 200),
    }))
    .slice(0, 100);
export async function parseMail(source) {
  return simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    maxHtmlLengthToParse: 1048576,
  });
}
export async function upsertProviderMessage(account, folder, item, source) {
  let parsed = null;
  if (source) {
    try {
      parsed = await parseMail(source);
    } catch {
      parsed = null;
    }
  }
  const messageDate =
    parsed?.date instanceof Date && !Number.isNaN(+parsed.date)
      ? parsed.date
      : item.internalDate || new Date();
  const header = parsed?.messageId || item.envelope?.messageId || '';
  const refs = (
    Array.isArray(parsed?.references)
      ? parsed.references
      : parsed?.references
        ? [parsed.references]
        : []
  )
    .filter((r) => /^<[^\r\n<>]+>$/.test(r))
    .slice(-50);
  const parent = parsed?.inReplyTo || item.envelope?.inReplyTo;
  const earliest =
    refs[0] ||
    parent ||
    header ||
    `${folder.path}:${folder.uidValidity}:${item.uid}`;
  const threadKey = createHash('sha256')
    .update(`${account._id}:${earliest}`)
    .digest('hex');
  const flags = item.flags || new Set();
  const fields = {
    providerMessageId: item.id || '',
    folderKind: folder.kind,
    messageIdHeader: header,
    threadKey,
    from: parsed ? addresses(parsed.from)[0] : item.envelope?.from?.[0],
    to: parsed ? addresses(parsed.to) : item.envelope?.to || [],
    cc: parsed ? addresses(parsed.cc) : [],
    bcc: parsed ? addresses(parsed.bcc) : [],
    replyTo: parsed ? addresses(parsed.replyTo) : [],
    subject: String(
      parsed?.subject || item.envelope?.subject || '(No subject)',
    ).slice(0, 1000),
    snippet: String(parsed?.text || '').slice(0, 250),
    textBody: String(parsed?.text || '').slice(0, 524288),
    htmlBody: safeHtml(String(parsed?.html || '').slice(0, 1048576), true),
    receivedAt: messageDate,
    sentAt: folder.kind === 'SENT' ? messageDate : undefined,
    isRead: flags.has('\\Seen'),
    isStarred: flags.has('\\Flagged'),
    isDraft: folder.kind === 'DRAFTS',
    providerPresent: true,
    lastSeenAt: new Date(),
    oversized: !source,
    parseFailed: Boolean(source && !parsed),
    inReplyTo: parent,
    references: refs,
    attachments: (parsed?.attachments || []).slice(0, 50).map((a, i) => ({
      fileName: safeFilename(a.filename),
      mime: a.contentType,
      size: a.size,
      partIndex: i,
    })),
  };
  const identity = {
    mailAccount: account._id,
    folder: folder.path,
    uidValidity: folder.uidValidity,
    uid: item.uid,
  };
  const inherited = header
    ? await MailMessage.findOne({
        mailAccount: account._id,
        messageIdHeader: header,
      })
        .select(
          'linkedLead linkedClient linkedProject linkedQuotation linkedInvoice labels',
        )
        .lean()
    : null;
  const sent = header
    ? await MailSendJob.findOne({
        mailAccount: account._id,
        messageIdHeader: header,
        status: 'SENT',
      })
        .select('businessLinks')
        .lean()
    : null;
  const links = {};
  for (const kind of ['lead', 'client', 'project', 'quotation', 'invoice']) {
    const key = `linked${kind[0].toUpperCase() + kind.slice(1)}`;
    const value = sent?.businessLinks?.[kind] || inherited?.[key];
    if (value) links[key] = value;
  }
  const row = await MailMessage.findOneAndUpdate(
    identity,
    {
      $set: fields,
      $setOnInsert: {
        ...links,
        ...(inherited?.labels ? { labels: inherited.labels } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return row;
}
export function folderKind(mailbox) {
  const flag = mailbox.specialUse;
  return (
    {
      '\\Sent': 'SENT',
      '\\Drafts': 'DRAFTS',
      '\\Trash': 'TRASH',
      '\\Junk': 'SPAM',
      '\\Archive': 'ARCHIVE',
    }[flag] ||
    (/^inbox$/i.test(mailbox.path)
      ? 'INBOX'
      : /sent/i.test(mailbox.path)
        ? 'SENT'
        : /draft/i.test(mailbox.path)
          ? 'DRAFTS'
          : /trash|deleted/i.test(mailbox.path)
            ? 'TRASH'
            : /junk|spam/i.test(mailbox.path)
              ? 'SPAM'
              : /archive/i.test(mailbox.path)
                ? 'ARCHIVE'
                : 'OTHER')
  );
}
export async function providerFolders(client, accountId) {
  const list = (await client.list())
    .filter((f) => !f.flags?.has('\\Noselect'))
    .slice(0, 30);
  await MailMessage.updateMany(
    { mailAccount: accountId, folder: { $nin: list.map((f) => f.path) } },
    { $set: { providerPresent: false } },
  );
  for (const f of list)
    await MailFolder.updateOne(
      { mailAccount: accountId, path: f.path },
      { $set: { kind: folderKind(f) } },
      { upsert: true },
    );
  return list;
}
export async function folderFor(client, accountId, kind) {
  let folder = await MailFolder.findOne({ mailAccount: accountId, kind });
  if (!folder) {
    await providerFolders(client, accountId);
    folder = await MailFolder.findOne({ mailAccount: accountId, kind });
  }
  if (!folder)
    throw new AppError(
      409,
      `Hostinger ${kind.toLowerCase()} folder is unavailable. Create it in webmail first.`,
    );
  return folder;
}
export async function loadSource(client, row) {
  const lock = await client.getMailboxLock(row.folder);
  try {
    if (String(client.mailbox.uidValidity) !== row.uidValidity)
      throw new AppError(404, 'Message removed at provider');
    const meta = await client.fetchOne(
      row.uid,
      { uid: true, size: true },
      { uid: true },
    );
    if (!meta) {
      await MailMessage.updateOne(
        { _id: row._id },
        { $set: { providerPresent: false } },
      );
      throw new AppError(404, 'Message removed at provider');
    }
    if (meta.size > env.MAX_FILE_SIZE)
      throw new AppError(
        413,
        'Message is too large; open it in Hostinger webmail',
      );
    const fetched = await client.fetchOne(
      row.uid,
      { source: true },
      { uid: true },
    );
    if (!fetched?.source) throw new AppError(404, 'Email not found.');
    return fetched.source;
  } finally {
    lock.release();
  }
}
