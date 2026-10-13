import { verifyToken } from '../services/tokenService.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { AppError } from '../utils/errors.js';
import { rolePermissionDefaults } from '../constants/roles.js';
export async function authenticate(req, res, next) {
  let payload;
  try {
    payload = verifyToken(
      req.headers.authorization?.replace(/^Bearer /, '') || '',
      'access',
    );
  } catch {
    throw new AppError(401, 'Authentication required');
  }
  req.user = await User.findById(payload.sub);
  if (!req.user?.active || req.user.tokenVersion !== payload.version)
    throw new AppError(401, 'Authentication required');
  next();
}
export const authorize = (permission) => async (req, res, next) => {
  const role = await Role.findOne({ name: req.user.role });
  const permissions = new Set([
    ...(rolePermissionDefaults[req.user.role] || []),
    ...(role?.permissions || []),
  ]);
  if (
    req.user.role !== 'super_admin' &&
    !permissions.has(permission)
  )
    throw new AppError(403, 'Permission denied');
  next();
};
