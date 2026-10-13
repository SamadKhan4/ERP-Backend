import { AppError } from '../utils/errors.js';

// Apply after authenticate and authorize on future department-scoped endpoints.
// Resolve the department from the stored resource, not client-supplied claims.
export const authorizeDepartment =
  (resolveDepartment) => async (req, res, next) => {
    if (!req.user) throw new AppError(401, 'Authentication required');
    if (req.user.role === 'team_leader') {
      const department = await resolveDepartment(req);
      if (
        !req.user.department ||
        !department ||
        req.user.department !== department
      ) {
        throw new AppError(403, 'Department access denied');
      }
    }
    next();
  };
