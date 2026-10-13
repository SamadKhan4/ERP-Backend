import { AppError } from '../utils/errors.js';

export const hrVisibleEmployeeRoles = [
  'executive',
  'team_leader',
  'employee',
  'lead_caller',
];

export const employeeRoleFilterFor = (actorRole) =>
  actorRole === 'hr'
    ? { $in: hrVisibleEmployeeRoles }
    : { $ne: 'customer' };

export function assertEmployeeTargetAccess(actorRole, targetRole) {
  if (actorRole === 'hr' && !hrVisibleEmployeeRoles.includes(targetRole))
    throw new AppError(403, 'HR cannot access or manage this account');
}
