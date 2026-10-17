import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { Department } from '../models/Department.js';
import { TeamTask } from '../models/TeamWork.js';
import { permissionsFor } from '../services/permissionService.js';
import { AppError } from '../utils/errors.js';
import { findReport } from './reportRegistry.js';
export const hasReportPermission = (permissions, key) =>
  permissions.includes('*') || permissions.includes(key);
export function canReadReport(permissions, report) {
  return (
    hasReportPermission(permissions, 'reports.view') &&
    hasReportPermission(permissions, report.permission) &&
    (!report.extraPermission ||
      hasReportPermission(permissions, report.extraPermission))
  );
}
export async function reportAccess(req, res, next) {
  req.reportPermissions = await permissionsFor(req.user);
  if (!hasReportPermission(req.reportPermissions, 'reports.view'))
    throw new AppError(403, 'Reports access denied');
  next();
}
export function requireReportPermission(req, permission) {
  if (!hasReportPermission(req.reportPermissions, permission))
    throw new AppError(403, 'Report permission denied');
}
export function authorizeReport(req, key, { exportData = false } = {}) {
  const report = findReport(key);
  if (!report) throw new AppError(404, 'Report not found');
  if (!canReadReport(req.reportPermissions, report))
    throw new AppError(403, 'You do not have permission to view this report');
  if (exportData) {
    requireReportPermission(req, 'reports.export');
    requireReportPermission(req, `reports.${report.category}.export`);
  }
  return report;
}
const oid = (value) => new mongoose.Types.ObjectId(String(value));
export async function resolveReportScope(req, report) {
  const permissions = req.reportPermissions,
    category = report.category;
  let scope = 'OWN',
    ids = [oid(req.user._id)];
  if (hasReportPermission(permissions, `reports.${category}.all`)) {
    scope = 'ALL';
    ids = null;
  } else if (
    hasReportPermission(permissions, `reports.${category}.department`)
  ) {
    scope = 'DEPARTMENT';
    const heads = await Department.find({
      $or: [{ head: req.user._id }, { reportingManager: req.user._id }],
    })
      .select('key')
      .lean();
    const keys = [
      ...new Set(
        [
          req.user.department,
          ...heads.map((department) => department.key),
        ].filter(Boolean),
      ),
    ];
    ids = (
      await User.find({ department: { $in: keys }, role: { $ne: 'customer' } })
        .select('_id')
        .lean()
    ).map((user) => user._id);
  } else if (hasReportPermission(permissions, `reports.${category}.team`)) {
    scope = 'TEAM';
    const rows = await EmployeeProfile.aggregate([
      { $match: { manager: oid(req.user._id) } },
      {
        $graphLookup: {
          from: 'employeeprofiles',
          startWith: '$user',
          connectFromField: 'user',
          connectToField: 'manager',
          as: 'descendants',
          maxDepth: 20,
        },
      },
      { $project: { user: 1, descendants: '$descendants.user' } },
    ]).option({ maxTimeMS: 10000 });
    const assigned = await TeamTask.distinct('assignedTo', {
      leader: req.user._id,
      deletedAt: null,
    });
    ids = [
      ...new Set([
        String(req.user._id),
        ...assigned.filter(Boolean).map(String),
        ...rows.flatMap((row) => [row.user, ...row.descendants]).map(String),
      ]),
    ].map(oid);
  } else if (hasReportPermission(permissions, `reports.${category}.assigned`))
    scope = 'ASSIGNED';
  // HR's existing employee hierarchy remains a boundary even with broad operational grants.
  if (req.user.role === 'hr') {
    const allowed = await User.find({
      role: { $in: ['employee', 'executive', 'team_leader', 'lead_caller'] },
      ...(ids ? { _id: { $in: ids } } : {}),
    })
      .select('_id')
      .lean();
    ids = allowed.map((user) => user._id);
  }
  return { scope, ids };
}
