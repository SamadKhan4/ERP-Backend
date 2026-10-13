import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { AuditLog } from '../models/AuditLog.js';
import {
  employeeCreateSchema,
  employeeListSchema,
  employeeUpdateSchema,
} from '../validators/hrmsValidator.js';
import { AppError } from '../utils/errors.js';
import { nextEmployeeCode } from '../services/employeeCodeService.js';
import {
  assertEmployeeTargetAccess,
  employeeRoleFilterFor,
} from '../services/employeeAccessService.js';

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ensureId(id) {
  if (!mongoose.isValidObjectId(id))
    throw new AppError(400, 'Invalid employee identifier');
}

function assertCanAssignRole(actorRole, targetRole) {
  const allowed = {
    super_admin: [
      'admin',
      'manager',
      'hr',
      'executive',
      'team_leader',
      'employee',
      'lead_caller',
    ],
    admin: [
      'manager',
      'hr',
      'executive',
      'team_leader',
      'employee',
      'lead_caller',
    ],
    hr: ['executive', 'team_leader', 'employee', 'lead_caller'],
  };
  if (!allowed[actorRole]?.includes(targetRole))
    throw new AppError(403, 'You cannot assign this role');
}

async function withProfiles(users, includeSensitive = false) {
  const profiles = await EmployeeProfile.find({
    user: { $in: users.map(({ _id }) => _id) },
  }).lean();
  const byUser = new Map(
    profiles.map((profile) => [String(profile.user), profile]),
  );
  return users.map((user) => {
    const profile = byUser.get(String(user._id)) || null;
    if (profile && !includeSensitive) {
      delete profile.address;
      delete profile.emergencyContact;
      delete profile.phone;
    }
    return { ...user, profile };
  });
}

export async function listEmployees(req, res) {
  const query = employeeListSchema.parse(req.query);
  const requestedDepartment =
    req.user.role === 'team_leader' ? req.user.department : query.department;
  if (req.user.role === 'team_leader' && !requestedDepartment)
    throw new AppError(403, 'Department required');
  const filter = {
    role: employeeRoleFilterFor(req.user.role),
    ...(query.cursor ? { _id: { $lt: query.cursor } } : {}),
    ...(requestedDepartment ? { department: requestedDepartment } : {}),
    ...(query.active ? { active: query.active === 'true' } : {}),
    ...(query.search
      ? {
          $or: [
            { name: { $regex: escapeRegExp(query.search), $options: 'i' } },
            { email: { $regex: escapeRegExp(query.search), $options: 'i' } },
          ],
        }
      : {}),
  };
  const rows = await User.find(filter)
    .select('_id name email role department active createdAt updatedAt')
    .sort(
      query.sort === 'oldest'
        ? { _id: 1 }
        : query.sort === 'name_asc'
          ? { name: 1, _id: 1 }
          : query.sort === 'name_desc'
            ? { name: -1, _id: -1 }
            : { _id: -1 },
    )
    .skip(query.cursor ? 0 : (query.page - 1) * query.limit)
    .limit(query.limit + (query.cursor ? 1 : 0))
    .lean();
  const page = rows.slice(0, query.limit);
  const countFilter = { ...filter };
  delete countFilter._id;
  const total = await User.countDocuments(countFilter);
  res.json({
    success: true,
    message: 'Employees fetched successfully',
    data: {
      items: await withProfiles(page, ['super_admin', 'admin', 'hr'].includes(req.user.role)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
        nextCursor:
          rows.length > query.limit ? String(page.at(-1)._id) : null,
      },
    },
  });
}

export async function getEmployee(req, res) {
  ensureId(req.params.id);
  const user = await User.findOne({
    _id: req.params.id,
    role: employeeRoleFilterFor(req.user.role),
    ...(req.user.role === 'team_leader'
      ? { department: req.user.department }
      : {}),
  })
    .select('_id name email role department active createdAt updatedAt')
    .lean();
  if (!user) throw new AppError(404, 'Employee not found');
  const [data] = await withProfiles([user], ['super_admin', 'admin', 'hr'].includes(req.user.role));
  res.json({ success: true, data });
}

