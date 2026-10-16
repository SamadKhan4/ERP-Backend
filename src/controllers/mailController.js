import mongoose from 'mongoose';
import { z } from 'zod';
import { User } from '../models/User.js';
import { MailJob } from '../models/MailJob.js';
import { env } from '../config/env.js';
import { queueWelcome, auditMailResend } from '../services/mailService.js';
import { AppError } from '../utils/errors.js';
const staff = ['employee', 'executive', 'team_leader', 'lead_caller'];
const roles = { super_admin: ['admin', 'manager', 'hr', ...staff], admin: ['manager', 'hr', ...staff], manager: ['hr'], hr: staff };
function scope(req) {
  if (!roles[req.user.role]) throw new AppError(403, 'Mail management access denied');
  return { role: { $in: roles[req.user.role] } };
}
export async function list(req, res) {
  const filter = scope(req);
  const query = z.object({ page: z.coerce.number().int().min(1).default(1) }).strict().parse(req.query);
  const [users, total] = await Promise.all([
    User.find(filter).select('name email role active').sort({ createdAt: -1 }).skip((query.page - 1) * 20).limit(20).lean(),
    User.countDocuments(filter),
  ]);
  const jobs = await MailJob.find({ user: { $in: users.map((user) => user._id) } }).select('user status attempts sentAt lastError updatedAt').lean();
  const byUser = new Map(jobs.map((job) => [String(job.user), job]));
  res.json({ success: true, data: { enabled: env.MAIL_DELIVERY === 'smtp', items: users.map((user) => ({ ...user, delivery: byUser.get(String(user._id)) || null })), page: query.page, total, totalPages: Math.ceil(total / 20) } });
}
export async function resend(req, res) {
  const filter = scope(req);
  z.object({}).strict().parse(req.body || {});
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError(400, 'Invalid user identifier');
  const user = await User.findOne({ ...filter, _id: req.params.id, active: true });
  if (!user) throw new AppError(404, 'Active managed user not found');
  if (env.MAIL_DELIVERY !== 'smtp') throw new AppError(503, 'Mail delivery is not enabled');
  const data = await queueWelcome(user);
  await auditMailResend(req.user, user);
  res.status(202).json({ success: true, message: 'Welcome email queued', data });
}
