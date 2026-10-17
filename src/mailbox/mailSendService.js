import { attachment, email } from './mailValidator.js';
import { env } from '../config/env.js';
import { randomUUID, createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import {
  MailAccount,
  MailMessage,
  MailSendJob,
  MailRateWindow,
} from '../models/Mailbox.js';
import { User } from '../models/User.js';
import { AuditLog } from '../models/AuditLog.js';
import { permissionsFor } from '../services/permissionService.js';
import { AppError } from '../utils/errors.js';
import { authorizeAccount, authorizeMessage, hasMail } from './mailAccess.js';
import { encryptMailSecret, decryptMailSecret } from './mailCrypto.js';
import {
  acquireAccount,
  withImap,
  smtpClient,
  folderFor,
  loadSource,
  parseMail,
} from './mailProvider.js';
import { validateLinks, recordPdf } from './mailBusinessService.js';
import { syncFailure } from './mailSyncService.js';
export async function prepareSend(req, input, operation = 'SEND') {
  const account = await authorizeAccount(req, input.mailAccountId, operation);
  const permission =
    operation === 'REPLY'
      ? 'reply'
      : operation === 'FORWARD'
        ? 'forward'
        : 'send';
  if (!hasMail(req, permission))
    throw new AppError(403, 'Mail operation permission denied');
  if (!hasMail(req, 'compose'))
    throw new AppError(403, 'Compose permission denied');
  if (!input.to.length && operation !== 'REPLY')
    throw new AppError(400, 'Add at least one recipient');
  if (input.to.length + input.cc.length + input.bcc.length > 50)
    throw new AppError(400, 'Maximum 50 recipients');
  let inReplyTo,
    references = [];
  if (input.draftMessage) {
    const { row } = await authorizeMessage(req, input.draftMessage, 'SEND');
    if (!row.isDraft || String(row.mailAccount) !== String(account._id))
      throw new AppError(403, 'Draft mailbox mismatch');
    input.attachments.push(...(await originalAttachments(account, row)));
  }
  if (input.sourceMessage) {
    const { row } = await authorizeMessage(req, input.sourceMessage, operation);
    if (String(row.mailAccount) !== String(account._id))
      throw new AppError(403, 'Source message belongs to another mailbox');
    if (operation === 'REPLY') {
      inReplyTo = /^<[^<>\s]{1,500}>$/.test(row.messageIdHeader || '')
        ? row.messageIdHeader
        : undefined;
      references = [
        ...row.references,
        ...(row.messageIdHeader ? [row.messageIdHeader] : []),
      ].slice(-50);
      if (!input.to.length)
        input.to = (row.replyTo.length ? row.replyTo : [row.from])
          .filter((a) => a?.address)
          .map((a) => a.address);
    }
    if (operation === 'FORWARD' && row.attachments.length)
      input.attachments.push(...(await originalAttachments(account, row)));
    if (operation === 'FORWARD')
      input.text += `\n\n---------- Forwarded message ----------\nFrom: ${row.from?.address || ''}\nDate: ${row.receivedAt?.toISOString() || ''}\nSubject: ${row.subject}\n\n${row.textBody || ''}`;
  }
  if (
    !input.to.length ||
    input.to.length + input.cc.length + input.bcc.length > 50
  )
    throw new AppError(400, 'Invalid recipient count');
  input.to = input.to.map((value) => email.parse(value));
  input.cc = input.cc.map((value) => email.parse(value));
  input.bcc = input.bcc.map((value) => email.parse(value));
  if (!input.text.trim()) throw new AppError(400, 'Write an email message');
  if (
    input.attachments.reduce(
      (sum, a) => sum + (a.size || Buffer.from(a.content, 'base64').length),
      0,
    ) > env.MAX_FILE_SIZE
  )
    throw new AppError(
      413,
      'Combined attachments exceed configured size limit',
    );
  const selected = await validateLinks(req, input.links);
  const attachments = [...input.attachments];
  if (input.attachRecordPdf) attachments.push(await recordPdf(selected));
  return {
    account,
    payload: {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text + (account.signature ? `\n\n${account.signature}` : ''),
      attachments,
      inReplyTo,
      references,
      links: input.links,
      attachRecordPdf: input.attachRecordPdf,
    },
  };
}
export async function enqueueSend(req, input, operation) {
  const key = req.get('Idempotency-Key');
  if (!/^[\w-]{16,100}$/.test(key || ''))
    throw new AppError(400, 'A stable Idempotency-Key is required');
  const fingerprint = createHash('sha256')
      .update(JSON.stringify({ input, operation }))
      .digest('hex'),
    jobKey = `${req.user.id}:${key}`;
  const existing = await MailSendJob.findOne({ idempotencyKey: jobKey });
  if (existing) {
    await authorizeAccount(req, existing.mailAccount, operation);
    if (existing.fingerprint !== fingerprint)
      throw new AppError(
        409,
        'Send key was already used for different content',
      );
    return { _id: existing._id, status: existing.status };
  }
  const { account, payload } = await prepareSend(req, input, operation);
  try {
    const window = Math.floor(Date.now() / 3600000);
    await MailRateWindow.findOneAndUpdate(
      { _id: `${account._id}:${window}`, count: { $lt: 60 } },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date((window + 2) * 3600000) },
      },
      { upsert: true },
    );
  } catch (error) {
    if (error.code === 11000)
      throw new AppError(429, 'Mailbox hourly sending limit reached');
    throw error;
  }
  if (input.draftMessage) {
    const { row } = await authorizeMessage(req, input.draftMessage, 'SEND');
    if (String(row.mailAccount) !== String(account._id) || !row.isDraft)
      throw new AppError(400, 'Invalid draft');
  }
  let row;
  try {
    row = await MailSendJob.create({
      mailAccount: account._id,
      user: req.user._id,
      operation,
      businessLinks: input.links,
      sourceMessage: input.sourceMessage,
      draftMessage: input.draftMessage,
      messageIdHeader: `<${randomUUID()}@${account.emailAddress.split('@')[1]}>`,
      idempotencyKey: jobKey,
      fingerprint,
      payload: encryptMailSecret(JSON.stringify(payload)),
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    row = await MailSendJob.findOne({ idempotencyKey: jobKey });
    if (row.fingerprint !== fingerprint)
      throw new AppError(409, 'Send key conflict');
  }
  await AuditLog.create({
    user: req.user._id,
    action: 'mail.queued',
    entityType: 'mailAccount',
    entityId: account._id,
    details: { job: row._id, operation },
  });
  return { _id: row._id, status: row.status };
}
export async function rawMessage(account, payload, messageId) {
  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    return (
      await composer.sendMail({
        from: {
          name: account.displayName || '',
          address: account.emailAddress,
        },
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        subject: payload.subject,
        text: payload.text,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        messageId,
        attachments: (payload.attachments || []).map((a) => ({
          filename: a.fileName,
          content: Buffer.from(a.content, 'base64'),
          contentType: a.mime,
        })),
        disableFileAccess: true,
        disableUrlAccess: true,
      })
    ).message;
  } finally {
    composer.close();
  }
}
async function saveSent(client, account, raw, job) {
  const folder = await folderFor(client, account._id, 'SENT');
  const lock = await client.getMailboxLock(folder.path);
  try {
    const existing = await client.search(
      { header: { 'message-id': job.messageIdHeader } },
      { uid: true },
    );
    if (!existing.length) await client.append(folder.path, raw, ['\\Seen']);
  } finally {
    lock.release();
  }
  if (job.draftMessage) {
    const draft = await MailMessage.findOne({
      _id: job.draftMessage,
      mailAccount: account._id,
      isDraft: true,
      providerPresent: true,
    });
    if (draft) {
      const draftLock = await client.getMailboxLock(draft.folder);
      try {
        if (String(client.mailbox.uidValidity) === draft.uidValidity)
          await client.messageDelete(draft.uid, { uid: true });
        await MailMessage.updateOne(
          { _id: draft._id, mailAccount: account._id },
          { $set: { providerPresent: false } },
        );
      } finally {
        draftLock.release();
      }
    }
  }
}
export async function runMailSend() {
  const job = await MailSendJob.findOneAndUpdate(
    { status: 'PENDING', nextAttemptAt: { $lte: new Date() } },
    {
      $set: {
        status: 'SENDING',
        lease: randomUUID(),
        lockedUntil: new Date(Date.now() + 300000),
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).select('+payload');
  if (!job) return;
  let accepted = false;
  try {
    const user = await User.findOne({ _id: job.user, active: true });
    if (!user) throw new AppError(403, 'Sender account is inactive');
    const req = { user, mailPermissions: await permissionsFor(user) };
    if (
      !hasMail(req, 'use') ||
      !hasMail(
        req,
        job.operation === 'SEND'
          ? 'send'
          : job.operation === 'REPLY'
            ? 'reply'
            : 'forward',
      )
    )
      throw new AppError(403, 'Sending permission revoked');
    await authorizeAccount(req, job.mailAccount, job.operation);
    if (job.sourceMessage)
      await authorizeMessage(req, job.sourceMessage, job.operation);
    const payload = JSON.parse(decryptMailSecret(job.payload));
    const linked = await validateLinks(req, payload.links);
    if (payload.attachRecordPdf) {
      const replacement = await recordPdf(linked);
      payload.attachments = payload.attachments.filter(
        (a) => !/^invoice-|^quotation-/.test(a.fileName),
      );
      payload.attachments.push(replacement);
    }
    await acquireAccount(job.mailAccount, async (account) => {
      const raw = await rawMessage(account, payload, job.messageIdHeader);
      const transport = smtpClient(
        account,
        decryptMailSecret(account.encryptedPassword),
      );
      try {
        const info = await transport.sendMail({
          envelope: {
            from: account.emailAddress,
            to: [...payload.to, ...payload.cc, ...payload.bcc],
          },
          raw,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        if (info.rejected?.length) {
          await MailSendJob.updateOne(
            { _id: job._id },
            {
              $set: {
                lastError: 'Some recipients were rejected by the provider',
              },
            },
          );
        }
        accepted = true;
        await MailSendJob.updateOne(
          { _id: job._id },
          {
            $set: { status: 'SENT', sentAt: new Date() },
            $unset: { payload: '', lockedUntil: '', lease: '' },
          },
        );
        try {
          await withImap(account, (client) =>
            saveSent(client, account, raw, job),
          );
          await MailSendJob.updateOne(
            { _id: job._id },
            { $set: { sentCopySaved: true } },
          );
        } catch {
          await MailSendJob.updateOne(
            { _id: job._id },
            {
              $set: {
                lastError:
                  'SMTP accepted the message; Sent-folder copy could not be saved. Check Hostinger webmail.',
              },
            },
          );
        }
        await MailAccount.updateOne(
          { _id: account._id },
          { $set: { nextSyncAt: new Date() } },
        );
      } finally {
        transport.close();
      }
    });
    await AuditLog.create({
      user: job.user,
      action: 'mail.sent',
      entityType: 'mailAccount',
      entityId: job.mailAccount,
      details: { job: job._id },
    });
  } catch (error) {
    if (accepted) return;
    if (error.status === 409) {
      await MailSendJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'PENDING',
            nextAttemptAt: new Date(Date.now() + 30000),
          },
          $unset: { lockedUntil: '', lease: '' },
        },
      );
      return;
    }
    const auth = error.code === 'EAUTH' || error.status === 422;
    if (auth) {
      const failedAccount = await MailAccount.findById(job.mailAccount);
      if (failedAccount)
        await syncFailure(failedAccount, new AppError(422, 'Reconnect'));
    }
    const uncertain =
      !error.status &&
      !auth &&
      ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNRESET'].includes(
        error.code,
      );
    await MailSendJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: uncertain ? 'UNKNOWN' : 'FAILED',
          lastError: uncertain
            ? 'Delivery could not be confirmed. Check Hostinger Sent before trying again.'
            : auth
              ? 'Reconnect mailbox to send email.'
              : 'Message was not sent. Check mailbox access and recipients.',
        },
        $unset: { payload: '', lockedUntil: '', lease: '' },
      },
    );
  }
}

export async function originalAttachments(account, row) {
  if (!row.attachments.length) return [];
  const parsed = await acquireAccount(account._id, (locked) =>
    withImap(locked, async (client) =>
      parseMail(await loadSource(client, row)),
    ),
  );
  return parsed.attachments.map((a) =>
    attachment({ originalname: a.filename, buffer: a.content }),
  );
}
