import mongoose from 'mongoose';
import { Counter } from '../models/Counter.js';
import { AuditLog } from '../models/AuditLog.js';
import { LeadActivity } from '../models/LeadActivity.js';
import { AppError } from '../utils/errors.js';
export async function transaction(work) {
  try {
    return await mongoose.connection.transaction(work);
  } catch (error) {
    if (
      error.code === 20 ||
      /Transaction numbers are only allowed/.test(error.message)
    )
      throw new AppError(
        503,
        'CRM writes require MongoDB replica set support. Enable the existing local replica set configuration.',
      );
    if (error.code === 11000)
      throw new AppError(
        409,
        'A record with this phone, email, or business identifier already exists',
      );
    throw error;
  }
}
export async function numberFor(key, prefix, session) {
  const counter = await Counter.findByIdAndUpdate(
    key,
    { $inc: { value: 1 } },
    { new: true, upsert: true, session },
  );
  return `${prefix}${String(counter.value).padStart(4, '0')}`;
}
export async function recordChange(
  req,
  lead,
  type,
  title,
  metadata,
  session,
  description = '',
) {
  await LeadActivity.create(
    [
      {
        lead: lead._id,
        type,
        title,
        description,
        metadata,
        performedBy: req.user._id,
      },
    ],
    { session },
  );
  await AuditLog.create(
    [
      {
        user: req.user._id,
        action: `crm.${type.toLowerCase()}`,
        entityType: 'lead',
        entityId: lead._id,
        details: metadata,
      },
    ],
    { session },
  );
  lead.lastActivityAt = new Date();
}
