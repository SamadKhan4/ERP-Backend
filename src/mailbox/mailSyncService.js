import { randomUUID } from 'node:crypto';
import {
  MailAccount,
  MailMessage,
  MailFolder,
  SharedMailboxAccess,
  MailSendJob,
} from '../models/Mailbox.js';
import { User } from '../models/User.js';
import { Notification } from '../models/Notification.js';
import { permissionsFor } from '../services/permissionService.js';
import {
  withImap,
  acquireAccount,
  providerFolders,
  folderKind,
  upsertProviderMessage,
} from './mailProvider.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
export async function syncAccount(account) {
  return acquireAccount(account._id, async (locked) =>
    withImap(locked, async (client) => {
      await MailAccount.updateOne(
        { _id: locked._id },
        { $set: { syncStatus: 'SYNCING', lastSyncAt: new Date() } },
      );
      const folders = await providerFolders(client, locked._id);
      let more = false,
        budget = 100;
      for (const f of folders) {
        const lock = await client.getMailboxLock(f.path);
        try {
          let folder = await MailFolder.findOne({
            mailAccount: locked._id,
            path: f.path,
          });
          const validity = String(client.mailbox.uidValidity),
            next = Number(client.mailbox.uidNext || 1);
          const alreadyInitialized = folder.uidValidity === validity;
          if (folder.uidValidity !== validity) {
            await MailMessage.updateMany(
              { mailAccount: locked._id, folder: f.path },
              { $set: { providerPresent: false } },
            );
            folder.bootstrapUid = next - 1;
            folder.uidValidity = validity;
            folder.highestUid = Math.max(0, next - 101);
            folder.oldestUid = folder.highestUid + 1;
            folder.reconcileOffset = 1;
            folder.reconcileStartedAt = new Date();
          }
          const begin = folder.highestUid + 1,
            end = Math.min(next - 1, begin + Math.min(49, budget - 1));
          if (begin <= end) {
            const messages = [];
            for await (const item of client.fetch(
              `${begin}:${end}`,
              {
                uid: true,
                envelope: true,
                flags: true,
                internalDate: true,
                size: true,
              },
              { uid: true },
            ))
              messages.push(item);
            for (const item of messages) {
              let source;
              if (item.size <= env.MAX_FILE_SIZE)
                source = (
                  await client.fetchOne(
                    item.uid,
                    { source: true },
                    { uid: true },
                  )
                )?.source;
              const synced = await upsertProviderMessage(
                locked,
                { path: f.path, uidValidity: validity, kind: folderKind(f) },
                item,
                source,
              );
              if (
                alreadyInitialized &&
                item.uid > (folder.bootstrapUid || 0) &&
                folderKind(f) === 'INBOX'
              )
                await notifyNewMail(locked, synced);
            }
            budget -= end - begin + 1;
            folder.highestUid = end;
            if (end < next - 1) more = true;
          }
          if (begin < next && budget <= 0) more = true;
          if (
            locked.backfillRequested &&
            folder.oldestUid > 1 &&
            (!locked.backfillKind || locked.backfillKind === folderKind(f))
          ) {
            const end = folder.oldestUid - 1,
              start = Math.max(1, end - 49),
              items = [];
            for await (const item of client.fetch(
              `${start}:${end}`,
              {
                uid: true,
                envelope: true,
                flags: true,
                internalDate: true,
                size: true,
              },
              { uid: true },
            ))
              items.push(item);
            for (const item of items) {
              const source =
                item.size <= env.MAX_FILE_SIZE
                  ? (
                      await client.fetchOne(
                        item.uid,
                        { source: true },
                        { uid: true },
                      )
                    )?.source
                  : undefined;
              await upsertProviderMessage(
                locked,
                { path: f.path, uidValidity: validity, kind: folderKind(f) },
                item,
                source,
              );
            }
            folder.oldestUid = start;
          }
          const count = Number(client.mailbox.exists || 0);
          if (!folder.reconcileStartedAt)
            folder.reconcileStartedAt = new Date();
          const offset = folder.reconcileOffset || 1,
            finish = Math.min(count, offset + 99);
          if (offset <= finish) {
            const flags = [];
            for await (const item of client.fetch(`${offset}:${finish}`, {
              uid: true,
              flags: true,
            }))
              flags.push(item);
            if (flags.length)
              await MailMessage.bulkWrite(
                flags.map((item) => ({
                  updateOne: {
                    filter: {
                      mailAccount: locked._id,
                      folder: f.path,
                      uidValidity: validity,
                      uid: item.uid,
                    },
                    update: {
                      $set: {
                        isRead: item.flags.has('\\Seen'),
                        isStarred: item.flags.has('\\Flagged'),
                        lastSeenAt: new Date(),
                        providerPresent: true,
                      },
                    },
                  },
                })),
              );
            folder.reconcileOffset = finish + 1;
          }
          if (!count || folder.reconcileOffset > count) {
            await MailMessage.updateMany(
              {
                mailAccount: locked._id,
                folder: f.path,
                uidValidity: validity,
                uid: { $lte: folder.highestUid },
                lastSeenAt: { $lt: folder.reconcileStartedAt },
              },
              { $set: { providerPresent: false } },
            );
            folder.reconcileOffset = 1;
            folder.reconcileStartedAt = new Date();
            folder.lastReconciledAt = new Date();
          }
          await folder.save();
        } finally {
          lock.release();
        }
      }
      await MailAccount.updateOne(
        { _id: locked._id },
        {
          $set: {
            syncStatus: 'CONNECTED',
            syncError: '',
            lastSuccessfulSyncAt: new Date(),
            attempts: 0,
            backfillRequested: false,
            nextSyncAt: new Date(Date.now() + (more ? 5000 : 60000)),
          },
        },
      );
      return { synced: true };
    }),
  );
}
export async function syncFailure(account, error) {
  const authentication = error.status === 422;
  await MailAccount.updateOne(
    { _id: account._id },
    {
      $set: {
        syncStatus: authentication ? 'REAUTH_REQUIRED' : 'ERROR',
        syncError: authentication
          ? 'Mailbox password changed or authentication failed. Reconnect.'
          : 'Hostinger sync unavailable. A retry is scheduled.',
        nextSyncAt: new Date(
          Date.now() +
            Math.min(3600000, 60000 * 2 ** Math.min(account.attempts || 0, 6)),
        ),
      },
      $inc: { attempts: 1 },
    },
  );
  if (authentication && account.user)
    await Notification.updateOne(
      {
        recipient: account.user,
        type: 'mail.reconnect',
        entityId: account._id,
      },
      {
        $setOnInsert: {
          title: 'Reconnect your work mailbox',
          message:
            'Mail authentication failed. Open Mail Settings to reconnect.',
          link: '/mail/settings',
          entityType: 'mailAccount',
        },
      },
      { upsert: true },
    );
}
export async function runMailboxSync() {
  if (env.MAIL_SYNC_ENABLED !== 'true' || !env.MAIL_CREDENTIAL_ENCRYPTION_KEY)
    return;
  const accounts = await MailAccount.find({
    isActive: true,
    syncStatus: { $nin: ['REAUTH_REQUIRED', 'DISCONNECTED'] },
    nextSyncAt: { $lte: new Date() },
    $or: [{ lockedUntil: null }, { lockedUntil: { $lt: new Date() } }],
  })
    .sort({ nextSyncAt: 1 })
    .limit(2);
  for (const account of accounts) {
    if (
      account.type === 'PERSONAL' &&
      !(await User.exists({ _id: account.user, active: true }))
    ) {
      await MailAccount.updateOne(
        { _id: account._id },
        { $set: { isActive: false, syncStatus: 'DISCONNECTED' } },
      );
      continue;
    }
    try {
      await syncAccount(account);
    } catch (error) {
      if (error.status !== 409) await syncFailure(account, error);
    }
  }
}
export async function notifyNewMail(account, row) {
  const candidates =
    account.type === 'PERSONAL'
      ? [account.user]
      : await SharedMailboxAccess.distinct('user', {
          mailAccount: account._id,
          active: true,
          permissions: 'READ',
        });
  for (const recipient of candidates) {
    const user = await User.findOne({ _id: recipient, active: true });
    if (!user) continue;
    const permissions = await permissionsFor(user);
    if (!permissions.includes('*') && !permissions.includes('mail.use'))
      continue;
    await Notification.updateOne(
      { recipient, type: 'mail.received', entityId: row._id },
      {
        $setOnInsert: {
          title: 'New work email',
          message: 'Your authorized mailbox has a new message.',
          link: `/mail/message/${row._id}`,
          entityType: 'mailMessage',
        },
      },
      { upsert: true },
    );
  }
}
export function startMailboxWorker(sendWorker) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await MailSendJob.updateMany(
        { status: 'SENDING', lockedUntil: { $lt: new Date() } },
        {
          $set: {
            status: 'UNKNOWN',
            lastError:
              'Delivery was interrupted. Check Sent in Hostinger before sending again.',
          },
          $unset: { payload: '' },
        },
      );
      await sendWorker();
      await runMailboxSync();
    } catch {
      logger.warn(
        { event: 'mailbox.worker_failed' },
        'Mailbox worker will retry',
      );
    } finally {
      busy = false;
    }
  }, 15000);
  timer.unref();
  return () => clearInterval(timer);
}
export const leaseId = () => randomUUID();
