import { Role } from '../models/Role.js';
import { rolePermissionDefaults } from '../constants/roles.js';
export async function permissionsFor(user) {
  // Team leaders are employees with delivery tools. Old stored grants must not restore CRM/HR administration.
  const role = await Role.findOne({ name: user.role }).lean();
  let permissions = [...new Set([...(rolePermissionDefaults[user.role] || []), ...(role?.permissions || [])])];
  if (user.role === 'team_leader') permissions = [...new Set([...rolePermissionDefaults.team_leader, ...(role?.permissions || []).filter((permission) => permission.startsWith('reports.'))])];
  if (user.role !== 'super_admin' && role?.reportPermissions !== undefined) permissions = [...permissions.filter((permission) => !permission.startsWith('reports.')), ...role.reportPermissions];
  if (user.role !== 'super_admin' && role?.financePermissions !== undefined) permissions = [...permissions.filter((permission) => !permission.startsWith('finance.')), ...role.financePermissions];
  if (user.role !== 'super_admin' && role?.projectPermissions !== undefined) permissions = [...permissions.filter((permission) => !permission.startsWith('projects.')), ...role.projectPermissions];
  return permissions;
}
