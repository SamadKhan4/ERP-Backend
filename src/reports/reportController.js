import mongoose from 'mongoose';
import { z } from 'zod';
import {
  reportRegistry,
  reportCategories,
  reportPermissionNames,
} from './reportRegistry.js';
import {
  canReadReport,
  resolveReportScope,
  authorizeReport,
  requireReportPermission,
  hasReportPermission,
} from './reportAccessService.js';
import {
  reportFilters,
  catalogFilters,
  exportSchema,
  savedSchema,
  scheduleSchema,
} from './reportValidator.js';
import { executeReport } from './reportService.js';
import { renderReportExport, recordGeneration } from './reportExportService.js';
import {
  SavedReport,
  ScheduledReport,
  ReportGenerationLog,
} from '../models/ReportConfiguration.js';
import { AuditLog } from '../models/AuditLog.js';
import { Department } from '../models/Department.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { roleDefinitions, rolePermissionDefaults } from '../constants/roles.js';
import { permissionsFor } from '../services/permissionService.js';
import { nextSchedule } from './reportScheduleService.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
const ok = (res, data) => res.json({ success: true, data });
const id = (value) => {
  if (!mongoose.isValidObjectId(value))
    throw new AppError(400, 'Invalid report identifier');
  return value;
};
const visibleReports = (req) =>
  reportRegistry.filter((report) =>
    canReadReport(req.reportPermissions, report),
  );
