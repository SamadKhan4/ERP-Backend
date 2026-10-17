import mongoose from 'mongoose';
import { TeamTask } from '../models/TeamWork.js';
import { Counter } from '../models/Counter.js';
import { AuditLog } from '../models/AuditLog.js';
import { Notification } from '../models/Notification.js';
import { Department } from '../models/Department.js';
import { User } from '../models/User.js';
import { Client } from '../models/Client.js';
import { Lead } from '../models/Lead.js';
import { Quotation } from '../models/Quotation.js';
import { AppError } from '../utils/errors.js';
import { oid, canProject } from './projectAccess.js';
import { normalizeStatus } from './projectPermissions.js';
export const indiaDay = () =>
  new Date(
    `${new Date(Date.now() + 19800000).toISOString().slice(0, 10)}T00:00:00+05:30`,
  );
export const transaction = (fn) => mongoose.connection.transaction(fn);
export async function number(kind, session) {
  const row = await Counter.findOneAndUpdate(
    {
      _id:
        kind === 'TASK'
          ? 'team-task'
          : kind === 'PRJ'
            ? 'erp-project'
            : `projects.${kind}`,
    },
    { $inc: { value: 1 } },
    { upsert: true, new: true, session },
  );
  return `ADB/${kind}/${String(row.value).padStart(4, '0')}`;
}
export async function event(req, row, type, details = {}, session) {
  await AuditLog.create(
    [
      {
        user: req.user._id,
        action: `project.${type}`,
        entityType: 'project',
        entityId: row._id,
        details,
      },
    ],
    { session },
  );
}
export async function notify(req, row, type, title, recipients, session) {
  const ids = [...new Set(recipients.filter(Boolean).map(String))].filter(
    (id) => id !== String(req.user._id),
  );
  if (ids.length)
    await Notification.insertMany(
      ids.map((recipient) => ({
        recipient,
        type: `project.${type}`,
        title,
        message: `${row.title} (${row.projectId})`,
        link: `/projects/${row._id}`,
        entityType: 'project',
        entityId: row._id,
        createdBy: req.user._id,
      })),
      { session },
    );
}
export const memberIds = (row) =>
  [
    row.projectManager || row.assignedTo,
    ...row.teamMembers
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => m.employee),
  ].filter(Boolean);