export async function createEmployee(req, res) {
  const parsed = employeeCreateSchema.parse(req.body);
  assertCanAssignRole(req.user.role, parsed.role);
  const {
    temporaryPassword,
    employeeCode,
    designation,
    employmentType,
    joiningDate,
    dateOfBirth,
    phone,
    manager,
    address,
    emergencyContact,
    ...userFields
  } = parsed;
  const user = await User.create({
    ...userFields,
    passwordHash: await bcrypt.hash(temporaryPassword, 12),
  });
  try {
    const profile = await EmployeeProfile.create({
      user: user.id,
      employeeCode: employeeCode || (await nextEmployeeCode()),
      designation,
      department: parsed.department,
      employmentType,
      joiningDate,
      dateOfBirth,
      phone,
      manager,
      address,
      emergencyContact,
    });
    await AuditLog.create({
      user: req.user.id,
      action: 'hrms.employees.created',
      entityType: 'employees',
      entityId: user.id,
    });
    res.status(201).json({
      success: true,
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        active: user.active,
        profile,
      },
    });
  } catch (error) {
    await User.deleteOne({ _id: user.id });
    throw error;
  }
}

export async function updateEmployee(req, res) {
  ensureId(req.params.id);
  const parsed = employeeUpdateSchema.parse(req.body);
  const user = await User.findOne({
    _id: req.params.id,
    role: { $ne: 'customer' },
  });
  if (!user) throw new AppError(404, 'Employee not found');
  assertEmployeeTargetAccess(req.user.role, user.role);
  if (user.role === 'super_admin' && req.user.role !== 'super_admin')
    throw new AppError(403, 'Only a Super Admin can update this account');
  if (String(user._id) === String(req.user._id) && parsed.active === false)
    throw new AppError(400, 'You cannot deactivate your own account');
  const profileKeys = [
    'employeeCode',
    'designation',
    'employmentType',
    'joiningDate',
    'dateOfBirth',
    'phone',
    'manager',
    'address',
    'emergencyContact',
  ];
  const userUpdates = {};
  const profileUpdates = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (profileKeys.includes(key)) profileUpdates[key] = value;
    else userUpdates[key] = value;
  }
  const finalRole = userUpdates.role || user.role;
  const finalDepartment =
    userUpdates.department === undefined
      ? user.department
      : userUpdates.department;
  if (finalRole === 'team_leader' && !finalDepartment)
    throw new AppError(400, 'Team leaders require a department');
  if (userUpdates.role) assertCanAssignRole(req.user.role, userUpdates.role);
  if (
    user.role === 'super_admin' &&
    (finalRole !== 'super_admin' || userUpdates.active === false) &&
    (await User.countDocuments({ role: 'super_admin', active: true })) <= 1
  )
    throw new AppError(409, 'At least one active Super Admin is required');
  Object.assign(user, userUpdates);
  await user.save();
  const profile = await EmployeeProfile.findOneAndUpdate(
    { user: user.id },
    {
      $set: {
        ...profileUpdates,
        ...(userUpdates.department !== undefined
          ? { department: userUpdates.department }
          : {}),
      },
      $setOnInsert: {
        user: user.id,
        employeeCode:
          profileUpdates.employeeCode || `ADB-${String(user._id).slice(-6)}`,
      },
    },
    { new: true, upsert: true, runValidators: true },
  );
  await AuditLog.create({
    user: req.user.id,
    action: 'hrms.employees.updated',
    entityType: 'employees',
    entityId: user.id,
  });
  res.json({
    success: true,
    data: {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      department: user.department,
      active: user.active,
      profile,
    },
  });
}

export async function deactivateEmployee(req, res) {
  ensureId(req.params.id);
  if (String(req.params.id) === String(req.user._id))
    throw new AppError(400, 'You cannot deactivate your own account');
  const existing = await User.findOne({
    _id: req.params.id,
    role: { $ne: 'customer' },
  });
  if (!existing) throw new AppError(404, 'Employee not found');
  assertEmployeeTargetAccess(req.user.role, existing.role);
  if (existing.role === 'super_admin' && req.user.role !== 'super_admin')
    throw new AppError(403, 'Only a Super Admin can deactivate this account');
  if (
    existing.role === 'super_admin' &&
    (await User.countDocuments({ role: 'super_admin', active: true })) <= 1
  )
    throw new AppError(409, 'At least one active Super Admin is required');
  const user = await User.findOneAndUpdate(
    { _id: existing._id },
    { active: false, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  await Promise.all([
    Session.deleteMany({ user: user.id }),
    AuditLog.create({
      user: req.user.id,
      action: 'hrms.employees.deactivated',
      entityType: 'employees',
      entityId: user.id,
    }),
  ]);
  res.json({ success: true });
}

export async function getMyEmployeeProfile(req, res) {
  const user = await User.findById(req.user.id)
    .select('_id name email role department active createdAt updatedAt')
    .lean();
  const [data] = await withProfiles([user], true);
  res.json({ success: true, data });
}