async function sharedScope(req) {
  if (req.user.role === 'super_admin') return {};
  const profile = await EmployeeProfile.findOne({ user: req.user._id })
    .select('manager')
    .lean();
  const teammates = await EmployeeProfile.find({ manager: req.user._id })
    .select('user')
    .lean();
  return {
    $or: [
      { owner: req.user._id },
      { visibility: 'GLOBAL' },
      ...(req.user.department
        ? [{ visibility: 'DEPARTMENT', department: req.user.department }]
        : []),
      {
        visibility: 'TEAM',
        $or: [
          { team: profile?.manager || req.user._id },
          { team: req.user._id },
          {
            owner: { $in: teammates.map((row) => row.user) },
            team: req.user._id,
          },
        ],
      },
    ],
  };
}
export async function catalog(req, res) {
  const query = catalogFilters.parse(req.query);
  reportFilters.parse({
    from: query.from,
    to: query.to,
    department: query.department,
  });
  let items = visibleReports(req).filter(
    (report) =>
      (!query.category || report.category === query.category) &&
      (!query.search ||
        `${report.title} ${report.description}`
          .toLowerCase()
          .includes(query.search.toLowerCase())) &&
      (!query.type ||
        report.tab === query.type ||
        report.source === query.type) &&
      (!query.status ||
        Boolean(report.unavailable) === (query.status === 'unavailable')),
  );
  const scopes = new Map();
  for (const report of items)
    if (!scopes.has(report.category))
      scopes.set(report.category, await resolveReportScope(req, report));
  if (query.roleAccess)
    items = items.filter(
      (report) => scopes.get(report.category)?.scope === query.roleAccess,
    );
  const saved = (
    await SavedReport.find(await sharedScope(req))
      .select('reportKey')
      .lean()
  ).filter((row) => items.some((report) => report.key === row.reportKey));
  const allowedKeys = items.map((report) => report.key);
  const now = new Date(Date.now() + 19800000),
    first = new Date(`${now.toISOString().slice(0, 7)}-01T00:00:00+05:30`);
  const [scheduled, generated, recent] = await Promise.all([
    ScheduledReport.countDocuments({
      createdBy: req.user._id,
      reportKey: { $in: allowedKeys },
      status: 'ACTIVE',
    }),
    ReportGenerationLog.countDocuments({
      user: req.user._id,
      reportKey: { $in: allowedKeys },
      createdAt: { $gte: first },
    }),
    ReportGenerationLog.find({
      user: req.user._id,
      reportKey: { $in: allowedKeys },
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from
                ? { $gte: new Date(`${query.from}T00:00:00+05:30`) }
                : {}),
              ...(query.to
                ? {
                    $lt: new Date(
                      new Date(`${query.to}T00:00:00+05:30`).getTime() +
                        86400000,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    })
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
  ]);
  const categories = Object.entries(reportCategories)
    .map(([key, value]) => ({
      key,
      ...value,
      scope: scopes.get(key)?.scope || 'OWN',
      count: items.filter(
        (report) => report.category === key && !report.unavailable,
      ).length,
      saved: saved.filter((row) =>
        items.some(
          (report) => report.key === row.reportKey && report.category === key,
        ),
      ).length,
    }))
    .filter((category) =>
      items.some((report) => report.category === category.key),
    );
  const scopeIds = [...scopes.values()].flatMap((scope) => scope.ids || []);
  const allDepartments = [...scopes.values()].some((scope) => !scope.ids);
  const keys = allDepartments
    ? null
    : await User.distinct('department', { _id: { $in: scopeIds } });
  const departments = await Department.find(keys ? { key: { $in: keys } } : {})
    .select('name key status')
    .sort({ name: 1 })
    .limit(500)
    .lean();
  if (query.sort === 'name')
    items.sort((left, right) => left.title.localeCompare(right.title));
  const total = items.length;
  ok(res, {
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
    items: items
      .slice((query.page - 1) * query.limit, query.page * query.limit)
      .map((report) => ({
        ...report,
        scope: scopes.get(report.category)?.scope || 'OWN',
        canExport:
          hasReportPermission(req.reportPermissions, 'reports.export') &&
          hasReportPermission(
            req.reportPermissions,
            `reports.${report.category}.export`,
          ),
      })),
    categories,
    libraryCategories: Object.entries(reportCategories)
      .map(([key, value]) => ({
        key,
        ...value,
        count: visibleReports(req).filter(
          (report) => report.category === key && !report.unavailable,
        ).length,
      }))
      .filter((category) =>
        visibleReports(req).some((report) => report.category === category.key),
      ),
    departments,
    summary: {
      total: items.filter((report) => !report.unavailable).length,
      scheduled,
      generated,
      modules: categories.length,
    },
    recent,
    permissions: req.reportPermissions.filter(
      (permission) => permission === '*' || permission.startsWith('reports.'),
    ),
    scheduleDeliveryEnabled: env.MAIL_DELIVERY === 'smtp',
  });
}
export async function detail(req, res) {
  ok(res, await executeReport(req, req.params.reportKey, req.query));
}
export async function generate(req, res) {
  requireReportPermission(req, 'reports.generate');
  const input = exportSchema.parse(req.body);
  const data = await executeReport(req, req.params.reportKey, input.filters, {
    exportData: true,
  });
  const file = await renderReportExport(data, input.format, input.columns);
  await recordGeneration(req, data, input.format);
  res.type(file.mime).attachment(file.filename).send(file.buffer);
}
export async function recent(req, res) {
  const keys = visibleReports(req).map((report) => report.key);
  ok(
    res,
    await ReportGenerationLog.find({
      user: req.user._id,
      reportKey: { $in: keys },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  );
}
export async function analytics(req, res) {
  requireReportPermission(req, 'reports.manage_access');
  const keys = visibleReports(req).map((report) => report.key);
  const data = await ReportGenerationLog.aggregate([
    {
      $match: {
        reportKey: { $in: keys },
        createdAt: { $gte: new Date(Date.now() - 366 * 86400000) },
      },
    },
    {
      $facet: {
        categories: [{ $group: { _id: '$category', count: { $sum: 1 } } }],
        months: [
          {
            $group: {
              _id: {
                $dateToString: {
                  date: '$createdAt',
                  format: '%Y-%m',
                  timezone: 'Asia/Kolkata',
                },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
        popular: [
          { $group: { _id: '$title', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ],
      },
    },
  ]);
  ok(res, data[0]);
}
export async function savedList(req, res) {
  const keys = visibleReports(req).map((report) => report.key);
  ok(
    res,
    await SavedReport.find({
      $and: [await sharedScope(req), { reportKey: { $in: keys } }],
    })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean(),
  );
}
function validateColumns(report, columns, sort) {
  if (
    columns.some((column) => !report.columns.includes(column)) ||
    (sort && !report.columns.includes(sort.field))
  )
    throw new AppError(400, 'Invalid saved columns or sort field');
}
export async function saveView(req, res) {
  requireReportPermission(req, 'reports.manage_templates');
  const input = savedSchema.parse(req.body),
    report = authorizeReport(req, input.reportKey);
  if (report.unavailable) throw new AppError(409, report.unavailable);
  validateColumns(report, input.columns, input.sort);
  if (input.visibility === 'GLOBAL')
    requireReportPermission(req, 'reports.manage_access');
  if (input.visibility === 'DEPARTMENT' && !req.user.department)
    throw new AppError(400, 'No department assigned');
  const access = await resolveReportScope(req, report),
    profile = await EmployeeProfile.findOne({ user: req.user._id })
      .select('manager')
      .lean();
  const data = {
    ...input,
    owner: req.user._id,
    scope: access.scope,
    department: req.user.department,
    team: profile?.manager || req.user._id,
  };
  if (req.params.id && req.user.role === 'super_admin') {
    const existing = await SavedReport.findById(id(req.params.id)).lean();
    if (!existing) throw new AppError(404, 'Saved view not found');
    Object.assign(data, {
      owner: existing.owner,
      department: existing.department,
      team: existing.team,
    });
  }
  let row;
  if (req.params.id)
    row = await SavedReport.findOneAndUpdate(
      {
        _id: id(req.params.id),
        ...(req.user.role === 'super_admin' ? {} : { owner: req.user._id }),
      },
      { $set: data },
      { new: true, runValidators: true },
    );
  else {
    if ((await SavedReport.countDocuments({ owner: req.user._id })) >= 100)
      throw new AppError(409, 'Maximum 100 saved views per user');
    row = await SavedReport.create(data);
  }
  if (!row) throw new AppError(404, 'Saved view not found');
  await AuditLog.create({
    user: req.user._id,
    action: 'reports.saved',
    entityType: 'saved_report',
    entityId: row._id,
    details: {
      reportKey: report.key,
      scope: access.scope,
      visibility: input.visibility,
    },
  });
  ok(res, row);
}
export async function deleteView(req, res) {
  requireReportPermission(req, 'reports.manage_templates');
  if (
    !(await SavedReport.findOneAndDelete({
      _id: id(req.params.id),
      ...(req.user.role === 'super_admin' ? {} : { owner: req.user._id }),
    }))
  )
    throw new AppError(404, 'Saved view not found');
  ok(res, { deleted: true });
}
export async function scheduleList(req, res) {
  requireReportPermission(req, 'reports.schedule');
  const keys = visibleReports(req).map((report) => report.key);
  ok(res, {
    items: await ScheduledReport.find({
      ...(req.user.role === 'super_admin' ? {} : { createdBy: req.user._id }),
      reportKey: { $in: keys },
    })
      .select('-lease')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean(),
    deliveryEnabled: env.MAIL_DELIVERY === 'smtp',
    recipient: req.user.email,
  });
}
export async function schedule(req, res) {
  requireReportPermission(req, 'reports.schedule');
  requireReportPermission(req, 'reports.generate');
  const input = scheduleSchema.parse(req.body),
    report = authorizeReport(req, input.reportKey, { exportData: true });
  if (report.unavailable) throw new AppError(409, report.unavailable);
  let owner = req.user;
  if (req.params.id && req.user.role === 'super_admin') {
    const existing = await ScheduledReport.findById(id(req.params.id))
      .select('createdBy')
      .lean();
    if (!existing) throw new AppError(404, 'Schedule not found');
    owner = await User.findById(existing.createdBy);
    if (!owner) throw new AppError(404, 'Schedule owner no longer exists');
  }
  if (input.recipients[0].toLowerCase() !== owner.email.toLowerCase())
    throw new AppError(
      403,
      'Scheduled reports can only be delivered to the schedule owner’s account email',
    );
  const data = {
    ...input,
    createdBy: owner._id,
    nextRunAt: nextSchedule(input.frequency),
  };
  let row;
  if (req.params.id)
    row = await ScheduledReport.findOneAndUpdate(
      {
        _id: id(req.params.id),
        createdBy: owner._id,
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: new Date() } }],
      },
      { $set: data, $unset: { lastError: 1 } },
      { new: true },
    );
  else {
    if (
      (await ScheduledReport.countDocuments({ createdBy: req.user._id })) >= 20
    )
      throw new AppError(409, 'Maximum 20 schedules per user');
    row = await ScheduledReport.create(data);
  }
  if (!row)
    throw new AppError(409, 'Schedule is unavailable or currently running');
  await AuditLog.create({
    user: req.user._id,
    action: 'reports.schedule_modified',
    entityType: 'scheduled_report',
    entityId: row._id,
    details: { reportKey: report.key, frequency: input.frequency },
  });
  ok(res, row);
}
export async function access(req, res) {
  requireReportPermission(req, 'reports.manage_access');
  const items = [];
  for (const role of roleDefinitions)
    items.push({
      ...role,
      permissions: (await permissionsFor({ role: role.name })).filter(
        (permission) => permission === '*' || permission.startsWith('reports.'),
      ),
      defaults: (rolePermissionDefaults[role.name] || []).filter(
        (permission) => permission === '*' || permission.startsWith('reports.'),
      ),
    });
  ok(res, { items, permissions: reportPermissionNames });
}
export async function changeAccess(req, res) {
  requireReportPermission(req, 'reports.manage_access');
  // Only Super Admin can delegate access-management itself or change the Admin role.
  const role = roleDefinitions.find((entry) => entry.name === req.params.role);
  if (!role || role.name === 'super_admin')
    throw new AppError(400, 'Super Admin access is immutable');
  const input = z
    .object({ permissions: z.array(z.enum(reportPermissionNames)).max(200) })
    .strict()
    .parse(req.body);
  if (
    req.user.role !== 'super_admin' &&
    (['admin', req.user.role].includes(role.name) ||
      input.permissions.includes('reports.manage_access'))
  )
    throw new AppError(
      403,
      'Only Super Admin can change privileged reporting access',
    );
  if (
    req.user.role !== 'super_admin' &&
    input.permissions.some(
      (permission) => !hasReportPermission(req.reportPermissions, permission),
    )
  )
    throw new AppError(
      403,
      'You cannot delegate report permissions you do not hold',
    );
  await Role.updateOne(
    { name: role.name },
    {
      $set: {
        label: role.label,
        reportPermissions: [...new Set(input.permissions)],
      },
      $setOnInsert: { name: role.name },
    },
    { upsert: true },
  );
  await AuditLog.create({
    user: req.user._id,
    action: 'reports.permissions_changed',
    entityType: 'role',
    details: { role: role.name, permissions: input.permissions },
  });
  ok(res, { updated: true });
}
