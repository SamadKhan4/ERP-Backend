import { z } from 'zod';
import { Department } from '../models/Department.js';
import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { HRMSRecord } from '../models/HRMSRecord.js';
import { Project } from '../models/Project.js';
import { AuditLog } from '../models/AuditLog.js';
import { AppError } from '../utils/errors.js';
import { resolveDepartment } from '../services/departmentMasterService.js';
import {
  departmentListSchema,
  memberListSchema,
  assignmentSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
} from '../validators/departmentValidator.js';
import {
  saveDepartment,
  assignDepartmentEmployee,
  departmentSummary,
  departmentTransaction,
  assertEmptyDepartment,
  auditDepartment,
  employeeMembership,
  escapeSearch,
  hasDepartmentPermission,
} from '../services/departmentService.js';

export async function options(req, res) {
  const rows = await Department.find()
    .select('key name code status')
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  // Keep the existing dictionary contract for HRMS forms and older clients.
  res.json({
    success: true,
    data: rows.map((row) => ({
      id: row.key,
      _id: row._id,
      name: row.name,
      code: row.code,
      status: row.status,
    })),
  });
}
export async function list(req, res) {
  const query = departmentListSchema.parse(req.query);
  const filter = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          $or: ['name', 'code', 'departmentId'].map((field) => ({
            [field]: { $regex: escapeSearch(query.search), $options: 'i' },
          })),
        }
      : {}),
  };
  const [items, total, departmentTotals, people] = await Promise.all([
    Department.find(filter)
      .sort(
        query.sort === 'name'
          ? { name: 1, _id: 1 }
          : { createdAt: query.sort === 'oldest' ? 1 : -1, _id: 1 },
      )
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .populate('departmentHead', 'name')
      .lean(),
    Department.countDocuments(filter),
    Department.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'ACTIVE'] }, 1, 0] } },
        },
      },
    ]),
    User.aggregate([
      {
        $match: {
          role: { $ne: 'customer' },
        },
      },
      {
        $group: {
          _id: '$department',
          employees: { $sum: 1 },
          teamLeads: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$role', 'team_leader'] }, '$active'] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);
  const keys = items.map((row) => row.key);
  const projects = await Project.aggregate([
    { $match: { status: 'Active' } },
    {
      $lookup: {
        from: 'users',
        localField: 'assignedTo',
        foreignField: '_id',
        as: 'person',
      },
    },
    { $unwind: '$person' },
    { $match: { 'person.department': { $in: keys } } },
    { $group: { _id: '$person.department', count: { $sum: 1 } } },
  ]);
  res.json({
    success: true,
    data: {
      items: items.map((row) => ({
        ...row,
        employeeCount:
          people.find((person) => person._id === row.key)?.employees || 0,
        activeProjects:
          projects.find((project) => project._id === row.key)?.count || 0,
      })),
      pagination: {
        page: query.page,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
      summary: {
        total: departmentTotals[0]?.total || 0,
        active: departmentTotals[0]?.active || 0,
        employees: people.reduce((sum, row) => sum + row.employees, 0),
        teamLeads: people.reduce((sum, row) => sum + row.teamLeads, 0),
      },
    },
  });
}
export async function detail(req, res) {
  const department = await resolveDepartment(req.params.id);
  await department.populate([
    { path: 'departmentHead', select: 'name' },
    { path: 'reportingManager', select: 'name' },
    { path: 'parentDepartment', select: 'name code' },
  ]);
  res.json({ success: true, data: department });
}
export async function designations(req, res) {
  const department = await resolveDepartment(req.params.id);
  const items = await HRMSRecord.find({
    module: 'designations',
    department: department.key,
    deletedAt: null,
  })
    .select('title status')
    .sort({ title: 1 })
    .limit(100)
    .lean();
  res.json({ success: true, data: { items } });
}
export async function create(req, res) {
  const data = await saveDepartment(
    req,
    createDepartmentSchema.parse(req.body),
  );
  res.status(201).json({ success: true, message: 'Department created', data });
}
export async function update(req, res) {
  res.json({
    success: true,
    message: 'Department updated',
    data: await saveDepartment(
      req,
      updateDepartmentSchema.parse(req.body),
      req.params.id,
    ),
  });
}
export async function status(req, res) {
  const input = z
    .object({ status: z.enum(['ACTIVE', 'INACTIVE']) })
    .strict()
    .parse(req.body);
  res.json({
    success: true,
    data: await saveDepartment(req, input, req.params.id),
  });
}
export async function remove(req, res) {
  await departmentTransaction(async (session) => {
    const department = await resolveDepartment(req.params.id, { session });
    await assertEmptyDepartment(department, session);
    await Department.deleteOne({ _id: department._id }).session(session);
    await auditDepartment(
      req.user,
      department,
      'DEPARTMENT_DELETED',
      { code: department.code },
      session,
    );
  });
  res.json({ success: true, message: 'Empty department deleted' });
}
export async function summary(req, res) {
  res.json({
    success: true,
    data: await departmentSummary(await resolveDepartment(req.params.id)),
  });
}
export async function employees(req, res) {
  const department = await resolveDepartment(req.params.id);
  const query = memberListSchema.parse(req.query);
  const filter = {
    ...employeeMembership(department),
    ...(query.active ? { active: query.active === 'true' } : {}),
  };
  if (query.search)
    filter.$and = [
      {
        $or: ['name', 'email'].map((field) => ({
          [field]: { $regex: escapeSearch(query.search), $options: 'i' },
        })),
      },
    ];
  const [items, total] = await Promise.all([
    User.find(filter)
      .select('name email role department active createdAt')
      .sort({ name: 1, _id: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    User.countDocuments(filter),
  ]);
  const profiles = await EmployeeProfile.find({
    user: { $in: items.map((row) => row._id) },
  })
    .select('user employeeCode designation manager employmentType joiningDate')
    .populate('manager', 'name')
    .lean();
  res.json({
    success: true,
    data: {
      items: items.map((row) => ({
        ...row,
        profile:
          profiles.find(
            (profile) => String(profile.user) === String(row._id),
          ) || null,
      })),
      pagination: {
        page: query.page,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    },
  });
}
export async function assign(req, res) {
  const input = assignmentSchema.parse(req.body);
  res.json({
    success: true,
    message: 'Employee department updated',
    data: await assignDepartmentEmployee(req, req.params.id, input),
  });
}
export async function transfer(req, res) {
  const input = assignmentSchema.parse({
    ...req.body,
    employee: req.params.id,
  });
  if (!input.department) throw new AppError(400, 'Department required');
  res.json({
    success: true,
    message: 'Employee department updated',
    data: await assignDepartmentEmployee(req, input.department, input),
  });
}
export async function projects(req, res) {
  const department = await resolveDepartment(req.params.id);
  const query = memberListSchema.parse(req.query);
  const match = {
    $or: [
      { 'person.departmentId': department._id },
      { 'person.department': department.key },
    ],
    ...(query.search
      ? { title: { $regex: escapeSearch(query.search), $options: 'i' } }
      : {}),
  };
  const [result] = await Project.aggregate([
    {
      $lookup: {
        from: 'users',
        localField: 'assignedTo',
        foreignField: '_id',
        as: 'person',
      },
    },
    { $match: match },
    {
      $facet: {
        items: [
          { $sort: { createdAt: -1 } },
          { $skip: (query.page - 1) * query.limit },
          { $limit: query.limit },
          {
            $project: {
              title: 1,
              projectId: 1,
              status: 1,
              startDate: 1,
              nextBillingAt: 1,
              assignee: { $arrayElemAt: ['$person.name', 0] },
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);
  const total = result.total[0]?.count || 0;
  res.json({
    success: true,
    data: {
      items: result.items,
      pagination: {
        page: query.page,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
      basis:
        'Projects assigned to current department employees. No department-specific deadline exists; nextBillingAt is a billing date.',
    },
  });
}
export async function activity(req, res) {
  const department = await resolveDepartment(req.params.id);
  const query = memberListSchema.parse(req.query);
  const filter = { entityType: 'department', entityId: department._id };
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .select('action user details createdAt')
      .populate('user', 'name')
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: {
      items,
      pagination: {
        page: query.page,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    },
  });
}
export async function peopleOptions(req, res) {
  const { search } = z
    .object({ search: z.string().trim().max(100).default('') })
    .strict()
    .parse(req.query);
  const items = await User.find({
    active: true,
    role: { $ne: 'customer' },
    ...(search
      ? {
          $or: ['name', 'email'].map((field) => ({
            [field]: { $regex: escapeSearch(search), $options: 'i' },
          })),
        }
      : {}),
  })
    .select('name role department')
    .sort({ name: 1 })
    .limit(50)
    .lean();
  // Scoped lookup is available only to department editors, never employee self-service.
  res.json({ success: true, data: { items } });
}
export async function listEntry(req, res) {
  if (
    Object.keys(req.query).length ||
    req.headers['x-department-management'] === 'true'
  ) {
    if (!hasDepartmentPermission(req.departmentPermissions, 'departments.view'))
      throw new AppError(403, 'Department permission denied');
    return list(req, res);
  }
  return options(req, res);
}