export async function validateProject(req, input, session, existing) {
  if (
    existing &&
    String(existing.projectManager || existing.assignedTo) !==
      input.projectManager &&
    !canProject(req, 'assign_manager')
  )
    throw new AppError(403, 'Manager assignment permission required');
  if (
    !existing &&
    !canProject(req, 'assign_manager') &&
    input.projectManager !== String(req.user._id)
  )
    throw new AppError(403, 'You can only assign yourself as manager');
  const deps = [input.primaryDepartment, ...input.collaboratingDepartments];
  if (
    (await Department.countDocuments({
      _id: { $in: deps },
      status: 'ACTIVE',
    }).session(session)) !== new Set(deps).size
  )
    throw new AppError(400, 'Select active departments');
  if (
    canProject(req, 'view_department') &&
    !canProject(req, 'view_all') &&
    !req.projectDepartments.some((id) => String(id) === input.primaryDepartment)
  )
    throw new AppError(403, 'Department outside your scope');
  if (
    !(await User.exists({
      _id: input.projectManager,
      active: true,
      role: { $ne: 'customer' },
    }).session(session))
  )
    throw new AppError(400, 'Project manager must be an active staff user');
  if (
    input.clientRef &&
    !(await Client.exists({ _id: input.clientRef }).session(session))
  )
    throw new AppError(400, 'Client not found');
  if (input.lead) {
    const lead = await Lead.findOne({
      _id: input.lead,
      deletedAt: null,
    }).session(session);
    if (!lead) throw new AppError(400, 'Lead not found');
    if (
      input.clientRef &&
      !(await Client.exists({
        _id: input.clientRef,
        originatingLead: lead._id,
      }).session(session))
    )
      throw new AppError(400, 'Lead does not belong to selected client');
  }
  if (input.quotation) {
    const quote = await Quotation.findOne({
      _id: input.quotation,
      clientRef: input.clientRef,
      deletedAt: null,
      status: 'Accepted',
    }).session(session);
    if (!quote)
      throw new AppError(400, 'Choose an accepted quotation for this client');
    if (input.lead && String(quote.lead) !== input.lead)
      throw new AppError(400, 'Quotation and lead do not match');
  }
  if (input.amount !== undefined && !canProject(req, 'financials.view'))
    throw new AppError(403, 'Financial permission required to set budget');
}
export function projectFilter(req, q = {}) {
  const parts = [
    req.projectScope,
    q.archived === 'true'
      ? { archivedAt: { $ne: null } }
      : { archivedAt: null },
  ];
  if (q.search) {
    const regex = q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    parts.push({
      $or: [
        ...['title', 'projectId', 'projectCode'].map((key) => ({
          [key]: { $regex: regex, $options: 'i' },
        })),
        { clientRef: { $in: req.projectSearchClients || [] } },
      ],
    });
  }
  for (const [query, key] of [
    ['department', 'primaryDepartment'],
    ['manager', 'projectManager'],
    ['client', 'clientRef'],
  ])
    if (q[query]) parts.push({ [key]: oid(q[query]) });
  if (q.priority) parts.push({ priority: q.priority });
  if (q.service) parts.push({ service: q.service });
  if (q.from || q.to)
    parts.push({
      startDate: {
        ...(q.from ? { $gte: q.from } : {}),
        ...(q.to ? { $lt: new Date(+q.to + 86400000) } : {}),
      },
    });
  return { $and: parts };
}
export function projectStages(req, q = {}) {
  const match = projectFilter(req, q);
  return [
    { $match: match },
    {
      $set: {
        status: {
          $switch: {
            branches: Object.entries({
              Planned: 'UPCOMING',
              Active: 'ONGOING',
              Completed: 'COMPLETED',
              'On Hold': 'ON_HOLD',
              Cancelled: 'CANCELLED',
            }).map(([old, value]) => ({
              case: { $eq: ['$status', old] },
              then: value,
            })),
            default: '$status',
          },
        },
      },
    },
    {
      $set: {
        delayed: {
          $and: [
            { $lt: ['$deadline', indiaDay()] },
            { $ne: [{ $ifNull: ['$deadline', null] }, null] },
            { $not: [{ $in: ['$status', ['COMPLETED', 'CANCELLED']] }] },
          ],
        },
      },
    },
    ...(q.status
      ? [
          {
            $match:
              q.status === 'DELAYED' ? { delayed: true } : { status: q.status },
          },
        ]
      : []),
  ];
}
export const populateProject = (query) =>
  query
    .populate('clientRef', 'companyName clientId')
    .populate('primaryDepartment collaboratingDepartments', 'name code')
    .populate('projectManager assignedTo', 'name email')
    .populate('teamMembers.employee', 'name email')
    .populate('lead', 'leadId leadSource assignedTo')
    .populate('quotation', 'quotationNumber services');
export async function presentProjects(rows, req) {
  const taskCounts = await TeamTask.aggregate([
    { $match: { project: { $in: rows.map((r) => r._id) }, deletedAt: null } },
    {
      $group: {
        _id: '$project',
        total: { $sum: 1 },
        done: { $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] } },
        blocked: { $sum: { $cond: [{ $eq: ['$status', 'BLOCKED'] }, 1, 0] } },
      },
    },
  ]);
  const map = new Map(taskCounts.map((r) => [String(r._id), r]));
  return rows.map((r) => {
    const row = r.toObject ? r.toObject() : r;
    row.status = normalizeStatus(row.status);
    const t = map.get(String(row._id)) || { total: 0, done: 0, blocked: 0 };
    row.taskSummary = t;
    row.progress =
      row.status === 'COMPLETED'
        ? 100
        : t.total
          ? Math.round((t.done / t.total) * 100)
          : 0;
    row.daysOverdue = row.deadline
      ? Math.max(
          0,
          Math.floor((+indiaDay() - new Date(row.deadline)) / 86400000),
        )
      : 0;
    row.daysRemaining = row.deadline
      ? Math.ceil((new Date(row.deadline) - indiaDay()) / 86400000)
      : null;
    row.delayed =
      !['COMPLETED', 'CANCELLED'].includes(row.status) && row.daysOverdue > 0;
    row.health = row.delayed
      ? 'DELAYED'
      : !['COMPLETED', 'CANCELLED'].includes(row.status) &&
          ((row.daysRemaining !== null &&
            row.daysRemaining <= 7 &&
            row.progress < 80) ||
            t.blocked > 0)
        ? 'AT_RISK'
        : 'ON_TRACK';
    if (!canProject(req, 'financials.view')) {
      delete row.amount;
      delete row.currency;
      delete row.billingType;
    }
    return row;
  });
}
