import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { MailJob } from '../models/MailJob.js';
import { AuditLog } from '../models/AuditLog.js';
import { logger } from '../config/logger.js';
import { mailTransport, welcomeMessage } from './mailTransportService.js';
import { AppError } from '../utils/errors.js';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const key = () => createHash('sha256').update(`adborn-mail:${env.JWT_REFRESH_SECRET}`).digest();
function encrypt(token) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  const bytes = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((value) => value.toString('hex')).join('.');
}
function decrypt(value) {
  const [iv, tag, bytes] = value.split('.').map((part) => Buffer.from(part, 'hex'));
  const cipher = createDecipheriv('aes-256-gcm', key(), iv); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8');
}
export async function queueWelcome(user) {
  if (env.MAIL_DELIVERY !== 'smtp') return { status: 'disabled' };
  const token = randomBytes(32).toString('hex');
  const lease = randomUUID();
  let job;
  try {
    job = await MailJob.findOneAndUpdate({ user: user._id, kind: 'WELCOME', $or: [
      { status: { $ne: 'PROCESSING' }, updatedAt: { $lte: new Date(Date.now() - 60000) } },
      { status: 'PROCESSING', lockedUntil: { $lt: new Date() } },
    ] }, {
      $set: { recipient: user.email, encryptedToken: encrypt(token), status: 'PROCESSING', attempts: 0, nextAttemptAt: new Date(), lease, lockedUntil: new Date(Date.now() + 300000) },
      $unset: { sentAt: 1, lastError: 1 },
    }, { upsert: true, new: true });
  } catch (error) {
    if (error.code === 11000) throw new AppError(429, 'Email is queued or recently sent; wait one minute before resending');
    throw error;
  }
  const result = await User.updateOne({ _id: user._id, active: true }, { $set: { resetHash: hash(token), resetExpires: new Date(Date.now() + 86400000) } });
  await MailJob.updateOne({ _id: job._id, lease }, { $set: { status: result.matchedCount ? 'PENDING' : 'CANCELLED' }, $unset: { lease: 1, lockedUntil: 1 } });
  return { status: 'queued', id: job.id };
}
export async function welcomeAfterCreation(user) {
  try { return await queueWelcome(user); }
  catch {
    logger.warn({ event: 'mail.queue_failed', user: user.id }, 'Account created; welcome email could not be queued');
    return { status: 'unavailable' };
  }
}
export async function processMailQueue(limit = 10) {
  if (env.MAIL_DELIVERY !== 'smtp') return;
  for (let count = 0; count < limit; count++) {
    const now = new Date(), lease = randomUUID();
    const job = await MailJob.findOneAndUpdate({ $or: [
      { status: 'PENDING', nextAttemptAt: { $lte: now } },
      { status: 'PROCESSING', lockedUntil: { $lt: now } },
    ] }, { $set: { status: 'PROCESSING', lease, lockedUntil: new Date(Date.now() + 300000) }, $inc: { attempts: 1 } }, { new: true, sort: { nextAttemptAt: 1 } }).select('+encryptedToken');
    if (!job) return;
    const filter = { _id: job._id, lease };
    try {
      const user = await User.findById(job.user).select('+resetHash');
      const token = decrypt(job.encryptedToken);
      if (!user?.active || user.email !== job.recipient || user.resetHash !== hash(token) || user.resetExpires <= new Date()) {
        await MailJob.updateOne(filter, { $set: { status: 'CANCELLED' }, $unset: { encryptedToken: 1, lease: 1, lockedUntil: 1 } });
        continue;
      }
      const result = await mailTransport().sendMail(welcomeMessage(user, token));
      if (!result.accepted?.length) throw new Error('Recipient not accepted');
      await MailJob.updateOne(filter, { $set: { status: 'SENT', sentAt: new Date() }, $unset: { encryptedToken: 1, lease: 1, lockedUntil: 1, lastError: 1 } });
    } catch {
      await MailJob.updateOne(filter, { $set: { status: job.attempts >= 5 ? 'FAILED' : 'PENDING', lastError: 'Delivery failed; verify SMTP settings or retry', nextAttemptAt: new Date(Date.now() + 60000 * 2 ** Math.min(job.attempts - 1, 5)) }, $unset: { lease: 1, lockedUntil: 1 } });
      logger.warn({ event: 'mail.delivery_retry', job: job.id }, 'Mail delivery failed; retry scheduled');
    }
  }
}
export function startMailWorker() {
  let running = false;
  const run = async () => { if (running) return; running = true; try { await processMailQueue(); } catch { logger.warn({ event: 'mail.worker_error' }, 'Mail queue unavailable'); } finally { running = false; } };
  void run();
  const timer = setInterval(run, 15000); timer.unref();
  return () => clearInterval(timer);
}
export async function auditMailResend(actor, target) {
  await AuditLog.create({ user: actor.id, action: 'mail.welcome_resent', entityType: 'user', entityId: target.id });
}
