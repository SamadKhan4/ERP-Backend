import mongoose from 'mongoose';
import { permissionsFor } from '../services/permissionService.js';
import { resolveReportScope } from '../reports/reportAccessService.js';
import { Client } from '../models/Client.js';
import { Project } from '../models/Project.js';
import { AppError } from '../utils/errors.js';
export { financePermissions } from './financePermissions.js';
export const hasFinance = (req, permission) =>
  req.financePermissions.includes('*') ||
  req.financePermissions.includes(permission);
export const requireFinance = (permission) => (req, res, next) => {
  if (!hasFinance(req, permission))
    throw new AppError(403, 'Finance permission denied');
  next();
};
export async function financeAccess(req, res, next) {
  req.financePermissions = await permissionsFor(req.user);
  const reportPermissions = req.financePermissions.includes('*')
    ? ['*']
    : req.financePermissions
        .filter((permission) => permission.startsWith('finance.scope.'))
        .map((permission) =>
          permission.replace('finance.scope.', 'reports.finance.'),
        );
  req.financeScope = await resolveReportScope(
    { user: req.user, reportPermissions },
    { category: 'finance' },
  );
  const ids = req.financeScope.ids;
  req.financeClientIds = ids
    ? await Client.distinct('_id', {
        $or: [{ createdBy: { $in: ids } }, { assignedTo: { $in: ids } }],
      })
    : null;
  req.financeProjectIds = ids
    ? await Project.distinct('_id', { assignedTo: { $in: ids } })
    : null;
  next();
}
export function financeScope(req, kind) {
  const ids = req.financeScope.ids;
  if (!ids) return {};
  if (kind === 'invoices')
    return {
      $or: [
        { createdBy: { $in: ids } },
        { clientRef: { $in: req.financeClientIds } },
        { project: { $in: req.financeProjectIds } },
      ],
    };
  if (kind === 'clients') return { _id: { $in: req.financeClientIds } };
  if (kind === 'expenses')
    return {
      $or: [
        { createdBy: { $in: ids } },
        { employee: { $in: ids } },
        { project: { $in: req.financeProjectIds } },
      ],
    };
  if (kind === 'recurring')
    return {
      $or: [
        { createdBy: { $in: ids } },
        { accountManager: { $in: ids } },
        { client: { $in: req.financeClientIds } },
      ],
    };
  return { createdBy: { $in: ids } };
}
export function financeId(value) {
  if (!mongoose.isValidObjectId(value))
    throw new AppError(400, 'Invalid finance record identifier');
  return new mongoose.Types.ObjectId(String(value));
}
