import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { AuditLog } from '../models/AuditLog.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { hashToken, verifyToken, issueSession } from './tokenService.js';
const dummyHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
export async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash');
  const valid = await bcrypt.compare(password, user?.passwordHash || dummyHash);
  if (!valid || !user?.active)
    throw new AppError(401, 'Invalid email or password');
  await AuditLog.create({ user: user.id, action: 'auth.login' });
  return issueSession(user);
}
export async function refresh(token) {
  let payload;
  try {
    payload = verifyToken(token || '', 'refresh');
  } catch {
    throw new AppError(401, 'Invalid session');
  }
  const user = await User.findById(payload.sub);
  if (!user?.active || user.tokenVersion !== payload.version)
    throw new AppError(401, 'Invalid session');
  const session = await Session.findOneAndDelete({
    user: user.id,
    tokenHash: hashToken(token),
    expires: { $gt: new Date() },
  });
  if (!session) throw new AppError(401, 'Invalid session');
  return issueSession(user);
}
export async function logout(token) {
  if (token) await Session.deleteOne({ tokenHash: hashToken(token) });
}
export async function changePassword(user, { currentPassword, newPassword }) {
  const stored = await User.findById(user.id).select('+passwordHash');
  if (!(await bcrypt.compare(currentPassword, stored.passwordHash)))
    throw new AppError(401, 'Invalid password');
  stored.passwordHash = await bcrypt.hash(newPassword, 12);
  stored.tokenVersion += 1;
  stored.resetHash = undefined;
  stored.resetExpires = undefined;
  await stored.save();
  await Session.deleteMany({ user: user.id });
  await AuditLog.create({ user: user.id, action: 'auth.password_changed' });
}
export async function forgotPassword(email) {
  const user = await User.findOne({ email, active: true });
  if (!user) return;
  const token = randomBytes(32).toString('hex');
  user.resetHash = hashToken(token);
  user.resetExpires = new Date(Date.now() + 30 * 60000);
  await user.save();
  const message = {
    from: env.MAIL_FROM,
    to: email,
    subject: 'AdBorn ERP password reset',
    text: `Password reset token (expires in 30 minutes): ${token}${env.PASSWORD_RESET_URL ? `\n${env.PASSWORD_RESET_URL}?token=${token}` : ''}`,
  };
  if (env.RESET_DELIVERY === 'smtp')
    await nodemailer.createTransport(env.SMTP_URL).sendMail(message);
  else {
    const directory = new URL('../../.reset-mail/', import.meta.url);
    await mkdir(directory, { recursive: true });
    await writeFile(
      new URL(`${user.id}.json`, directory),
      JSON.stringify(message),
      { mode: 0o600 },
    );
  }
  await AuditLog.create({
    user: user.id,
    action: 'auth.password_reset_requested',
  });
}
export async function resetPassword({ token, password }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.findOneAndUpdate(
    {
      resetHash: hashToken(token),
      resetExpires: { $gt: new Date() },
      active: true,
    },
    {
      $set: { passwordHash },
      $inc: { tokenVersion: 1 },
      $unset: { resetHash: 1, resetExpires: 1 },
    },
    { new: true },
  );
  if (!user) throw new AppError(400, 'Invalid or expired reset token');
  await Session.deleteMany({ user: user.id });
  await AuditLog.create({ user: user.id, action: 'auth.password_reset' });
}
