import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { permissionsFor } from './permissionService.js';
export { permissionsFor } from './permissionService.js';
import { AppError } from '../utils/errors.js';
export const has = (permissions, permission) =>
  permissions.includes('*') || permissions.includes(permission);
export async function loadCRMAccess(req, res, next) {
  req.crmPermissions = await permissionsFor(req.user);
  const profiles = has(req.crmPermissions, 'crm.leads.view_team')
    ? await EmployeeProfile.find({ manager: req.user._id })
        .select('user')
        .lean()
    : [];
  req.crmTeamIds = [req.user._id, ...profiles.map((profile) => profile.user)];
  next();
}
export const requireCRM =
  (...permissions) =>
  (req, res, next) => {
    if (!permissions.some((permission) => has(req.crmPermissions, permission)))
      throw new AppError(403, 'CRM permission denied');
    next();
  };
export function leadScope(req) {
  if (has(req.crmPermissions, 'crm.leads.view')) return {};
  if (has(req.crmPermissions, 'crm.leads.view_team'))
    return { assignedTo: { $in: req.crmTeamIds } };
  if (has(req.crmPermissions, 'crm.leads.view_own'))
    return { assignedTo: req.user._id };
  throw new AppError(403, 'Lead access denied');
}
export function id(value) {
  if (!mongoose.isValidObjectId(value))
    throw new AppError(400, 'Invalid identifier');
  return new mongoose.Types.ObjectId(String(value));
}
export async function validateAssignee(req, value) {
  if (!value) return;
  const user = await User.findOne({ _id: id(value), active: true }).select(
    '_id role',
  );
  if (!user) throw new AppError(400, 'Assigned employee is unavailable');
  const permissions = await permissionsFor(user);
  if (
    !['crm.leads.view', 'crm.leads.view_own', 'crm.leads.view_team'].some(
      (permission) => has(permissions, permission),
    )
  )
    throw new AppError(400, 'Assigned employee needs CRM lead access');
  if (
    !has(req.crmPermissions, 'crm.leads.view') &&
    !req.crmTeamIds.some((entry) => String(entry) === String(value))
  )
    throw new AppError(403, 'Assignment outside your team is forbidden');
}
