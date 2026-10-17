import mongoose from 'mongoose';
import { permissionsFor } from '../services/permissionService.js';
import {
  MailAccount,
  SharedMailboxAccess,
  MailMessage,
} from '../models/Mailbox.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/errors.js';
export const id = (value) => {
  if (!mongoose.isValidObjectId(value))
    throw new AppError(400, 'Invalid mail identifier');
  return new mongoose.Types.ObjectId(String(value));
};
export const hasMail = (req, key) =>
  req.mailPermissions.includes('*') ||
  req.mailPermissions.includes(key.startsWith('mail.') ? key : `mail.${key}`);
export const requireMail = (key) => (req, res, next) => {
  if (!hasMail(req, key)) throw new AppError(403, 'Mail permission denied');
  next();
};
export async function mailAccess(req, res, next) {
  req.mailPermissions = await permissionsFor(req.user);
  if (!hasMail(req, 'use')) throw new AppError(403, 'Mail access denied');
  next();
}
export async function allowedAccounts(user, operation = 'READ') {
  const grants = await SharedMailboxAccess.distinct('mailAccount', {
    user: user._id,
    active: true,
    permissions: operation,
  });
  return MailAccount.distinct('_id', {
    isActive: true,
    $or: [
      { type: 'PERSONAL', user: user._id },
      { type: 'SHARED', _id: { $in: grants } },
    ],
  });
}
export async function authorizeAccount(
  req,
  accountId,
  operation = 'READ',
  { inactive = false, secrets = false } = {},
) {
  const account = await MailAccount.findById(id(accountId)).select(
    secrets ? '+encryptedPassword' : '',
  );
  if (!account) throw new AppError(404, 'Mailbox not found');
  if (account.type === 'PERSONAL') {
    if (String(account.user) !== String(req.user._id))
      throw new AppError(403, 'You do not have access to this mailbox.');
  } else {
    if (
      !hasMail(req, 'shared.use') ||
      !(await SharedMailboxAccess.exists({
        mailAccount: account._id,
        user: req.user._id,
        active: true,
        permissions: operation,
      }))
    )
      throw new AppError(403, 'You do not have access to this mailbox.');
  }
  if (!inactive && !account.isActive)
    throw new AppError(409, 'Mailbox is disconnected');
  if (
    account.type === 'PERSONAL' &&
    !(await User.exists({ _id: account.user, active: true }))
  )
    throw new AppError(403, 'Mailbox owner is inactive');
  return account;
}
export async function authorizeMessage(req, messageId, operation = 'READ') {
  const row = await MailMessage.findById(id(messageId)).select(
    '+textBody +htmlBody',
  );
  if (!row) throw new AppError(404, 'Email not found.');
  if (operation !== 'READ')
    await authorizeAccount(req, row.mailAccount, 'READ');
  const account = await authorizeAccount(req, row.mailAccount, operation);
  if (!row.providerPresent)
    throw new AppError(404, 'Message removed at provider');
  return { row, account };
}
export const accountView = (account, permissions = []) => ({
  _id: account._id,
  emailAddress: account.emailAddress,
  displayName: account.displayName,
  type: account.type,
  isActive: account.isActive,
  isDefault: account.isDefault,
  syncStatus: account.syncStatus,
  syncError: account.syncError,
  lastSuccessfulSyncAt: account.lastSuccessfulSyncAt,
  lastSyncAt: account.lastSyncAt,
  signature: account.signature,
  permissions,
});
