import { randomUUID } from 'node:crypto';
import { OutgoingMail } from '../models/OutgoingMail.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { mailTransport } from './mailTransportService.js';
export async function processOutgoingMail(limit = 10) {
  if (env.MAIL_DELIVERY !== 'smtp') return;
  for (let index = 0; index < limit; index++) {
    const now = new Date(), lease = randomUUID();
    const job = await OutgoingMail.findOneAndUpdate({ $or: [
      { status: 'PENDING', nextAttemptAt: { $lte: now } },
      { status: 'PROCESSING', lockedUntil: { $lt: now } },
    ] }, { $set: { status: 'PROCESSING', lease, lockedUntil: new Date(Date.now() + 300000) }, $inc: { attempts: 1 } }, { new: true, sort: { createdAt: 1 } });
    if (!job) return;
    const filter = { _id: job._id, lease };
    try {
      const user = await User.findById(job.user).select('active');
      if (!user?.active) {
        await OutgoingMail.updateOne(filter, { $set: { status: 'CANCELLED' }, $unset: { lease: 1, lockedUntil: 1 } });
        continue;
      }
      const result = await mailTransport().sendMail({ from: env.MAIL_FROM, to: job.recipient, subject: job.subject, text: job.text });
      if (!result.accepted?.length) throw new Error('Recipient not accepted');
      await OutgoingMail.updateOne(filter, { $set: { status: 'SENT', sentAt: new Date() }, $unset: { lease: 1, lockedUntil: 1, lastError: 1 } });
    } catch {
      await OutgoingMail.updateOne(filter, { $set: { status: job.attempts >= 5 ? 'FAILED' : 'PENDING', nextAttemptAt: new Date(Date.now() + 60000 * 2 ** Math.min(job.attempts - 1, 5)), lastError: 'Delivery failed; retry scheduled or contact your administrator.' }, $unset: { lease: 1, lockedUntil: 1 } });
    }
  }
}
