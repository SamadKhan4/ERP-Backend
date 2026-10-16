import mongoose from 'mongoose';
import { Department } from '../models/Department.js';
import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { HRMSRecord } from '../models/HRMSRecord.js';
import { AuditLog } from '../models/AuditLog.js';
import { Project } from '../models/Project.js';
import { PayrollEntry } from '../models/PayrollEntry.js';
import { TeamTask } from '../models/TeamWork.js';
import { permissionsFor } from './permissionService.js';
import { nextEmployeeCode } from './employeeCodeService.js';
import {
  departmentNumber,
  resolveDepartment,
  ensureDepartmentMasters,
} from './departmentMasterService.js';
import { AppError } from '../utils/errors.js';

export const hasDepartmentPermission = (permissions, value) =>
  permissions.includes('*') || permissions.includes(value);
export const employeeMembership = (department) => ({
  role: { $ne: 'customer' },
  $or: [{ departmentId: department._id }, { department: department.key }],
});
export const escapeSearch = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export async function departmentTransaction(work) {
  try {
    return await mongoose.connection.transaction(work);
  } catch (error) {
    if (error.code === 11000)
      throw new AppError(409, 'Department name or code already exists');
    if (
      error.code === 20 ||
      /Transaction numbers are only allowed/.test(error.message)
    )
      throw new AppError(
        503,
        'Department changes require MongoDB replica set support',
      );
    throw error;
  }
}
export async function departmentAccess(req, res, next) {
  req.departmentPermissions = await permissionsFor(req.user);
  await ensureDepartmentMasters();
  next();
}
export const requireDepartmentPermission = (permission) => (req, res, next) => {
  if (!hasDepartmentPermission(req.departmentPermissions, permission))
    throw new AppError(403, 'Department permission denied');
  next();
};
export async function auditDepartment(
  actor,
  department,
  action,
  metadata,
  session,
) {
  await AuditLog.create(
    [
      {
        user: actor._id,
        entityType: 'department',
        entityId: department._id,
        action,
        details: metadata,
      },
    ],
    { session },
  );
}
async function validateUser(id, session) {
  if (!id) return;
  if (
    !(await User.exists({
      _id: id,
      active: true,
      role: { $ne: 'customer' },
    }).session(session))
  )
    throw new AppError(
      400,
      'Choose an active employee for the department head or reporting manager',
    );
}
export async function saveDepartment(req, input, existingId) {
  return departmentTransaction(async (session) => {
    const existing = existingId
      ? await resolveDepartment(existingId, { session })
      : null;
    if (
      input.departmentHead !== undefined &&
      String(input.departmentHead || '') !==
        String(existing?.departmentHead || '') &&
      !hasDepartmentPermission(
        req.departmentPermissions,
        'departments.change_head',
      )
    )
      throw new AppError(403, 'Department head change permission required');
    await validateUser(input.departmentHead, session);
    await validateUser(input.reportingManager, session);
    if (input.parentDepartment) {
      const seen = new Set(existing ? [String(existing._id)] : []);
      let parent = input.parentDepartment;
      while (parent) {
        if (seen.has(String(parent)))
          throw new AppError(400, 'Parent department would create a cycle');
        seen.add(String(parent));
        const row = await Department.findById(parent).session(session);
        if (!row) throw new AppError(400, 'Parent department not found');
        await Department.updateOne(
          { _id: row._id },
          { $inc: { __v: 1 } },
        ).session(session);
        parent = row.parentDepartment;
      }
    }
    const previous = existing?.toObject();
    const department =
      existing ||
      new Department({
        key: new mongoose.Types.ObjectId().toString(),
        departmentId: await departmentNumber(session),
        createdBy: req.user._id,
      });
    Object.assign(department, input, { updatedBy: req.user._id });
    department.nameKey = department.name.toLowerCase().replace(/\s+/g, ' ');
    await department.save({ session });
    await auditDepartment(
      req.user,
      department,
      existing ? 'DEPARTMENT_UPDATED' : 'DEPARTMENT_CREATED',
      { changedFields: Object.keys(input) },
      session,
    );
    if (
      existing &&
      String(previous.departmentHead || '') !==
        String(department.departmentHead || '')
    )
      await auditDepartment(
        req.user,
        department,
        'DEPARTMENT_HEAD_CHANGED',
        {
          previous: previous.departmentHead || null,
          current: department.departmentHead || null,
        },
        session,
      );
    if (existing && previous.status !== department.status)
      await auditDepartment(
        req.user,
        department,
        'STATUS_CHANGED',
        { previous: previous.status, current: department.status },
        session,
      );
    return department;
  });
}
export async function assignDepartmentEmployee(req, departmentValue, input) {
  if (
    !hasDepartmentPermission(
      req.departmentPermissions || [],
      'departments.manage_members',
    )
  )
    throw new AppError(403, 'Department membership permission denied');
  return departmentTransaction(async (session) => {
    const department = await resolveDepartment(departmentValue, {
      active: true,
      session,
    });
    // Serialize membership changes against deactivation/deletion of this master.
    await Department.updateOne(
      { _id: department._id, status: 'ACTIVE' },
      { $inc: { __v: 1 } },
    ).session(session);
    const employee = await User.findById(input.employee).session(session);
    if (!employee || employee.role === 'customer')
      throw new AppError(404, 'Employee not found');
    const targets = {
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
    if (
      !(
        targets[req.user.role] || [
          'executive',
          'team_leader',
          'employee',
          'lead_caller',
        ]
      ).includes(employee.role)
    )
      throw new AppError(
        403,
        'You cannot transfer or change reporting for this account',
      );
    await validateUser(input.manager, session);
    if (input.manager && String(input.manager) === employee.id)
      throw new AppError(400, 'An employee cannot report to themselves');
    // Follow the reporting chain to prevent indirect management cycles.
    let manager = input.manager;
    const seen = new Set([employee.id]);
    while (manager) {
      if (seen.has(String(manager)))
        throw new AppError(400, 'Reporting manager would create a cycle');
      seen.add(String(manager));
      const next = await EmployeeProfile.findOne({ user: manager })
        .select('manager')
        .session(session)
        .lean();
      manager = next?.manager;
    }
    const previous = employee.department;
    const oldDepartment = previous
      ? await Department.findOne({ key: previous }).session(session)
      : null;
    const profile =
      (await EmployeeProfile.findOne({ user: employee._id }).session(
        session,
      )) ||
      new EmployeeProfile({
        user: employee._id,
        employeeCode: await nextEmployeeCode(),
      });
    const previousManager = profile.manager;
    employee.department = department.key;
    employee.departmentId = department._id;
    profile.department = department.key;
    profile.departmentId = department._id;
    profile.designation = input.designation;
    profile.manager = input.manager || undefined;
    if (input.location !== undefined) profile.workLocation = input.location;
    await employee.save({ session });
    await profile.save({ session });
    await auditDepartment(
      req.user,
      department,
      previous === department.key
        ? 'DEPARTMENT_UPDATED'
        : previous
          ? 'EMPLOYEE_TRANSFERRED'
          : 'EMPLOYEE_ADDED',
      {
        employee: employee._id,
        previousDepartment: previous || null,
        department: department.key,
        previousManager: previousManager || null,
        manager: profile.manager || null,
        designation: input.designation,
      },
      session,
    );
    if (oldDepartment && oldDepartment.key !== department.key)
      await auditDepartment(
        req.user,
        oldDepartment,
        'EMPLOYEE_REMOVED',
        { employee: employee._id, destination: department._id },
        session,
      );
    await HRMSRecord.create(
      [
        {
          module: 'onboarding',
          title: 'Department assignment / transfer',
          employee: employee._id,
          department: department.key,
          status: 'Completed',
          effectiveDate: input.effectiveDate || new Date(),
          data: {
            event: 'transfer',
            ...(input.location !== undefined ? { location: input.location } : {}),
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            previous: { department: previous },
            manager: profile.manager,
            designation: profile.designation,
            progress: 100,
            tasks: [],
          },
          createdBy: req.user._id,
        },
      ],
      { session },
    );
    return {
      employee: {
        _id: employee._id,
        name: employee.name,
        department: employee.department,
        departmentId: employee.departmentId,
      },
      profile: { _id: profile._id, employeeCode: profile.employeeCode, designation: profile.designation, department: profile.department, departmentId: profile.departmentId, manager: profile.manager, employmentType: profile.employmentType, joiningDate: profile.joiningDate },
    };
  });
}
export async function departmentSummary(department) {
  const today = new Date(
    `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())}T00:00:00+05:30`,
  );
  const tomorrow = new Date(today.getTime() + 86400000);
  const membership = employeeMembership(department);
  const staffLookup = [
    {
      $lookup: {
        from: 'users',
        localField: 'employee',
        foreignField: '_id',
        as: 'person',
      },
    },
    { $unwind: '$person' },
    {
      $match: {
        'person.active': true,
        'person.role': { $ne: 'customer' },
        $or: [
          { 'person.departmentId': department._id },
          { 'person.department': department.key },
        ],
      },
    },
  ];
  const [employees, active, presentRows, leaveRows, projectRows, taskRows] =
    await Promise.all([
      User.countDocuments(membership),
      User.countDocuments({ ...membership, active: true }),
      HRMSRecord.aggregate([
        {
          $match: {
            module: 'attendance',
            deletedAt: null,
            'data.date': { $gte: today, $lt: tomorrow },
            $or: [
              { 'data.checkIn': { $ne: null } },
              { status: { $in: ['Present', 'Late', 'WFH', 'Work From Home'] } },
            ],
          },
        },
        ...staffLookup,
        {
          $group: {
            _id: '$employee',
            late: {
              $max: {
                $cond: [
                  {
                    $or: [
                      { $eq: ['$status', 'Late'] },
                      { $eq: ['$data.attendanceStatus', 'Late'] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            wfh: {
              $max: {
                $cond: [{ $in: ['$status', ['WFH', 'Work From Home']] }, 1, 0],
              },
            },
          },
        },
      ]),
      HRMSRecord.aggregate([
        {
          $match: {
            module: 'leave',
            deletedAt: null,
            status: 'Approved',
            'data.startDate': { $lt: tomorrow },
            'data.endDate': { $gte: today },
          },
        },
        ...staffLookup,
        {
          $group: {
            _id: '$employee',
            wfh: {
              $max: {
                $cond: [{ $eq: ['$data.leaveType', 'work_from_home'] }, 1, 0],
              },
            },
          },
        },
      ]),
      Project.aggregate([
        {
          $lookup: {
            from: 'users',
            localField: 'assignedTo',
            foreignField: '_id',
            as: 'assignee',
          },
        },
        {
          $match: {
            $or: [
              { 'assignee.departmentId': department._id },
              { 'assignee.department': department.key },
            ],
          },
        },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      TeamTask.aggregate([
        { $match: { deletedAt: null } },
        {
          $lookup: {
            from: 'users',
            localField: 'assignedTo',
            foreignField: '_id',
            as: 'assignee',
          },
        },
        {
          $match: {
            $or: [
              { 'assignee.departmentId': department._id },
              { 'assignee.department': department.key },
            ],
          },
        },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);
  const leave = leaveRows.filter((row) => !row.wfh);
  const occupied = new Set([
    ...presentRows.map((row) => String(row._id)),
    ...leaveRows.map((row) => String(row._id)),
  ]);
  return {
    employees,
    activeEmployees: active,
    present: presentRows.length,
    onLeave: leave.length,
    absent: Math.max(0, active - occupied.size),
    late: presentRows.filter((row) => row.late).length,
    wfh: new Set(
      [
        ...presentRows.filter((row) => row.wfh),
        ...leaveRows.filter((row) => row.wfh),
      ].map((row) => String(row._id)),
    ).size,
    projects: Object.fromEntries(
      projectRows.map((row) => [row._id, row.count]),
    ),
    tasks: Object.fromEntries(taskRows.map((row) => [row._id, row.count])),
    date: today,
    basis:
      'Current department membership; historical HR records keep their original department. Absent means no attendance/approved leave recorded today. Projects/tasks are linked through assigned employees.',
  };
}
export async function assertEmptyDepartment(department, session) {
  const checks = [
    [User, { ...employeeMembership(department) }],
    [
      EmployeeProfile,
      {
        $or: [{ departmentId: department._id }, { department: department.key }],
      },
    ],
    [
      HRMSRecord,
      {
        $or: [
          { department: department.key },
          { 'data.previous.department': department.key },
          { 'data.employment.department': department.key },
        ],
      },
    ],
    [PayrollEntry, { department: department.key }],
    [Department, { parentDepartment: department._id }],
    [
      AuditLog,
      {
        entityType: 'department',
        'details.previousDepartment': department.key,
      },
    ],
  ];
  for (const [Model, filter] of checks)
    if (await Model.exists(filter).session(session))
      throw new AppError(
        409,
        'This department has current or historical dependencies. Deactivate it instead.',
      );
}
