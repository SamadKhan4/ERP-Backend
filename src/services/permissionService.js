import { Role } from '../models/Role.js';
import { rolePermissionDefaults } from '../constants/roles.js';
export async function permissionsFor(user) {
  // Team leaders are employees with delivery tools. Old stored grants must not restore CRM/HR administration.
  if (user.role === 'team_leader') return [...rolePermissionDefaults.team_leader];
  const role = await Role.findOne({ name: user.role }).lean();
  return [...new Set([...(rolePermissionDefaults[user.role] || []), ...(role?.permissions || [])])];
}
