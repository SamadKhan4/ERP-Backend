import { verifyToken } from '../services/tokenService.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/errors.js';
import { permissionsFor } from '../services/permissionService.js';
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
  const permissions = new Set(await permissionsFor(req.user));
  if (
    req.user.role !== 'super_admin' &&
    !permissions.has(permission)
  )
    throw new AppError(403, 'Permission denied');
  next();
};
