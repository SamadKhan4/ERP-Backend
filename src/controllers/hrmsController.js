import mongoose from 'mongoose';
import { HRMSRecord } from '../models/HRMSRecord.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { User } from '../models/User.js';
import { AuditLog } from '../models/AuditLog.js';
import { departments } from '../constants/departments.js';
import {
  hrmsResourceDefinitions,
  parseRecordCreate,
  parseRecordUpdate,
  recordListSchema,
} from '../validators/hrmsValidator.js';
import { AppError } from '../utils/errors.js';

function definitionFor(resource) {
  const definition = hrmsResourceDefinitions[resource];
  if (!definition) throw new AppError(404, 'HRMS resource not found');
  return definition;
}

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scopeFilter(req, query = {}) {
  if (req.user.role === 'team_leader') {
    if (!req.user.department) throw new AppError(403, 'Department required');
    return { ...query, department: req.user.department };
  }
  return query;
}

async function audit(req, action, record, details) {
  await AuditLog.create({
    user: req.user.id,
    action,
    entityType: record.module,
    entityId: record._id,
    details,
  });
}

export async function listRecords(req, res) {
  definitionFor(req.params.resource);
  const query = recordListSchema.parse(req.query);
  const filter = scopeFilter(req, {
    module: req.params.resource,
    deletedAt: null,
    ...(query.cursor ? { _id: { $lt: query.cursor } } : {}),
    ...(query.department ? { department: query.department } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.employee ? { employee: query.employee } : {}),
    ...(query.search
      ? { title: { $regex: escapeRegExp(query.search), $options: 'i' } }
      : {}),
  });
  const rows = await HRMSRecord.find(filter)
    .populate('employee', 'name email role department active')
    .sort(
      query.sort === 'oldest'
        ? { _id: 1 }
        : query.sort === 'effective_asc'
          ? { effectiveDate: 1, _id: 1 }
          : query.sort === 'effective_desc'
            ? { effectiveDate: -1, _id: -1 }
            : { _id: -1 },
    )
    .skip(query.cursor ? 0 : (query.page - 1) * query.limit)
    .limit(query.limit + (query.cursor ? 1 : 0))
    .lean();
  const items = rows.slice(0, query.limit);
  const countFilter = { ...filter };
  delete countFilter._id;
  const total = await HRMSRecord.countDocuments(countFilter);
  res.json({
    success: true,
    message: 'HRMS records fetched successfully',
    data: {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
        nextCursor:
          rows.length > query.limit ? String(items.at(-1)._id) : null,
      },
    },
  });
}

export async function getRecord(req, res) {
  definitionFor(req.params.resource);
  const record = await HRMSRecord.findOne(
    scopeFilter(req, {
      _id: req.params.id,
      module: req.params.resource,
      deletedAt: null,
    }),
  ).populate('employee', 'name email role department active');
  if (!record) throw new AppError(404, 'HRMS record not found');
  res.json({ success: true, data: record });
}

async function enforceUniqueBusinessKeys(resource, parsed, excludeId) {
  let key;
  if (resource === 'settings') key = { 'data.key': parsed.data.key };
  if (resource === 'assets') key = { 'data.assetCode': parsed.data.assetCode };
  if (!key) return;
  const exists = await HRMSRecord.exists({
    module: resource,
    deletedAt: null,
    ...key,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });
  if (exists)
    throw new AppError(
      409,
      resource === 'settings'
        ? 'Setting key already exists'
        : 'Asset code already exists',
    );
}

export async function createRecord(req, res) {
  definitionFor(req.params.resource);
  const parsed = parseRecordCreate(req.params.resource, req.body);
  await enforceUniqueBusinessKeys(req.params.resource, parsed);
  const record = await HRMSRecord.create({
    module: req.params.resource,
    ...parsed,
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });
  await audit(req, `hrms.${req.params.resource}.created`, record);
  res.status(201).json({ success: true, data: record });
}

export async function updateRecord(req, res) {
  definitionFor(req.params.resource);
  const record = await HRMSRecord.findOne({
    _id: req.params.id,
    module: req.params.resource,
    deletedAt: null,
  });
  if (!record) throw new AppError(404, 'HRMS record not found');
  if (req.user.role === 'team_leader' && record.department !== req.user.department)
    throw new AppError(403, 'Department access denied');
  if (req.params.resource === 'timesheets' && record.status === 'Approved')
    throw new AppError(409, 'Approved timesheets are locked');
  if (req.params.resource === 'payroll-runs' && ['Approved', 'Paid'].includes(record.status))
    throw new AppError(409, 'Approved payroll runs are immutable');
  const parsed = parseRecordUpdate(
    req.params.resource,
    req.body,
    record.data || {},
  );
  await enforceUniqueBusinessKeys(
    req.params.resource,
    { data: parsed.data || record.data },
    record.id,
  );
  Object.assign(record, parsed, { updatedBy: req.user.id });
  await record.save();
  await audit(req, `hrms.${req.params.resource}.updated`, record);
  res.json({ success: true, data: record });
}

