import { z } from 'zod';
import { OutgoingMail } from '../models/OutgoingMail.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
const compose = z.object({
  recipient: z.string().trim().email().max(254).regex(/^[^\r\n]+$/),
  subject: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/),
  text: z.string().trim().min(1).max(20000),
}).strict();
export async function send(req, res) {
  const input = compose.parse(req.body);
  if (env.MAIL_DELIVERY !== 'smtp') throw new AppError(503, 'Mail delivery is not configured');
  const row = await OutgoingMail.create({ ...input, user: req.user._id });
  res.status(202).json({ success: true, message: 'Email queued for delivery', data: { _id: row._id, status: row.status } });
}
export async function history(req, res) {
  const { page, status } = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), status: z.enum(['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED']).optional() }).strict().parse(req.query);
  const filter = { user: req.user._id, ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    OutgoingMail.find(filter).select('recipient subject text status attempts sentAt lastError createdAt').sort({ createdAt: -1 }).skip((page - 1) * 20).limit(20).lean(),
    OutgoingMail.countDocuments(filter),
  ]);
  res.json({ success: true, data: { items, page, totalPages: Math.ceil(total / 20), total, enabled: env.MAIL_DELIVERY === 'smtp', sender: env.MAIL_FROM } });
}
