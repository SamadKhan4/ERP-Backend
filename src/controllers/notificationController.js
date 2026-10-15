import mongoose from 'mongoose';
import { z } from 'zod';
import { Notification } from '../models/Notification.js';
import { AppError } from '../utils/errors.js';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z.enum(['true', 'false']).optional(),
}).passthrough();

export async function listNotifications(req, res) {
  const { limit, unreadOnly } = listSchema.parse(req.query);
  const filter = {
    recipient: req.user._id,
    ...(unreadOnly === 'true' ? { readAt: null } : {}),
  };
  const [items, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ recipient: req.user._id, readAt: null }),
  ]);
  res.json({
    success: true,
    message: 'Notifications fetched successfully',
    data: { items, unreadCount },
  });
}

export async function markNotificationRead(req, res) {
  if (!mongoose.isValidObjectId(req.params.id))
    throw new AppError(400, 'Invalid notification identifier');
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, recipient: req.user._id },
    { $set: { readAt: new Date() } },
    { new: true },
  );
  if (!notification) throw new AppError(404, 'Notification not found');
  res.json({ success: true, message: 'Notification marked as read', data: notification });
}

export async function markAllNotificationsRead(req, res) {
  const result = await Notification.updateMany(
    { recipient: req.user._id, readAt: null },
    { $set: { readAt: new Date() } },
  );
  res.json({
    success: true,
    message: 'All notifications marked as read',
    data: { updated: result.modifiedCount },
  });
}