export async function updateRecordStatus(req, res) {
  const definition = definitionFor(req.params.resource);
  const { status, note } = req.body || {};
  if (typeof status !== 'string' || !status.trim() || status.length > 80)
    throw new AppError(400, 'Valid status is required');
  if (note !== undefined && (typeof note !== 'string' || note.length > 1000))
    throw new AppError(400, 'Review note is invalid');
  const record = await HRMSRecord.findOne({
    _id: req.params.id,
    module: req.params.resource,
    deletedAt: null,
  });
  if (!record) throw new AppError(404, 'HRMS record not found');
  if (
    req.user.role === 'team_leader' &&
    record.department !== req.user.department
  )
    throw new AppError(403, 'Department access denied');
  record.status = status.trim();
  record.updatedBy = req.user.id;
  if (note !== undefined)
    record.data = { ...(record.data || {}), reviewerNote: note.trim() };
  await record.save();
  await audit(req, `hrms.${req.params.resource}.status_updated`, record, {
    status: record.status,
    payroll: definition.payroll,
  });
  res.json({ success: true, data: record });
}

export async function deleteRecord(req, res) {
  definitionFor(req.params.resource);
  const existing = await HRMSRecord.findOne({
    _id: req.params.id,
    module: req.params.resource,
    deletedAt: null,
  });
  if (!existing) throw new AppError(404, 'HRMS record not found');
  if (req.user.role === 'team_leader' && existing.department !== req.user.department)
    throw new AppError(403, 'Department access denied');
  if (req.params.resource === 'departments') {
    const code = existing.data?.code;
    if (code && (await User.exists({ department: code, active: true })))
      throw new AppError(409, 'Only an empty department can be archived');
  }
  if (req.params.resource === 'designations' && (await EmployeeProfile.exists({ designation: existing.title })))
    throw new AppError(409, 'Designation is assigned to an employee');
  if (req.params.resource === 'holidays' && new Date(existing.data?.date) < new Date())
    throw new AppError(409, 'Past holidays cannot be removed');
  if (req.params.resource === 'shifts' && (await HRMSRecord.exists({ module: 'shift-assignments', deletedAt: null, 'data.shiftId': existing._id })))
    throw new AppError(409, 'Shift has active assignments');
  const record = await HRMSRecord.findOneAndUpdate(
    {
      _id: req.params.id,
      module: req.params.resource,
      deletedAt: null,
    },
    { deletedAt: new Date(), updatedBy: req.user.id },
    { new: true },
  );
  await audit(req, `hrms.${req.params.resource}.archived`, record);
  res.json({ success: true });
}

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

