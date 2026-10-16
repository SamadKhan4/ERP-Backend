import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { AuditLog } from '../models/AuditLog.js';
import { AppError } from '../utils/errors.js';
import { password } from '../validators/authValidator.js';
import { deleteAccount } from '../services/accountDeletionService.js';

export const manageableRoles = {
  super_admin: ['admin', 'manager', 'hr'],
  admin: ['manager', 'hr'],
  manager: ['hr'],
};

const managedRole = z.enum(['admin', 'manager', 'hr']);
const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  role: managedRole,
  temporaryPassword: password,
}).strict();
const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()).optional(),
  role: managedRole.optional(),
  active: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

function allowedFor(actorRole) {
  const allowed = manageableRoles[actorRole];
  if (!allowed) throw new AppError(403, 'User management access denied');
  return allowed;
}

function ensureId(id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(400, 'Invalid user identifier');
}

async function manageableUser(req) {
  ensureId(req.params.id);
  const user = await User.findById(req.params.id);
  if (!user || !allowedFor(req.user.role).includes(user.role)) throw new AppError(404, 'Managed user not found');
  return user;
}

export async function listManagedUsers(req, res) {
  const items = await User.find({ role: { $in: allowedFor(req.user.role) } })
    .select('_id name email role active createdAt updatedAt')
    .sort({ _id: -1 })
    .lean();
  res.json({ success: true, data: { items } });
}

export async function createManagedUser(req, res) {
  const input = createSchema.parse(req.body);
  if (!allowedFor(req.user.role).includes(input.role)) throw new AppError(403, `You cannot create a ${input.role.replaceAll('_', ' ')}`);
  const user = await User.create({
    name: input.name,
    email: input.email,
    role: input.role,
    passwordHash: await bcrypt.hash(input.temporaryPassword, 12),
    active: true,
  });
  await AuditLog.create({ user: req.user.id, action: 'user_management.created', entityType: 'user', entityId: user.id, details: { role: user.role } });
  res.status(201).json({ success: true, message: 'User created successfully', data: { _id: user._id, name: user.name, email: user.email, role: user.role, active: user.active, createdAt: user.createdAt } });
}

export async function updateManagedUser(req, res) {
  const input = updateSchema.parse(req.body);
  const user = await manageableUser(req);
  if (input.role && !allowedFor(req.user.role).includes(input.role)) throw new AppError(403, `You cannot assign the ${input.role.replaceAll('_', ' ')} role`);
  Object.assign(user, input);
  if (input.active === false) user.tokenVersion += 1;
  await user.save();
  if (input.active === false) await Session.deleteMany({ user: user.id });
  await AuditLog.create({ user: req.user.id, action: 'user_management.updated', entityType: 'user', entityId: user.id, details: { role: user.role, active: user.active } });
  res.json({ success: true, message: 'User updated successfully', data: { _id: user._id, name: user.name, email: user.email, role: user.role, active: user.active, createdAt: user.createdAt } });
}

export async function deactivateManagedUser(req, res) {
  const user = await manageableUser(req);
  user.active = false;
  user.tokenVersion += 1;
  await Promise.all([
    user.save(),
    Session.deleteMany({ user: user.id }),
    AuditLog.create({ user: req.user.id, action: 'user_management.deactivated', entityType: 'user', entityId: user.id, details: { role: user.role } }),
  ]);
  res.json({ success: true, message: 'User deactivated successfully' });
}

export async function deleteManagedUser(req, res) {
  const { confirmation } = z.object({ confirmation: z.string().email() }).strict().parse(req.body);
  const data = await deleteAccount({ actor: req.user, targetId: req.params.id, channel: 'managed', confirmation });
  res.json({ success: true, message: 'User and related records permanently deleted', data });
}