export async function dashboard(req, res) {
  const today = startOfDay();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const rangeStart = new Date(today);
  rangeStart.setDate(rangeStart.getDate() - 13);
  const rangeEnd = new Date(today);
  rangeEnd.setDate(rangeEnd.getDate() + 30);
  const employeeFilter = { role: { $nin: ['customer'] }, active: true };

  const [
    totalEmployees,
    attendanceToday,
    attendanceSeries,
    departmentEmployees,
    leaveStatus,
    activeLeaves,
    recentUsers,
    profiles,
    upcomingLeaveRecords,
    announcementRecords,
    approvalGroups,
    activities,
  ] = await Promise.all([
    User.countDocuments(employeeFilter),
    HRMSRecord.aggregate([
      { $match: { module: 'attendance', deletedAt: null, 'data.date': { $gte: today, $lt: tomorrow } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    HRMSRecord.aggregate([
      { $match: { module: 'attendance', deletedAt: null, 'data.date': { $gte: rangeStart, $lt: tomorrow } } },
      { $group: { _id: { date: { $dateTrunc: { date: '$data.date', unit: 'day' } }, status: '$status' }, count: { $sum: 1 } } },
      { $sort: { '_id.date': 1 } },
    ]),
    User.aggregate([
      { $match: employeeFilter },
      { $group: { _id: '$department', value: { $sum: 1 } } },
      { $sort: { value: -1 } },
    ]),
    HRMSRecord.aggregate([
      { $match: { module: 'leave', deletedAt: null } },
      { $group: { _id: '$status', value: { $sum: 1 } } },
    ]),
    HRMSRecord.countDocuments({ module: 'leave', deletedAt: null, status: 'Approved', 'data.startDate': { $lt: tomorrow }, 'data.endDate': { $gte: today } }),
    User.find(employeeFilter).select('name email role department active createdAt').sort({ createdAt: -1 }).limit(5).lean(),
    EmployeeProfile.find({ dateOfBirth: { $ne: null } }).populate('user', 'name active').lean(),
    HRMSRecord.find({ module: 'leave', deletedAt: null, status: { $in: ['Approved', 'Pending'] }, 'data.startDate': { $gte: today, $lte: rangeEnd } }).populate('employee', 'name role active').sort({ 'data.startDate': 1 }).limit(6).lean(),
    HRMSRecord.find({ module: 'announcements', deletedAt: null, status: { $in: ['Published', 'Scheduled'] } }).sort({ effectiveDate: -1, createdAt: -1 }).limit(5).lean(),
    HRMSRecord.aggregate([
      { $match: { module: { $in: ['leave', 'attendance', 'payroll'] }, deletedAt: null, status: { $in: ['Pending', 'Draft', 'Correction Requested'] } } },
      { $group: { _id: '$module', count: { $sum: 1 } } },
    ]),
    AuditLog.find({ action: /^hrms\./ }).populate('user', 'name').sort({ createdAt: -1 }).limit(8).lean(),
  ]);

  const attendanceCounts = Object.fromEntries(
    attendanceToday.map(({ _id, count }) => [_id.toLowerCase(), count]),
  );
  const seriesByDay = new Map();
  for (const item of attendanceSeries) {
    const key = item._id.date.toISOString().slice(0, 10);
    const row = seriesByDay.get(key) || {
      date: key,
      present: 0,
      absent: 0,
      leave: 0,
    };
    const status = item._id.status.toLowerCase();
    if (status === 'present' || status === 'late') row.present += item.count;
    else if (status === 'absent') row.absent += item.count;
    else row.leave += item.count;
    seriesByDay.set(key, row);
  }
  const departmentNames = Object.fromEntries(
    departments.map(({ id, name }) => [id, name]),
  );
  const birthdays = profiles
    .filter(({ user }) => user?.active)
    .map((profile) => {
      const next = new Date(
        today.getFullYear(),
        profile.dateOfBirth.getMonth(),
        profile.dateOfBirth.getDate(),
      );
      if (next < today) next.setFullYear(next.getFullYear() + 1);
      return {
        employee: profile.user,
        designation: profile.designation,
        date: next,
      };
    })
    .filter(({ date }) => date <= rangeEnd)
    .sort((a, b) => a.date - b.date)
    .slice(0, 5);

  res.json({
    success: true,
    data: {
      generatedAt: new Date(),
      kpis: {
        totalEmployees,
        presentToday: (attendanceCounts.present || 0) + (attendanceCounts.late || 0),
        absentToday: attendanceCounts.absent || 0,
        onLeave: activeLeaves,
      },
      attendanceAnalytics: [...seriesByDay.values()],
      departmentEmployees: departmentEmployees.map((item) => ({
        id: item._id || 'unassigned',
        name: departmentNames[item._id] || 'Unassigned',
        value: item.value,
      })),
      leaveStatus: leaveStatus.map((item) => ({
        name: item._id,
        value: item.value,
      })),
      recentEmployees: recentUsers,
      upcomingBirthdays: birthdays,
      upcomingLeaves: upcomingLeaveRecords,
      announcements: announcementRecords,
      pendingApprovals: approvalGroups.map((item) => ({
        module: item._id,
        count: item.count,
      })),
      recentActivities: activities,
    },
  });
}

export async function reports(req, res) {
  const [byModule, employeesByRole] = await Promise.all([
    HRMSRecord.aggregate([
      { $match: { deletedAt: null } },
      { $group: { _id: { module: '$module', status: '$status' }, count: { $sum: 1 } } },
      { $sort: { '_id.module': 1, '_id.status': 1 } },
    ]),
    User.aggregate([
      { $match: { active: true, role: { $ne: 'customer' } } },
      { $group: { _id: '$role', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);
  res.json({
    success: true,
    data: { byModule, employeesByRole, generatedAt: new Date() },
  });
}

const selfServiceResources = new Set(['attendance', 'leave', 'timesheets']);

export async function listSelfRecords(req, res) {
  if (!selfServiceResources.has(req.params.resource))
    throw new AppError(404, 'Self-service resource not found');
  const query = recordListSchema.parse({
    ...req.query,
    employee: String(req.user._id),
  });
  const filter = {
    module: req.params.resource,
    employee: req.user._id,
    deletedAt: null,
    ...(query.cursor ? { _id: { $lt: query.cursor } } : {}),
    ...(query.status ? { status: query.status } : {}),
  };
  const rows = await HRMSRecord.find(filter)
    .sort({ _id: -1 })
    .skip(query.cursor ? 0 : (query.page - 1) * query.limit)
    .limit(query.limit + (query.cursor ? 1 : 0))
    .lean();
  const items = rows.slice(0, query.limit);
  const total = await HRMSRecord.countDocuments({
    module: req.params.resource,
    employee: req.user._id,
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
  });
  res.json({
    success: true,
    message: 'Employee HRMS records fetched successfully',
    data: {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
        nextCursor:
          rows.length > query.limit ? String(items.at(-1)._id) : null,
      },
    },
  });
}

export async function createSelfRecord(req, res) {
  if (!new Set(['leave', 'timesheets']).has(req.params.resource))
    throw new AppError(404, 'Self-service resource not found');
  req.body = {
    ...req.body,
    employee: String(req.user._id),
    status: req.params.resource === 'leave' ? 'Pending' : 'Draft',
    department: req.user.department || undefined,
  };
  return createRecord(req, res);
}

export function validateResource(req, res, next) {
  definitionFor(req.params.resource);
  if (!mongoose.isValidObjectId(req.params.id) && req.params.id !== undefined)
    throw new AppError(400, 'Invalid identifier');
  next();
}
